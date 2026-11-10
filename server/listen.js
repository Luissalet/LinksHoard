// Escuchar: a saved link read aloud. The clean text of the article goes to Prospero's Hoard (voice_audiobook,
// through the hub), which narrates long texts sentence by sentence as a background job; the finished MP3 and its
// sentence timings are copied into this app's data folder, so the audio plays with Prospero stopped, and the place
// where the listener stopped is remembered. «Escuchar después» is an ordered queue that chains several links.
// A video link that has a digest is narrated from the digest's summary instead of from a page text.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, now, dataDir, getSetting, setSetting, isOpen } from "./db.js";
import * as links from "./links.js";
import * as family from "./hoard-link.js";
import { digestNarration } from "./videodigest.js";

export const STUDIO = "prospero";
export const ACTIVE = ["queued", "running"];
export const MIN_CHARS = 80;
export const MAX_CHARS = 1_500_000;
export const DEFAULT_VOICES = { es: "es_ES-davefx-medium", en: "en_US-lessac-medium" };
const POLL_WAIT_S = 20;
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };

// ---------------------------------------------------------------------------
// the text that is read
// ---------------------------------------------------------------------------

/** Text for a voice: no addresses, no markup, no reference marks; paragraphs kept. */
export function cleanForSpeech(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\[(?:\d{1,3}|nota \d+|cita requerida|citation needed)\]/gi, "")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>+|[-*+•·]|\d{1,3}[.)])[ \t]+/gm, "")
    .replace(/[*_`~|]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?…])/g, "$1")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const sentence = (s) => { const t = String(s || "").trim(); return !t || /[.!?…:]$/.test(t) ? t : `${t}.`; };

/** What would be read for a link: { source: "article" | "video_digest", title, text }. Throws 409 when there is nothing to read yet. */
export function narrationFor(link) {
  const title = (link.title || "").trim();
  const digest = digestNarration(link.id);
  if (digest && digest.text.length >= MIN_CHARS) {
    return { source: "video_digest", title: title || digest.title, text: cleanForSpeech(`${sentence(title || digest.title)}\n\n${digest.text}`) };
  }
  const body = cleanForSpeech(link.content_text);
  if (body.length >= MIN_CHARS) {
    const head = [sentence(title), link.byline ? sentence(`Por ${String(link.byline).replace(/^(?:por|by)\s+/i, "")}`) : ""].filter(Boolean).join(" ");
    return { source: "article", title, text: head && !body.startsWith(title) ? `${head}\n\n${body}` : body };
  }
  if (link.fetch_status === "pending") fail("El texto de este enlace todavía se está descargando. Prueba en unos segundos.", 409, { code: "pending" });
  fail(link.kind === "video"
    ? "Este vídeo aún no tiene resumen: digiérelo primero (Vídeos → Digerir) y podrás escucharlo."
    : "Este enlace no tiene texto que leer en voz alta.", 409, { code: "no_text" });
}

export function voiceFor(link, voice = "") {
  const chosen = String(voice || "").trim() || String(getSetting("listen_voice", "") || "").trim();
  if (chosen) return chosen;
  const lang = String(link.lang || "es").slice(0, 2).toLowerCase();
  return DEFAULT_VOICES[lang] || DEFAULT_VOICES.es;
}

const hashOf = (text, voice) => crypto.createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------
// Prospero's Hoard, through the hub (replaceable in tests)
// ---------------------------------------------------------------------------

async function hubJson(method, p, { timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(family.status().hub + p, { method, signal: ctl.signal, headers: { Accept: "application/json" } });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch { return { status: null, data: null }; } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (res) => String(res?.error?.error || res?.error?.message || res?.error || res?.result?.error || "sin respuesta");

/** One tool of Prospero. The studio is started when it is not running and its generation module is turned on when a
 *  restart left it off, so «Escuchar» works without opening Prospero first. Throws with a message for the person. */
async function studioCall(tool, args, { timeoutMs = 120000 } = {}) {
  let res = await family.call(STUDIO, tool, args, { timeoutMs });
  for (let attempt = 0; attempt < 3 && !res.ok; attempt++) {
    const message = errorText(res);
    if (res.status === null && /hub not reachable/i.test(message)) {
      // nothing came back: either the hub is not there, or it is and the call took longer than we waited
      const hub = await hubJson("GET", "/api/health", { timeoutMs: 15000 });
      if (hub.status === null) fail("El Hoard Hub no responde: arráncalo para poder generar el audio.", 503, { code: "hub_down" });
      fail("Prospero's Hoard tardó demasiado en contestar.", 504, { code: "timeout" });
    }
    if (/is off/i.test(message)) {
      const on = await family.call(STUDIO, "studio_module_set", { module: "generation", enabled: true, reason: "Links Hoard necesita la voz para leer un enlace" }, { timeoutMs: 120000 });
      if (!on.ok) fail(`Prospero's Hoard tiene la voz apagada y no se pudo encender: ${errorText(on)}`, 503, { code: "studio_off" });
    } else if (res.status === null || res.status === 502 || res.status === 503 || /unreachable|not running|ECONNRE|fetch failed|forcibly closed|connection/i.test(message)) {
      // not running (or restarting): ask the hub to start it and wait until it answers
      await hubJson("POST", `/api/apps/${STUDIO}/start`, { timeoutMs: 45000 });
      const end = Date.now() + 90000;
      for (;;) {
        const app = await hubJson("GET", `/api/apps/${STUDIO}`);
        if (app.data?.state === "running") break;
        if (Date.now() > end) fail("Prospero's Hoard no está arrancado y no se pudo arrancar desde el Hub.", 503, { code: "studio_down" });
        await sleep(2000);
      }
    } else break;
    res = await family.call(STUDIO, tool, args, { timeoutMs });
  }
  if (!res.ok) fail(`Prospero's Hoard no pudo hacerlo: ${errorText(res)}`, 502, { code: "studio_error" });
  return res.result;
}

async function studioUrl() {
  const app = await hubJson("GET", `/api/apps/${STUDIO}`);
  const url = String(app.data?.url || "").replace(/\/+$/, "");
  if (!url) fail("El Hub no sabe dónde está Prospero's Hoard.", 503, { code: "studio_down" });
  return url;
}

const realStudio = {
  /** Queue the narration; returns the job id. */
  async narrate({ text, title, voice, language }) {
    const out = await studioCall("voice_audiobook", {
      text, title: title || "Lectura", format: "mp3", wait_s: 0,
      voice: { engine_id: "piper", voice_ref: voice, language: language || undefined },
      reason: "Links Hoard lee en voz alta un enlace guardado",
    });
    const id = out?.job?.id || out?.id;
    if (!id) fail("Prospero's Hoard no devolvió el trabajo de narración.", 502, { code: "studio_error" });
    return id;
  },
  /** { state, progress 0..1, message, outputs } of a narration job. */
  async job(id, waitS = 0) {
    const out = await studioCall("voice_job", { job_id: id, wait_s: waitS }, { timeoutMs: (waitS + 60) * 1000 });
    return out?.job || out || {};
  },
  /** Copy the finished file ("final" = the MP3, "srt" = the sentence timings) to `dest`. */
  async download(id, kind, dest) {
    const res = await fetch(`${await studioUrl()}/api/voice/audiobook/${encodeURIComponent(id)}/download?file=${kind}`);
    if (!res.ok) fail(`No se pudo traer el audio de Prospero's Hoard (HTTP ${res.status}).`, 502, { code: "studio_error" });
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
    return fs.statSync(dest).size;
  },
  async cancel(id) {
    await family.call(STUDIO, "studio_cancel_job", { job_id: id, reason: "Links Hoard ya no necesita esta narración" }, { timeoutMs: 20000 });
  },
};

let studio = realStudio;
/** Tests replace Prospero with a stand-in: setStudio({ narrate, job, download, cancel }); setStudio(null) restores it. */
export function setStudio(fake) { const old = studio; studio = fake || realStudio; return old; }
let pollWaitS = POLL_WAIT_S;
export function setPollWait(seconds) { const old = pollWaitS; pollWaitS = seconds; return old; }

// ---------------------------------------------------------------------------
// rows and files
// ---------------------------------------------------------------------------

const safeId = (id) => String(id).replace(/[^\w-]/g, "_");
export const listenDir = (id) => path.join(dataDir(), "listen", safeId(id));
const audioPath = (id) => path.join(listenDir(id), "audio.mp3");
const linesPath = (id) => path.join(listenDir(id), "lines.json");

const getRow = (id) => db().prepare("SELECT * FROM link_listen WHERE link_id = ?").get(id) || null;

function patchRow(id, patch) {
  if (!isOpen()) return;
  const entries = Object.entries({ ...patch, updated_at: now() });
  db().prepare(`UPDATE link_listen SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE link_id = ?`).run(...entries.map(([, v]) => v), id);
}

function ensureRow(id) {
  const ts = now();
  db().prepare("INSERT OR IGNORE INTO link_listen (link_id, status, created_at, updated_at) VALUES (?, 'none', ?, ?)").run(id, ts, ts);
  return getRow(id);
}

/** SubRip text as [{ start_s, end_s, text }]. */
export function parseSrt(srt) {
  const toS = (t) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : 0; };
  const out = [];
  for (const block of String(srt || "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const rows = block.split("\n").filter(Boolean);
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at < 0) continue;
    const [a, b] = rows[at].split("-->");
    const text = rows.slice(at + 1).join(" ").trim();
    if (text) out.push({ start_s: Math.round(toS(a) * 1000) / 1000, end_s: Math.round(toS(b) * 1000) / 1000, text });
  }
  return out;
}

const clock = (s) => { const t = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

/** What a caller sees of the audio of one link. */
export function listenView(linkId) {
  const link = links.getLink(linkId);
  if (!link) return null;
  const row = getRow(linkId);
  const base = { link_id: linkId, title: link.title, url: link.url, site: link.site, kind: link.kind };
  if (!row || row.status === "none") {
    return { ...base, status: "none", queued: row?.queue_pos !== null && row?.queue_pos !== undefined, queue_pos: row?.queue_pos ?? null };
  }
  const ready = row.status === "done" && fs.existsSync(audioPath(linkId));
  let stale = false;
  if (ready) {
    try { const n = narrationFor(link); stale = hashOf(n.text, row.voice) !== row.text_hash; } catch { stale = false; }
  }
  const duration = Number(row.duration_s) || 0;
  const position = ready ? Math.min(Number(row.position_s) || 0, duration || Infinity) : 0;
  return {
    ...base,
    status: row.status === "done" && !ready ? "none" : row.status,
    source: row.source, voice: row.voice, chars: row.chars,
    progress: ACTIVE.includes(row.status) ? Math.round((Number(row.progress) || 0) * 100) / 100 : undefined,
    detail: ACTIVE.includes(row.status) ? row.detail || undefined : undefined,
    error: row.status === "failed" ? row.error : undefined,
    ...(ready ? {
      duration_s: duration, duration: clock(duration), bytes: row.bytes,
      file: audioPath(linkId), audio_url: `/api/links/${encodeURIComponent(linkId)}/listen/audio?v=${row.text_hash.slice(0, 8)}`,
      chapters: JSON.parse(row.chapters || "[]"),
      position_s: Math.round(position * 10) / 10, position: clock(position),
      percent: duration ? Math.min(100, Math.round((position / duration) * 100)) : 0,
      finished: !!row.finished, played_at: row.played_at, stale,
    } : {}),
    queued: row.queue_pos !== null, queue_pos: row.queue_pos,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function listenAudioFile(linkId) {
  const row = getRow(linkId);
  const file = audioPath(linkId);
  return row && row.status === "done" && fs.existsSync(file) ? file : null;
}

export function listenLines(linkId) {
  try { return JSON.parse(fs.readFileSync(linesPath(linkId), "utf8")); } catch { return []; }
}

// ---------------------------------------------------------------------------
// generating
// ---------------------------------------------------------------------------

const running = new Map();   // link id -> promise of the job in flight
let stopping = false;

async function generate(linkId) {
  const link = links.getLink(linkId);
  const row = getRow(linkId);
  if (!link || !row) return;
  try {
    const n = narrationFor(link);
    if (n.text.length > MAX_CHARS) fail(`El texto es demasiado largo para leerlo de una vez (${n.text.length} caracteres).`);
    const voice = row.voice || voiceFor(link);
    const hash = hashOf(n.text, voice);
    let jobId = row.text_hash === hash ? row.job_id : "";
    patchRow(linkId, { status: "running", source: n.source, voice, text_hash: hash, chars: n.text.length, error: "", detail: jobId ? row.detail : "En cola de Prospero's Hoard", progress: jobId ? row.progress : 0 });
    const started = Date.now();
    let job = null;
    let lost = 0;
    let silent = 0;
    for (;;) {
      if (stopping || !isOpen()) return;
      const current = getRow(linkId);
      if (!current || current.status === "cancelled" || current.text_hash !== hash) return;       // deleted, cancelled or restarted meanwhile
      if (!jobId) {
        try {
          jobId = await studio.narrate({ text: n.text, title: n.title, voice, language: String(link.lang || "").slice(0, 2) });
        } catch (e) {
          if ((e.code === "timeout" || e.code === "hub_down") && ++silent <= 6) { await sleep(pollWaitS ? 5000 : 10); continue; }
          throw e;
        }
        patchRow(linkId, { job_id: jobId });
      }
      try {
        job = await studio.job(jobId, pollWaitS);
        silent = 0;
      } catch (e) {
        if (e.code === "timeout" || e.code === "hub_down" || e.code === "studio_down") {
          // a busy machine or a hub that is restarting: the job goes on by itself, ask again in a moment
          if (++silent > 40) throw e;
          patchRow(linkId, { detail: "Esperando a Prospero's Hoard" });
          await sleep(pollWaitS ? 5000 : 10);
          continue;
        }
        // Prospero restarted and forgot the job: the same text and voice resume from the chapters already rendered
        if (++lost > 3) throw e;
        jobId = "";
        patchRow(linkId, { job_id: "", detail: "Prospero's Hoard se reinició; se reanuda la lectura" });
        await sleep(Math.min(1500, pollWaitS * 1000));
        continue;
      }
      const state = String(job.state || "").toLowerCase();
      if (state === "done") break;
      if (["failed", "error", "cancelled", "canceled"].includes(state)) fail(`Prospero's Hoard no terminó la lectura: ${job.error || job.message || state}`, 502);
      patchRow(linkId, { progress: Math.max(0, Math.min(0.99, Number(job.progress) || 0)), detail: String(job.message || "").slice(0, 200) });
      if (Date.now() - started > JOB_TIMEOUT_MS) fail("La lectura tardó demasiado y se abandonó.", 504);
      if (!pollWaitS) await sleep(10);
    }
    fs.mkdirSync(listenDir(linkId), { recursive: true });
    const bytes = await studio.download(jobId, "final", audioPath(linkId));
    let lines = [];
    try {
      const srt = path.join(listenDir(linkId), "lines.srt");
      await studio.download(jobId, "srt", srt);
      lines = parseSrt(fs.readFileSync(srt, "utf8"));
      fs.rmSync(srt, { force: true });
    } catch { lines = []; }
    fs.writeFileSync(linesPath(linkId), JSON.stringify(lines), "utf8");
    const outputs = job.outputs || {};
    const duration = Number(outputs.duration_s) || (lines.length ? lines[lines.length - 1].end_s : 0);
    if (!isOpen() || !getRow(linkId)) return;
    patchRow(linkId, {
      status: "done", progress: 1, detail: "", error: "", bytes, duration_s: duration,
      chapters: JSON.stringify((outputs.chapters || []).map((c) => ({ title: String(c.title || ""), start_s: Number(c.start_s) || 0, duration_s: Number(c.duration_s) || 0 }))),
      position_s: 0, finished: 0,
    });
    family.emit("links.listen.ready", { link_id: linkId, title: link.title, duration_s: duration });
  } catch (e) {
    if (isOpen() && getRow(linkId)) patchRow(linkId, { status: "failed", error: String(e?.message || e).slice(0, 500), detail: "" });
  }
}

function kick(linkId) {
  if (running.has(linkId)) return running.get(linkId);
  const p = generate(linkId).finally(() => {
    running.delete(linkId);
    // a run that stepped aside because the text or the voice changed meanwhile leaves the row waiting: follow the new request
    const row = !stopping && isOpen() ? getRow(linkId) : null;
    if (row && row.status === "queued") kick(linkId);
  });
  running.set(linkId, p);
  return p;
}

export const startInput = z.object({
  voice: z.string().trim().max(120).optional(),
  regenerate: z.boolean().default(false),
  queue: z.boolean().default(false),
});

/** Start (or reuse) the audio of a link. Returns its view at once; the narration runs in the background. */
export function startListen(linkId, input = {}) {
  const opts = startInput.parse(input);
  const link = links.getLink(linkId);
  if (!link) fail("No existe.", 404);
  const n = narrationFor(link);                       // 409 when there is nothing to read yet
  const row = ensureRow(linkId);
  const voice = voiceFor(link, opts.voice || (opts.regenerate ? "" : row.voice));
  const hash = hashOf(n.text, voice);
  const ready = row.status === "done" && fs.existsSync(audioPath(linkId));
  const same = row.text_hash === hash;
  if (opts.queue) queueAdd(linkId, { start: false });
  if (!opts.regenerate && same && (ready || ACTIVE.includes(row.status))) {
    if (ACTIVE.includes(row.status)) kick(linkId);
    return { ...listenView(linkId), existing: true };
  }
  if (opts.regenerate || !same) {
    fs.rmSync(listenDir(linkId), { recursive: true, force: true });
    patchRow(linkId, { job_id: "", position_s: 0, finished: 0, duration_s: 0, bytes: 0, chapters: "[]" });
  }
  patchRow(linkId, { status: "queued", voice, source: n.source, text_hash: hash, chars: n.text.length, progress: 0, detail: "Preparando el texto", error: "" });
  kick(linkId);
  return { ...listenView(linkId), existing: false };
}

export async function waitListen(linkId, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const row = getRow(linkId);
    if (!row || !ACTIVE.includes(row.status) || Date.now() > end) return listenView(linkId);
    await Promise.race([running.get(linkId) || sleep(50), sleep(Math.min(500, Math.max(10, end - Date.now())))]);
  }
}

/** Remove the audio of a link (and take it out of the queue). */
export function deleteListen(linkId) {
  const row = getRow(linkId);
  if (!row) return false;
  if (ACTIVE.includes(row.status) && row.job_id) studio.cancel(row.job_id).catch(() => {});
  db().prepare("DELETE FROM link_listen WHERE link_id = ?").run(linkId);
  fs.rmSync(listenDir(linkId), { recursive: true, force: true });
  renumber();
  return true;
}

// ---------------------------------------------------------------------------
// where the listener is
// ---------------------------------------------------------------------------

export const positionInput = z.object({
  position_s: z.coerce.number().min(0).max(1e7),
  finished: z.boolean().optional(),
});

/** Remember where the listener stopped. `finished` marks it heard to the end, takes it out of the queue and marks the link read. */
export function setPosition(linkId, input = {}) {
  const data = positionInput.parse(input);
  const row = getRow(linkId);
  if (!row || row.status !== "done") fail("Este enlace no tiene audio.", 404);
  const duration = Number(row.duration_s) || 0;
  const finished = data.finished === true || (data.finished === undefined && duration > 0 && data.position_s >= duration - 1.5);
  patchRow(linkId, { position_s: finished ? 0 : Math.min(data.position_s, duration || data.position_s), finished: finished ? 1 : data.finished === false ? 0 : row.finished, played_at: now() });
  if (finished) {
    if (row.queue_pos !== null) queueRemove(linkId);
    links.markRead(linkId, true);
  }
  return listenView(linkId);
}

// ---------------------------------------------------------------------------
// «Escuchar después»
// ---------------------------------------------------------------------------

function renumber() {
  const rows = db().prepare("SELECT link_id FROM link_listen WHERE queue_pos IS NOT NULL ORDER BY queue_pos, updated_at").all();
  const set = db().prepare("UPDATE link_listen SET queue_pos = ? WHERE link_id = ?");
  rows.forEach((r, i) => set.run(i + 1, r.link_id));
}

export function queueList() {
  return db().prepare("SELECT link_id FROM link_listen WHERE queue_pos IS NOT NULL ORDER BY queue_pos").all().map((r) => listenView(r.link_id)).filter(Boolean);
}

/** Put a link at the end of the queue (or at `position`, 1-based). The audio starts generating unless start is false. */
export function queueAdd(linkId, { position = null, start = true } = {}) {
  const link = links.getLink(linkId);
  if (!link) fail("No existe.", 404);
  const row = ensureRow(linkId);
  if (row.queue_pos === null) {
    const last = db().prepare("SELECT COALESCE(MAX(queue_pos), 0) AS n FROM link_listen").get().n;
    db().prepare("UPDATE link_listen SET queue_pos = ? WHERE link_id = ?").run(last + 1, linkId);
  }
  if (position) queueMove(linkId, position);
  if (start && !["done", ...ACTIVE].includes(getRow(linkId).status)) {
    try { startListen(linkId, {}); } catch (e) { patchRow(linkId, { status: "failed", error: String(e.message || e).slice(0, 500) }); }
  }
  return queueList();
}

export function queueRemove(linkId) {
  db().prepare("UPDATE link_listen SET queue_pos = NULL WHERE link_id = ?").run(linkId);
  renumber();
  return queueList();
}

export function queueMove(linkId, position) {
  const ids = db().prepare("SELECT link_id FROM link_listen WHERE queue_pos IS NOT NULL ORDER BY queue_pos").all().map((r) => r.link_id);
  const from = ids.indexOf(linkId);
  if (from < 0) fail("Ese enlace no está en la cola.", 404);
  ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, Math.round(Number(position) || 1) - 1)), 0, linkId);
  return queueOrder(ids);
}

/** Reorder the whole queue: ids not listed keep their relative order after the listed ones. */
export function queueOrder(ids = []) {
  const current = db().prepare("SELECT link_id FROM link_listen WHERE queue_pos IS NOT NULL ORDER BY queue_pos").all().map((r) => r.link_id);
  const wanted = [...new Set(ids.map(String))].filter((id) => current.includes(id));
  const order = [...wanted, ...current.filter((id) => !wanted.includes(id))];
  const set = db().prepare("UPDATE link_listen SET queue_pos = ? WHERE link_id = ?");
  order.forEach((id, i) => set.run(i + 1, id));
  return queueList();
}

export function queueClear() {
  db().prepare("UPDATE link_listen SET queue_pos = NULL").run();
  return [];
}

/** Everything that has audio (or is being narrated), newest first: the «Escuchar» page. */
export function listenLibrary({ limit = 100 } = {}) {
  return db().prepare("SELECT link_id FROM link_listen WHERE status != 'none' ORDER BY updated_at DESC LIMIT ?").all(limit)
    .map((r) => listenView(r.link_id)).filter(Boolean);
}

export function listenSettings() {
  return { voice: String(getSetting("listen_voice", "") || ""), default_voices: DEFAULT_VOICES };
}

export function setListenSettings(patch = {}) {
  if (patch.voice !== undefined) setSetting("listen_voice", String(patch.voice || "").trim().slice(0, 120));
  return listenSettings();
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Narrations left unfinished by the last run are followed again. */
export function initListen() {
  stopping = false;
  for (const row of db().prepare("SELECT link_id FROM link_listen WHERE status IN ('queued', 'running')").all()) kick(row.link_id);
}

export async function shutdownListen() {
  stopping = true;
  await Promise.allSettled([...running.values()]);
  running.clear();
}
