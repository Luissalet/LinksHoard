// Sentidos: the part of Links Hoard that listens. A Python worker (the sentidos/ package: CLAP + AST on the CPU, a calibrated vocabulary
// of sounds) keeps its models in memory; this module starts it when something needs it, sends it calls over loopback HTTP and stops it
// when it has been idle for a while. Nothing here imports the rest of the app: sources (files, links, URLs) are resolved in
// sentidos-tools.js.
//
//   status()            what is installed, whether the worker runs, what the models are
//   setup()             a background job: own venv + packages + the two models (about 1.1 GB, once)
//   start() / stop()    the worker, by hand (the first call starts it anyway)
//   callTool(tool, args)  one worker tool: { ok, tool, summary, text, data } or { ok: false, error }
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDir, getSetting, setSetting, isOpen } from "./db.js";
import { runProcess, runCapture } from "./hoard-commons/media.js";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOOL_NAMES = ["measure", "describe", "match", "find", "rank", "timeline", "realness", "sheet"];

const DEFAULTS = { idle_min: 20, warm: true };

export function sentidosSettings() {
  const stored = isOpen() ? getSetting("sentidos", {}) : {};
  const out = { ...DEFAULTS, ...stored };
  if (process.env.LINKS_SENTIDOS_IDLE_MIN !== undefined) out.idle_min = Number(process.env.LINKS_SENTIDOS_IDLE_MIN) || 0;
  return out;
}

export function setSentidosSettings(input = {}) {
  const next = { ...getSetting("sentidos", {}) };
  if (input.idle_min !== undefined) {
    const v = Number(input.idle_min);
    if (!Number.isFinite(v) || v < 0 || v > 1440) throw Object.assign(new Error("idle_min debe estar entre 0 y 1440 minutos."), { status: 400 });
    next.idle_min = Math.round(v);
  }
  for (const k of ["warm"]) if (input[k] !== undefined) next[k] = Boolean(input[k]);
  setSetting("sentidos", next);
  restartIdleTimer();
  return sentidosSettings();
}

// ---------------------------------------------------------------------------
// where things live
// ---------------------------------------------------------------------------

export const venvDir = () => process.env.LINKS_SENTIDOS_VENV || path.join(ROOT, ".venv-sentidos");
export const venvPython = () => path.join(venvDir(), process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
export const sentidosHome = () => process.env.LINKS_SENTIDOS_HOME || path.join(dataDir() || path.join(ROOT, "data"), "sentidos");
const readyFile = () => path.join(sentidosHome(), "ready.json");
const requirements = () => path.join(ROOT, "sentidos", "requirements.txt");

export const isInstalled = () => fs.existsSync(venvPython());

function readReady() {
  try { return JSON.parse(fs.readFileSync(readyFile(), "utf8")); } catch { return null; }
}

const fail = (message, status = 409, code = "sentidos") => Object.assign(new Error(message), { status, code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the worker process
// ---------------------------------------------------------------------------

let worker = null; // { child, port, pid, started_at, last_use, calls }
let starting = null;
let idleTimer = null;
let stderrTail = [];

const workerAlive = () => Boolean(worker && worker.child.exitCode === null && !worker.child.killed);

async function http(method, route, body, { timeoutMs = 30_000 } = {}) {
  if (!worker) throw fail("El motor de sonido no está en marcha.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}${route}`, {
      method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
    });
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** Start the worker (once; concurrent callers share the start). Resolves when it answers /health. */
export function start({ warm = null } = {}) {
  if (workerAlive()) return Promise.resolve(summary());
  if (starting) return starting;
  starting = (async () => {
    const py = venvPython();
    if (!fs.existsSync(py)) throw fail("Sentidos no está instalado: pulsa «Preparar Sentidos» (o usa audio_status con setup).", 424, "not_installed");
    fs.mkdirSync(sentidosHome(), { recursive: true });
    stderrTail = [];
    const wantWarm = warm === null ? sentidosSettings().warm : warm;
    const child = spawn(py, ["-m", "sentidos.worker", "--parent-pid", String(process.pid), ...(wantWarm ? ["--warm"] : [])], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SENTIDOS_HOME: sentidosHome() },
    });
    child.stderr.on("data", (b) => { stderrTail = [...stderrTail, ...String(b).split(/\r?\n/).filter(Boolean)].slice(-30); });
    const info = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => { reject(fail(`El motor de sonido no arrancó a tiempo. ${stderrTail.slice(-3).join(" ")}`, 504, "start_timeout")); child.kill(); }, 90_000);
      child.stdout.on("data", (b) => {
        buf += String(b);
        const line = buf.split(/\r?\n/).find((l) => l.startsWith("{"));
        if (!line) return;
        try { const j = JSON.parse(line).sentidos_worker; clearTimeout(timer); resolve(j); } catch { /* wait for the whole line */ }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(fail(`No se pudo lanzar Python: ${e.message}`, 500, "spawn")); });
      child.on("exit", (code) => { clearTimeout(timer); reject(fail(`El motor de sonido se cerró al arrancar (código ${code}). ${stderrTail.slice(-3).join(" ")}`, 500, "start_failed")); });
    });
    child.stdout.on("data", () => {}); // keep draining
    worker = { child, port: info.port, pid: info.pid, started_at: Date.now(), last_use: Date.now(), calls: 0, version: info.version };
    child.on("exit", () => { if (worker?.child === child) worker = null; });
    restartIdleTimer();
    return summary();
  })().finally(() => { starting = null; });
  return starting;
}

/** Ask the worker to stop and wait for it; kills only the process this module started. */
export async function stop() {
  if (!worker) return { running: false };
  const { child } = worker;
  try { await http("POST", "/shutdown", {}, { timeoutMs: 3000 }); } catch { /* it may already be going */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 4000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  worker = null;
  clearInterval(idleTimer);
  idleTimer = null;
  return { running: false };
}

export const shutdownSentidos = () => stop();

function restartIdleTimer() {
  clearInterval(idleTimer);
  idleTimer = null;
  const min = sentidosSettings().idle_min;
  if (!workerAlive() || !min) return;
  idleTimer = setInterval(() => {
    if (!workerAlive()) return;
    if (busyCalls > 0 || setupJob.running) { worker.last_use = Date.now(); return; }
    if (Date.now() - worker.last_use >= min * 60_000) stop().catch(() => {});
  }, 30_000);
  idleTimer.unref?.();
}

const summary = () => (worker ? { running: true, pid: worker.pid, port: worker.port, version: worker.version, started_at: new Date(worker.started_at).toISOString(), calls: worker.calls } : { running: false });

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

let busyCalls = 0;
let testRunner = null;
/** Tests replace the worker with one function: (tool, args) => result. */
export function setSentidosRunner(fn) { const old = testRunner; testRunner = fn || null; return old; }
export const hasRunner = () => Boolean(testRunner);

export async function callTool(tool, args = {}, { timeoutMs = 20 * 60_000 } = {}) {
  if (testRunner) return testRunner(tool, args);
  if (!TOOL_NAMES.includes(tool)) throw fail(`Herramienta de sonido desconocida «${tool}». Usa: ${TOOL_NAMES.join(", ")}.`, 400, "bad_tool");
  await start();
  busyCalls++;
  try {
    worker.last_use = Date.now();
    const out = await http("POST", "/call", { tool, args }, { timeoutMs });
    worker.calls++;
    return out;
  } catch (e) {
    if (e.status) throw e;
    throw fail(e.name === "AbortError" ? "El análisis de sonido tardó demasiado." : `El motor de sonido no respondió: ${e.message}`, 504, "worker");
  } finally {
    busyCalls--;
    if (worker) worker.last_use = Date.now();
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function status() {
  const out = {
    installed: isInstalled(), venv: venvDir(), home: sentidosHome(), worker: summary(), settings: sentidosSettings(), setup: setupView(),
    ready: false, models: null, tools: TOOL_NAMES,
  };
  const marker = readReady();
  if (marker) out.prepared_at = marker.at;
  if (testRunner) { out.ready = true; return out; }
  if (workerAlive()) {
    try {
      const st = await http("GET", "/status", null, { timeoutMs: 5000 });
      out.models = st.models; out.loaded = st.loaded; out.busy = st.busy; out.fetch = st.fetch; out.threads = st.threads; out.precision = st.precision; out.last_error = st.last_error;
      out.ready = Boolean(st.models?.ready);
    } catch { /* the worker is busy or going down */ }
  } else {
    out.ready = Boolean(marker?.models);
  }
  return out;
}

// ---------------------------------------------------------------------------
// setup: venv, packages, models
// ---------------------------------------------------------------------------

const setupJob = { running: false, step: "", log: [], error: "", started_at: null, finished_at: null, ok: null };
const logLine = (line) => { setupJob.log = [...setupJob.log, String(line).slice(0, 300)].slice(-200); };
const setupView = () => ({ running: setupJob.running, step: setupJob.step, ok: setupJob.ok, error: setupJob.error || undefined, started_at: setupJob.started_at, finished_at: setupJob.finished_at, log: setupJob.log.slice(-40) });

async function findBasePython() {
  const candidates = [process.env.LINKS_SENTIDOS_BASE_PYTHON, "python", "python3", "py"].filter(Boolean);
  for (const cmd of candidates) {
    const r = await runCapture({ cmd, args: [] }, ["-c", "import sys;print(sys.version_info[0], sys.version_info[1])"], { timeoutMs: 20_000, lowPriority: false });
    const m = r.code === 0 && /^(\d+) (\d+)/.exec(String(r.stdout).trim());
    if (m && Number(m[1]) === 3 && Number(m[2]) >= 10 && Number(m[2]) <= 13) return cmd;
  }
  return null;
}

async function pip(args) {
  const r = await runProcess({ cmd: venvPython(), args: [] }, ["-m", "pip", ...args], {
    timeoutMs: 60 * 60_000, lowPriority: false, onStdoutLine: (l) => { if (/^(Collecting|Downloading|Installing|Successfully)/.test(l)) logLine(l); }, onStderrLine: (l) => { if (l.trim()) logLine(l); },
  });
  if (r.code !== 0) throw new Error(`pip falló (código ${r.code}).`);
}

/** Build the venv, install the packages and download the models, in the background. Safe to call again: it only does what is missing. */
export function setup() {
  if (setupJob.running) return setupView();
  Object.assign(setupJob, { running: true, step: "venv", log: [], error: "", ok: null, started_at: new Date().toISOString(), finished_at: null });
  (async () => {
    try {
      let haveDeps = false;
      if (isInstalled()) {
        const r = await runCapture({ cmd: venvPython(), args: [] }, ["-c", "import torch, transformers, librosa, soundfile, faster_whisper"], { timeoutMs: 120_000, lowPriority: false });
        haveDeps = r.code === 0;
      }
      if (!haveDeps) {
        if (!isInstalled()) {
          logLine("Buscando un Python 3.10–3.13…");
          const base = await findBasePython();
          if (!base) throw new Error("No hay un Python 3.10 a 3.13 en el equipo. Instálalo o indica LINKS_SENTIDOS_BASE_PYTHON.");
          logLine(`Creando el entorno propio en ${venvDir()}…`);
          const r = await runProcess({ cmd: base, args: [] }, ["-m", "venv", venvDir()], { timeoutMs: 5 * 60_000, lowPriority: false, onStderrLine: logLine });
          if (r.code !== 0) throw new Error("No se pudo crear el entorno de Python.");
        }
        setupJob.step = "packages";
        logLine("Instalando los paquetes (varios cientos de MB la primera vez)…");
        await pip(["install", "--upgrade", "pip"]);
        await pip(["install", "--extra-index-url", "https://download.pytorch.org/whl/cpu", "-r", requirements()]);
      }
      setupJob.step = "models";
      logLine("Descargando los modelos de sonido (unos 1,1 GB la primera vez)…");
      await start({ warm: false });
      await http("POST", "/fetch", {});
      for (;;) {
        await sleep(2000);
        const st = await http("GET", "/status", null, { timeoutMs: 10_000 });
        const f = st.fetch || {};
        if (f.log?.length) setupJob.log = [...setupJob.log.filter((l) => !l.startsWith("· ")), ...f.log.map((l) => `· ${l}`)].slice(-200);
        if (f.error) throw new Error(f.error);
        if (!f.running && (f.done || st.models?.ready)) break;
      }
      fs.mkdirSync(sentidosHome(), { recursive: true });
      fs.writeFileSync(readyFile(), JSON.stringify({ at: new Date().toISOString(), models: true, version: worker?.version || null }, null, 1));
      Object.assign(setupJob, { ok: true, step: "", finished_at: new Date().toISOString() });
      logLine("Sentidos está listo.");
    } catch (e) {
      Object.assign(setupJob, { ok: false, error: String(e.message || e).slice(0, 400), finished_at: new Date().toISOString() });
      logLine(`Error: ${setupJob.error}`);
    } finally {
      setupJob.running = false;
    }
  })();
  return setupView();
}
