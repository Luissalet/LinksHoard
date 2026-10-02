// External programs for media downloads: finding them (yt-dlp, gallery-dl,
// ffmpeg), reporting what was found, running them and updating them.
//
// Resolution order, each tool overridable by an environment variable:
//   yt-dlp      LINKS_YTDLP     | `yt-dlp` on PATH | ../Writers hoard desktop/resources/bin | python -m yt_dlp
//   gallery-dl  LINKS_GALLERYDL | `gallery-dl` on PATH | the same sibling folder | python -m gallery_dl
//   ffmpeg      LINKS_FFMPEG    | `ffmpeg` on PATH | the same sibling folder | imageio-ffmpeg (through Python)
//
// An override (and PYTHON, for the interpreter) may be a plain path, or a
// command that runs through Node: "node:C:\\tmp\\fake-yt-dlp.js" or any path
// ending in .js/.mjs/.cjs. That is how the tests fake the programs on every
// OS without needing a .cmd wrapper on Windows. "python -m yt_dlp" works too.
// Windows .cmd/.bat shims on PATH are ignored (Node cannot spawn them safely);
// only .exe/.com are considered there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const isWin = () => process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");
export const SIBLING_NAME = "Writers hoard desktop";
export const INSTALL_COMMAND = "python -m pip install -U yt-dlp gallery-dl";

export class MediaError extends Error {
  constructor(message, { code = "MEDIA", status = 400, hint = "", detail = "" } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.detail = detail;
  }
}

export const cancelledError = () => new MediaError("Descarga cancelada.", { code: "CANCELLED", status: 409 });

// ---------------------------------------------------------------------------
// command specs
// ---------------------------------------------------------------------------

/** "node:/x/fake.js" | "/x/fake.js" | "/usr/bin/yt-dlp" | "python -m yt_dlp" → { cmd, args }. */
export function parseCommandSpec(spec) {
  let text = String(spec || "").trim();
  if (!text) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text) return null;
  if (/^node:/i.test(text)) return { cmd: process.execPath, args: [text.slice(5)] };
  if (/\.(?:m?js|cjs)$/i.test(text)) return { cmd: process.execPath, args: [text] };
  const mod = text.match(/^(\S+)\s+-m\s+([\w.]+)$/);
  if (mod) return { cmd: mod[1], args: ["-m", mod[2]] };
  return { cmd: text, args: [] };
}

/** Looks for an executable called `name` in the PATH directories. */
export function which(name, { pathDirs, platform = process.platform } = {}) {
  const dirs = pathDirs || String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// running processes
// ---------------------------------------------------------------------------

const baseEnv = (extra) => ({ ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(extra || {}) });

/** Kill a process and everything it started (yt-dlp spawns ffmpeg). */
export function killTree(pid) {
  if (!pid) return;
  if (isWin()) {
    try {
      const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.on("error", () => {});
    } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function lineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\n|\r/);
      buffer = parts.pop();
      for (const line of parts) if (line) onLine(line);
    },
    end() { if (buffer) onLine(buffer); buffer = ""; },
  };
}

/**
 * Run a command to completion. Resolves { code, stdout, stderr } (output tails
 * only, 64 KB each) — it never rejects on a non-zero exit. Rejects with
 * MediaError(BINARY_MISSING) when the program cannot be started and with
 * MediaError(CANCELLED) when `signal` aborts (the whole process tree is killed
 * first and awaited, so the next job never starts while the old one lingers).
 */
export function runProcess(command, args = [], { signal, onStdoutLine, onStderrLine, env, cwd, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    let child;
    try {
      child = spawn(command.cmd, [...(command.args || []), ...args], {
        windowsHide: true,
        detached: !isWin(),
        stdio: ["ignore", "pipe", "pipe"],
        env: baseEnv(env),
        cwd,
      });
    } catch (error) {
      return reject(new MediaError(`No se pudo ejecutar ${command.cmd}: ${error.message}`, { code: "BINARY_MISSING" }));
    }
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const tail = (text, chunk) => (text + chunk).slice(-65536);
    const out = lineSplitter((l) => onStdoutLine?.(l));
    const err = lineSplitter((l) => onStderrLine?.(l));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout = tail(stdout, d); out.push(d); });
    child.stderr.on("data", (d) => { stderr = tail(stderr, d); err.push(d); });

    let timer = null;
    let aborted = false;
    let force = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
      // If the process tree refuses to die, do not hold the queue forever.
      force = setTimeout(() => finish(() => reject(cancelledError())), 10_000);
      force.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(() => { killTree(child.pid); }, timeoutMs);
      timer.unref?.();
    }
    child.on("error", (error) => finish(() => reject(error.code === "ENOENT"
      ? new MediaError(`No se encontró el programa «${command.cmd}».`, { code: "BINARY_MISSING" })
      : new MediaError(`No se pudo ejecutar ${command.cmd}: ${error.message}`, { code: "BINARY_MISSING" }))));
    child.on("close", (code) => {
      out.end(); err.end();
      finish(() => (aborted || signal?.aborted ? reject(cancelledError()) : resolve({ code, stdout, stderr })));
    });
  });
}

/** Like runProcess but never rejects: failures come back as { code: null, error }. */
export async function runCapture(command, args, options = {}) {
  try {
    return await runProcess(command, args, { timeoutMs: 20_000, ...options });
  } catch (error) {
    return { code: null, stdout: "", stderr: "", error };
  }
}

// ---------------------------------------------------------------------------
// finding the tools
// ---------------------------------------------------------------------------

const DEFS = {
  ytdlp: { label: "yt-dlp", env: "LINKS_YTDLP", bin: "yt-dlp", module: "yt_dlp", pip: "yt-dlp", versionArgs: ["--version"] },
  gallerydl: { label: "gallery-dl", env: "LINKS_GALLERYDL", bin: "gallery-dl", module: "gallery_dl", pip: "gallery-dl", versionArgs: ["--version"] },
  ffmpeg: { label: "ffmpeg", env: "LINKS_FFMPEG", bin: "ffmpeg", versionArgs: ["-version"] },
};
export const TOOL_NAMES = Object.keys(DEFS);

const firstLine = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";

function parseVersion(tool, stdout) {
  const line = firstLine(stdout);
  if (tool === "ffmpeg") return (line.match(/ffmpeg version (\S+)/i) || [])[1] || line;
  return line;
}

export function installHint(tool, platform = process.platform) {
  if (tool === "ffmpeg") {
    const how = platform === "win32" ? "winget install Gyan.FFmpeg" : platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg";
    return `Instala ffmpeg (${how}) o indica su ruta en LINKS_FFMPEG.`;
  }
  const name = DEFS[tool]?.label || tool;
  return `Instala ${name} con: ${INSTALL_COMMAND} (o indica su ruta en ${DEFS[tool]?.env}).`;
}

function pythonSpecs(env) {
  const specs = [];
  if (env.PYTHON && env.PYTHON.trim()) specs.push({ spec: env.PYTHON, how: "env" });
  if (process.platform === "win32") specs.push({ spec: "python", how: "path" }, { spec: "py -3", how: "path" });
  else specs.push({ spec: "python3", how: "path" }, { spec: "python", how: "path" });
  return specs;
}

function pythonCommand(spec) {
  if (spec === "py -3") return { cmd: "py", args: ["-3"] };
  return parseCommandSpec(spec);
}

const cache = new Map();
const TTL_FOUND = 30_000;
const TTL_MISSING = 4_000;
const envKey = (env) => JSON.stringify([env.LINKS_YTDLP, env.LINKS_GALLERYDL, env.LINKS_FFMPEG, env.PYTHON, env.PATH, env.Path, env.LINKS_MEDIA_SIBLING_DIR]);

export function resetToolsCache() { cache.clear(); }

/** The Python interpreter, or null. */
export async function resolvePython(env = process.env) {
  const key = `python:${envKey(env)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? TTL_FOUND : TTL_MISSING)) return hit.value;
  let value = null;
  for (const { spec, how } of pythonSpecs(env)) {
    const command = pythonCommand(spec);
    if (!command) continue;
    const r = await runCapture(command, ["--version"], { timeoutMs: 15_000, env });
    if (r.code === 0) {
      value = { command, path: spec, version: firstLine(r.stdout || r.stderr).replace(/^Python\s+/i, ""), how };
      break;
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function candidatesFor(tool, env, siblingDir) {
  const def = DEFS[tool];
  const list = [];
  if (env[def.env] && env[def.env].trim()) {
    const command = parseCommandSpec(env[def.env]);
    if (command) list.push({ how: "env", command, display: env[def.env].trim() });
  }
  const onPath = which(def.bin, { pathDirs: String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean) });
  if (onPath) list.push({ how: "path", command: { cmd: onPath, args: [] }, display: onPath });
  const exe = def.bin + (isWin() ? ".exe" : "");
  const sibling = siblingDir ? path.join(siblingDir, exe) : null;
  try { if (sibling && fs.statSync(sibling).isFile()) list.push({ how: "sibling", command: { cmd: sibling, args: [] }, display: sibling }); } catch { /* absent */ }
  return list;
}

/**
 * Find one tool. Returns { tool, found, how, path, version, command, tried, error, hint }.
 * `refresh` skips the short-lived cache.
 */
/** The sibling app's binaries folder; LINKS_MEDIA_SIBLING_DIR overrides it ("0" or "off" turns the lookup off). */
export function defaultSiblingDir(env = process.env) {
  const override = env.LINKS_MEDIA_SIBLING_DIR;
  if (override !== undefined && override !== "") {
    if (/^(0|off|no|false)$/i.test(override.trim())) return null;
    return path.resolve(override);
  }
  return path.resolve(ROOT, "..", SIBLING_NAME, "resources", "bin");
}

export async function resolveTool(tool, { env = process.env, siblingDir = defaultSiblingDir(env), refresh = false } = {}) {
  const def = DEFS[tool];
  if (!def) throw new Error(`Herramienta desconocida: ${tool}`);
  const key = `${tool}:${envKey(env)}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < (hit.value.found ? TTL_FOUND : TTL_MISSING)) return hit.value;

  const tried = [];
  let value = null;
  const attempt = async (c) => {
    const r = await runCapture(c.command, def.versionArgs, { timeoutMs: 20_000, env });
    if (r.code === 0 && !r.error) {
      return { tool, found: true, how: c.how, path: c.display, version: parseVersion(tool, r.stdout || r.stderr), command: c.command, tried };
    }
    tried.push({ how: c.how, path: c.display, error: r.error ? r.error.message : (firstLine(r.stderr) || `salió con código ${r.code}`) });
    return null;
  };
  for (const c of await candidatesFor(tool, env, siblingDir)) {
    value = await attempt(c);
    if (value) break;
  }
  if (!value && def.module) {
    const python = await resolvePython(env);
    if (python) {
      const command = { cmd: python.command.cmd, args: [...python.command.args, "-m", def.module] };
      value = await attempt({ how: "python-module", command, display: `${python.path} -m ${def.module}` });
    }
  }
  if (!value && tool === "ffmpeg") {
    const python = await resolvePython(env);
    if (python) {
      const r = await runCapture(python.command, ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], { timeoutMs: 20_000, env });
      const exe = firstLine(r.stdout);
      if (r.code === 0 && exe) value = await attempt({ how: "imageio", command: { cmd: exe, args: [] }, display: exe });
    }
  }
  if (!value) value = { tool, found: false, how: null, path: null, version: null, command: null, tried, error: installHint(tool) };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const publicTool = (t) => ({
  found: t.found,
  path: t.path,
  version: t.version,
  how: t.how,
  ...(t.found ? {} : { hint: t.error }),
  ...(t.tried?.length ? { tried: t.tried } : {}),
});

/** What was found, for GET /api/media/tools and media_tools. */
export async function toolsStatus(options = {}) {
  const [ytdlp, gallerydl, ffmpeg, python] = await Promise.all([
    resolveTool("ytdlp", options), resolveTool("gallerydl", options), resolveTool("ffmpeg", options), resolvePython(options.env || process.env),
  ]);
  return {
    ytdlp: publicTool(ytdlp),
    gallerydl: publicTool(gallerydl),
    ffmpeg: publicTool(ffmpeg),
    python: python ? { found: true, path: python.path, version: python.version } : { found: false },
    install_command: INSTALL_COMMAND,
    platform: process.platform,
  };
}

// ---------------------------------------------------------------------------
// updating
// ---------------------------------------------------------------------------

const tailOf = (text, lines = 6) => String(text || "").trim().split(/\r?\n/).slice(-lines).join("\n").slice(-600);

async function pipInstall(python, pkg) {
  const r = await runCapture(python.command, ["-m", "pip", "install", "-U", "--disable-pip-version-check", pkg], { timeoutMs: 300_000 });
  return { ok: r.code === 0, output: tailOf(r.stdout + "\n" + r.stderr) || (r.error ? r.error.message : "") };
}

/**
 * Update yt-dlp and gallery-dl: `-U` for a standalone binary, `python -m pip
 * install -U` when it runs as a module (or is missing and Python exists).
 * Returns one entry per tool with the versions before and after.
 */
export async function updateTools({ tools = ["ytdlp", "gallerydl"], env = process.env, siblingDir } = {}) {
  const results = [];
  const options = { env, ...(siblingDir ? { siblingDir } : {}), refresh: true };
  for (const tool of tools) {
    const def = DEFS[tool];
    if (!def || !def.pip) { results.push({ tool, ok: false, error: `${tool} no se actualiza desde aquí.` }); continue; }
    const before = await resolveTool(tool, options);
    const python = await resolvePython(env);
    let method = "";
    let output = "";
    let ok = false;
    if (before.found && before.how !== "python-module") {
      method = "self-update (-U)";
      const r = await runCapture(before.command, ["-U"], { timeoutMs: 180_000 });
      output = tailOf(r.stdout + "\n" + r.stderr) || (r.error ? r.error.message : "");
      ok = r.code === 0 && !r.error;
      if (!ok && python && /pip|package manager|installed (?:by|via|from|with)/i.test(output)) {
        method = `${python.path} -m pip install -U ${def.pip}`;
        ({ ok, output } = await pipInstall(python, def.pip));
      }
    } else if (python) {
      method = `${python.path} -m pip install -U ${def.pip}`;
      ({ ok, output } = await pipInstall(python, def.pip));
    } else {
      results.push({ tool, ok: false, before: before.version, after: before.version, updated: false, error: `No hay Python para instalar ${def.label}. ${installHint(tool)}` });
      continue;
    }
    resetToolsCache();
    const after = await resolveTool(tool, options);
    results.push({
      tool, ok, method, before: before.version, after: after.version,
      updated: !!after.version && after.version !== before.version,
      output,
      ...(ok ? {} : { error: `No se pudo actualizar ${def.label}. ${output}`.trim() }),
    });
  }
  return { results };
}
