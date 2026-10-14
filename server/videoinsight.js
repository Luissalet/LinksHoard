// Video insight: for a saved link that is a video (a reel, a short, a video page, or a media file the app already holds) obtain
//   - a transcript with timestamps: the family's speech-to-text service through Hoard Link (Funes), else faster-whisper on the CPU when it
//     is installed and its model already cached, else the step is skipped with a clear status;
//   - key frames: ffmpeg scene changes plus a timed fallback, capped, stored as JPEG images with their timestamps.
// Both are searchable (the transcript through the segments full-text index) and shown in the item view. The work runs one item at a time
// in the background, retries what failed (a service that was down) from the periodic sweep, and is idempotent: the same source and
// nothing missing means nothing is redone.
//
// Where the media comes from, in order: a file given by path or uploaded, a finished download of this link (media.js), and - only when
// the user asked for it (download: true, or the auto_download setting) - a download through the app's own yt-dlp integration. Nothing here
// scrapes anything by itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db, now, getSetting, setSetting, isOpen, dataDir, ftsEnabled, transaction } from "./db.js";
import * as links from "./links.js";
import * as media from "./media.js";
import { runProcess, runCapture } from "./hoard-commons/media.js";
import { transcribe as famTranscribe, serviceAvailable } from "./hoard-commons/fam-services.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".ts", ".3gp"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac"]);
export const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_S = [60, 300, 1800];

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const settingsInput = z.object({
  auto: z.boolean().optional(), // analyse a video as soon as a file for it exists (a finished download)
  auto_download: z.boolean().optional(), // also download the video of a saved video link by itself (off by default)
  max_frames: z.number().int().min(1).max(60).optional(),
  max_duration_s: z.number().int().min(10).max(24 * 3600).optional(),
  scene_threshold: z.number().min(0.05).max(0.9).optional(),
  whisper_model: z.string().trim().min(1).max(60).optional(),
}).strict();

const envBool = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return !/^(0|off|no|false)$/i.test(v.trim());
};

export function videoSettings() {
  const stored = isOpen() ? getSetting("video", {}) : {};
  return {
    auto: envBool("LINKS_VIDEO_AUTO", stored.auto ?? true),
    auto_download: envBool("LINKS_VIDEO_AUTO_DOWNLOAD", stored.auto_download ?? false),
    max_frames: Number(process.env.LINKS_VIDEO_MAX_FRAMES) || stored.max_frames || 24,
    max_duration_s: stored.max_duration_s || 3600,
    scene_threshold: stored.scene_threshold || 0.3,
    whisper_model: process.env.LINKS_WHISPER_MODEL || stored.whisper_model || "base",
  };
}

export function setVideoSettings(input = {}) {
  const data = settingsInput.parse(input);
  const stored = getSetting("video", {});
  setSetting("video", { ...stored, ...data });
  return videoSettings();
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

export const clock = (t) => {
  const s = Math.max(0, Math.round(Number(t) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
};

/** ffmpeg -i output: duration in seconds, whether there is an audio / video stream, the picture size. */
export function parseProbe(stderr) {
  const text = String(stderr || "");
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const size = /Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  const cover = /Video:\s*(mjpeg|png)[^\n]*/.test(text) && /attached pic/.test(text);
  return {
    duration, hasAudio: /Stream #[^\n]*Audio:/.test(text), hasVideo: /Stream #[^\n]*Video:/.test(text) && !cover,
    width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0,
  };
}

/** The pts_time of every frame the select filter let through (showinfo lines on stderr). */
export function parseSceneTimes(lines) {
  const out = [];
  for (const line of lines) {
    const m = /pts_time:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (m && /showinfo/.test(line)) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Which instants become key frames: an opening frame, the scene changes (at least minGap apart, evenly thinned when they exceed the
 * cap), then timed frames on an even grid wherever no frame is close - never more than `max` in all.
 * Returns [{ t, reason: "start" | "scene" | "timed" }] sorted by time.
 */
export function planFrames(duration, sceneTimes = [], { max = 24, minGap = 1.5 } = {}) {
  const dur = Number(duration) > 0 ? Number(duration) : 0;
  const last = dur ? Math.max(0, dur - 0.1) : Infinity;
  const cap = Math.max(1, Math.floor(max));
  const clamp = (t) => Math.round(Math.min(Math.max(0, t), last) * 100) / 100;
  const first = clamp(dur ? Math.min(0.5, dur / 2) : 0);
  const chosen = [{ t: first, reason: "start" }];
  let scenes = [...sceneTimes].filter((t) => Number.isFinite(t) && t >= 0 && (!dur || t < dur)).sort((a, b) => a - b).map((t) => clamp(t + 0.1));
  const spaced = [];
  for (const t of scenes) if (t - first >= minGap && (!spaced.length || t - spaced[spaced.length - 1] >= minGap)) spaced.push(t);
  scenes = spaced;
  const room = cap - 1;
  if (scenes.length > room) {
    const picked = [];
    for (let i = 0; i < room; i++) picked.push(scenes[Math.floor((i * scenes.length) / room)]);
    scenes = picked;
  }
  for (const t of scenes) chosen.push({ t, reason: "scene" });
  if (dur && chosen.length < cap) {
    const step = Math.max(dur / cap, 3);
    for (let g = step / 2; g < dur && chosen.length < cap; g += step) {
      const t = clamp(g);
      if (chosen.every((c) => Math.abs(c.t - t) >= step * 0.6)) chosen.push({ t, reason: "timed" });
    }
  }
  return chosen.sort((a, b) => a.t - b.t);
}

/** Whatever a speech-to-text provider returned, as { text, segments: [{start_s, end_s, text}] }. */
export function normalizeTranscript(raw, duration = 0) {
  const segs = (Array.isArray(raw?.segments) ? raw.segments : []).map((s) => ({
    start_s: Number(s.start_s ?? s.start) || 0,
    end_s: Number(s.end_s ?? s.end) || 0,
    text: String(s.text ?? "").replace(/\s+/g, " ").trim(),
  })).filter((s) => s.text);
  const text = String(raw?.text || "").trim() || segs.map((s) => s.text).join(" ");
  if (!segs.length && text) segs.push({ start_s: 0, end_s: Number(duration) || 0, text });
  return { text, segments: segs };
}

/** True for a saved link that looks like a video: its kind, or a known video site's reel / short / video address. */
export function looksLikeVideo(link) {
  if (!link) return false;
  if (link.kind === "video") return true;
  return media.isKnownPlatform(link.url) && /reel|short|video|watch|youtu\.be|tiktok\.com|\/status\//i.test(link.url);
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const videoRoot = () => path.join(dataDir(), "video");
export const linkDir = (id) => path.join(videoRoot(), String(id).replace(/[^\w-]/g, "_"));
const framesDir = (id) => path.join(linkDir(id), "frames");
export const getMedia = (id) => db().prepare("SELECT * FROM link_media WHERE link_id = ?").get(id) || null;

function patchMedia(id, patch) {
  if (!isOpen()) return;
  const entries = Object.entries({ ...patch, updated_at: now() });
  db().prepare(`UPDATE link_media SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE link_id = ?`).run(...entries.map(([, v]) => v), id);
}

function ensureRow(id) {
  const ts = now();
  db().prepare("INSERT OR IGNORE INTO link_media (link_id, status, created_at, updated_at) VALUES (?, 'queued', ?, ?)").run(id, ts, ts);
  return getMedia(id);
}

function replaceSegments(id, segments) {
  transaction(() => {
    db().prepare("DELETE FROM link_segments WHERE link_id = ?").run(id);
    if (ftsEnabled()) db().prepare("DELETE FROM link_segments_fts WHERE link_id = ?").run(id);
    const ins = db().prepare("INSERT INTO link_segments (link_id, idx, start_s, end_s, text) VALUES (?, ?, ?, ?, ?)");
    const fts = ftsEnabled() ? db().prepare("INSERT INTO link_segments_fts (text, link_id, idx) VALUES (?, ?, ?)") : null;
    segments.forEach((s, i) => { ins.run(id, i, s.start_s, s.end_s, s.text); fts?.run(s.text, id, i); });
  });
}

function replaceFrames(id, frames) {
  transaction(() => {
    db().prepare("DELETE FROM link_frames WHERE link_id = ?").run(id);
    const ins = db().prepare("INSERT INTO link_frames (link_id, idx, t_s, reason, file, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)");
    frames.forEach((f, i) => ins.run(id, i, f.t, f.reason, f.file, f.width || 0, f.height || 0));
  });
}

/** Called by links.deleteLink: the rows go with the link, the files are removed here. */
export function purgeLinkVideo(id) {
  try { if (dataDir()) fs.rmSync(linkDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// the view of one link
// ---------------------------------------------------------------------------

export function videoView(linkId, { transcript = true, segments = true, maxChars = 0 } = {}) {
  const link = links.getLink(linkId);
  if (!link) return null;
  const m = getMedia(linkId);
  if (!m) return { link_id: linkId, status: "none", video_candidate: looksLikeVideo(link), frames: { status: "pending", count: 0, items: [] }, transcript: { status: "pending" } };
  const frames = db().prepare("SELECT * FROM link_frames WHERE link_id = ? ORDER BY idx").all(linkId).map((f) => ({
    index: f.idx, t_s: f.t_s, time: clock(f.t_s), reason: f.reason, width: f.width, height: f.height,
    url: `/api/links/${linkId}/frames/${f.idx}`, path: path.join(framesDir(linkId), f.file),
  }));
  const segs = segments ? db().prepare("SELECT idx, start_s, end_s, text FROM link_segments WHERE link_id = ? ORDER BY idx").all(linkId)
    .map((s) => ({ index: s.idx, start_s: s.start_s, end_s: s.end_s, time: clock(s.start_s), text: s.text })) : undefined;
  let text = m.transcript_text;
  const truncated = !!(maxChars && text.length > maxChars);
  if (truncated) text = text.slice(0, maxChars);
  return {
    link_id: linkId, status: m.status, detail: m.detail, attempts: m.attempts, max_attempts: MAX_ATTEMPTS, next_retry_at: m.next_retry_at,
    source: { kind: m.source_kind, name: m.source_path ? path.basename(m.source_path) : "", path: m.source_path },
    duration_s: m.duration, has_audio: m.has_audio === null ? null : !!m.has_audio,
    frames: { status: m.frames_status, error: m.frames_error || undefined, count: frames.length, items: frames },
    transcript: {
      status: m.transcript_status, error: m.transcript_error || undefined, via: m.transcript_via || undefined, model: m.transcript_model || undefined,
      language: m.transcript_lang || undefined, word_count: m.transcript_text ? m.transcript_text.split(/\s+/).filter(Boolean).length : 0,
      ...(transcript ? { text, truncated } : {}), ...(segs ? { segments: segs } : {}),
    },
    created_at: m.created_at, updated_at: m.updated_at, finished_at: m.finished_at,
  };
}

/** Light summary for the link's own record. */
export function videoSummary(linkId) {
  const v = videoView(linkId, { transcript: false, segments: false });
  if (!v) return null;
  return { status: v.status, frames: v.frames.count, transcript: v.transcript.status, candidate: v.video_candidate ?? true };
}

/** Transcript search: the lines (with their time) that contain the phrase. */
export function searchTranscripts(query, limit = 20) {
  const q = String(query || "").trim();
  if (!q) return [];
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  let rows;
  if (ftsEnabled()) {
    rows = db().prepare(
      `SELECT s.link_id, s.idx, s.start_s, s.text, l.title, l.url FROM link_segments_fts f
         JOIN link_segments s ON s.link_id = f.link_id AND s.idx = f.idx JOIN links l ON l.id = s.link_id
        WHERE link_segments_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all(`"${q.replace(/"/g, '""')}"`, max);
  } else {
    rows = db().prepare(
      "SELECT s.link_id, s.idx, s.start_s, s.text, l.title, l.url FROM link_segments s JOIN links l ON l.id = s.link_id WHERE s.text LIKE ? ORDER BY s.link_id, s.idx LIMIT ?",
    ).all(`%${q}%`, max);
  }
  return rows.map((r) => ({ link_id: r.link_id, title: r.title, url: r.url, index: r.idx, start_s: r.start_s, time: clock(r.start_s), text: r.text }));
}

// ---------------------------------------------------------------------------
// the source of the media
// ---------------------------------------------------------------------------

export const mediaKindOf = (file) => {
  const ext = path.extname(file).toLowerCase();
  return VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "other";
};
const fingerprint = (file) => { const st = fs.statSync(file); return `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`; };

function checkMediaFile(file) {
  const abs = path.resolve(String(file || ""));
  let st;
  try { st = fs.statSync(abs); } catch { throw Object.assign(new Error(`No existe el archivo: ${abs}`), { status: 400 }); }
  if (!st.isFile()) throw Object.assign(new Error(`No es un archivo: ${abs}`), { status: 400 });
  if (mediaKindOf(abs) === "other") throw Object.assign(new Error("Solo se admiten archivos de vídeo o de audio (mp4, mov, mkv, webm, mp3, m4a, wav…)."), { status: 400 });
  return abs;
}

/** A video this app already holds for the link: a finished download, or a file uploaded earlier. */
export function findLocalSource(link) {
  const rows = db().prepare(
    "SELECT id, files FROM media_downloads WHERE status = 'done' AND asr = 0 AND (link_id = ? OR url = ? OR url = ?) ORDER BY finished_at DESC",
  ).all(link.id, link.url, link.url_original || link.url);
  for (const r of rows) {
    let files = [];
    try { files = JSON.parse(r.files || "[]"); } catch { files = []; }
    const pick = files.find((f) => f?.path && mediaKindOf(f.path) === "video" && fs.existsSync(f.path))
      || files.find((f) => f?.path && mediaKindOf(f.path) === "audio" && fs.existsSync(f.path));
    if (pick) return { path: pick.path, kind: "download", downloadId: r.id };
  }
  try {
    const dir = linkDir(link.id);
    const up = fs.readdirSync(dir).find((n) => n.startsWith("source."));
    if (up) return { path: path.join(dir, up), kind: "upload", downloadId: null };
  } catch { /* none */ }
  return null;
}

// ---------------------------------------------------------------------------
// speech to text providers
// ---------------------------------------------------------------------------

let sttOverride = null;
/** Tests (or an embedding app) replace the providers with one function: (wavPath, { language, signal }) => { ok, text, segments, language, via, model } | { ok: false, kind, error }. */
export function setSttProvider(fn) { const old = sttOverride; sttOverride = fn || null; return old; }

async function famProvider(wav, { language }) {
  if (!(await serviceAvailable("stt"))) return { ok: false, kind: "unavailable", error: "El servicio de transcripción de la familia (Funes) no está disponible." };
  const r = await famTranscribe(wav, { language: language || "auto", timeoutS: 900 });
  if (r.ok) return { ok: true, text: r.text, segments: r.segments, language: r.language, via: "funes", model: r.model };
  const unavailable = ["hub_down", "app_down", "app_missing", "tool_missing"].includes(r.kind);
  return { ok: false, kind: unavailable ? "unavailable" : "error", error: String(r.error || "falló la transcripción") };
}

let whisperChecked = null;
async function pythonWithWhisper() {
  if (whisperChecked) return whisperChecked.cmd ? whisperChecked : null;
  const names = [process.env.LINKS_PYTHON, "python", "python3", "py"].filter(Boolean);
  for (const cmd of names) {
    const r = await runCapture({ cmd, args: [] }, ["-c", "import faster_whisper"], { timeoutMs: 20_000, lowPriority: false });
    if (r.code === 0) { whisperChecked = { cmd }; return whisperChecked; }
  }
  whisperChecked = { cmd: null };
  return null;
}
export function forgetWhisper() { whisperChecked = null; }

async function whisperProvider(wav, { language, signal }) {
  const py = await pythonWithWhisper();
  if (!py) return { ok: false, kind: "unavailable", error: "faster-whisper no está instalado." };
  const model = videoSettings().whisper_model;
  let out = "";
  const r = await runProcess({ cmd: py.cmd, args: [] }, [path.join(HERE, "stt_local.py"), wav, model, language || "auto", process.env.LINKS_WHISPER_ALLOW_DOWNLOAD === "1" ? "1" : "0"],
    { signal, timeoutMs: 45 * 60_000, onStdoutLine: (l) => { out += l; } });
  if (r.code !== 0) {
    const tail = String(r.stderr || "").trim().split(/\r?\n/).pop() || `código ${r.code}`;
    const missingModel = /local_files_only|cannot find|not found|offline|snapshot/i.test(r.stderr || "");
    return { ok: false, kind: missingModel ? "unavailable" : "error", error: missingModel ? `El modelo «${model}» de faster-whisper no está en la caché local.` : tail.slice(0, 300) };
  }
  try {
    const data = JSON.parse(out);
    return { ok: true, text: data.text, segments: data.segments, language: data.language, via: "faster-whisper", model: data.model };
  } catch { return { ok: false, kind: "error", error: "faster-whisper no devolvió un resultado legible." }; }
}

/** The family's service first, then the local engine; the first answer that is not "unavailable" wins. */
async function runStt(wav, opts) {
  if (sttOverride) return sttOverride(wav, opts);
  const notes = [];
  for (const provider of [famProvider, whisperProvider]) {
    let r;
    try { r = await provider(wav, opts); } catch (e) { if (opts.signal?.aborted) throw e; r = { ok: false, kind: "error", error: String(e?.message || e).slice(0, 300) }; }
    if (r.ok || r.kind !== "unavailable") return r;
    notes.push(r.error);
  }
  return { ok: false, kind: "unavailable", error: `Sin motor de transcripción: ${notes.join(" ")}` };
}

// ---------------------------------------------------------------------------
// ffmpeg steps
// ---------------------------------------------------------------------------

export async function probeSource(ffmpeg, file, signal) {
  const r = await runCapture(ffmpeg.command, ["-hide_banner", "-i", file], { signal, timeoutMs: 30_000 });
  return parseProbe(r.stderr);
}

async function sceneTimes(ffmpeg, file, { threshold, limitS, signal }) {
  const lines = [];
  const args = ["-hide_banner", "-nostats", "-i", file, ...(limitS ? ["-t", String(limitS)] : []), "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"];
  const r = await runProcess(ffmpeg.command, args, { signal, timeoutMs: 10 * 60_000, onStderrLine: (l) => { if (l.includes("showinfo")) lines.push(l); } });
  if (r.code !== 0) throw new Error(`ffmpeg no pudo analizar las escenas (código ${r.code}).`);
  return parseSceneTimes(lines);
}

async function extractFrames(ffmpeg, file, id, plan, { width, signal }) {
  const dir = framesDir(id);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [i, p] of plan.entries()) {
    const name = `f${String(i + 1).padStart(3, "0")}.jpg`;
    const r = await runProcess(ffmpeg.command, ["-hide_banner", "-loglevel", "error", "-ss", String(p.t), "-i", file, "-frames:v", "1",
      "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-y", path.join(dir, name)], { signal, timeoutMs: 60_000 });
    if (r.code !== 0 || !fs.existsSync(path.join(dir, name))) continue;
    out.push({ t: p.t, reason: p.reason, file: name });
  }
  return out;
}

/** Width and height from the JPEG start-of-frame marker. */
export function jpegSize(file) {
  try {
    const b = fs.readFileSync(file);
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch { /* unknown */ }
  return { width: 0, height: 0 };
}

async function extractAudio(ffmpeg, file, wav, signal) {
  const r = await runProcess(ffmpeg.command, ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav], { signal, timeoutMs: 20 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(wav)) throw new Error(`ffmpeg no pudo extraer el audio (código ${r.code}).`);
}

// ---------------------------------------------------------------------------
// the job
// ---------------------------------------------------------------------------

const queue = [];
const pendingOpts = new Map(); // linkId -> { force, download, language } for the next run
let current = null;
let abort = new AbortController();
let stopping = false;
let idleWaiters = [];

const retryDelays = () => {
  const raw = process.env.LINKS_VIDEO_RETRY_S;
  const list = raw ? raw.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0) : DEFAULT_RETRY_S;
  return list.length ? list : DEFAULT_RETRY_S;
};
const retryAt = (attempts) => new Date(Date.now() + 1000 * (retryDelays()[attempts - 1] ?? 1800)).toISOString();

function pump() {
  if (current || stopping) return;
  const id = queue.shift();
  if (!id) { const w = idleWaiters; idleWaiters = []; w.forEach((f) => f()); return; }
  current = runJob(id).catch(() => {}).finally(() => { current = null; pump(); });
}

function enqueue(id) {
  if (stopping || queue.includes(id)) return;
  queue.push(id);
  pump();
}

/** Resolves when nothing is queued or running (tests; also the shutdown). */
export function waitVideoIdle(timeoutMs = 60_000) {
  if (!current && !queue.length) return Promise.resolve();
  return new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); t.unref?.(); idleWaiters.push(() => { clearTimeout(t); resolve(); }); });
}

export async function shutdownVideo() {
  stopping = true;
  queue.length = 0;
  abort.abort();
  await current?.catch(() => {});
}

class Stop extends Error { constructor(message, code = "STOP") { super(message); this.code = code; } }

async function acquire(link, m, { download, maxHeight = 480, maxDurationS = 0 }) {
  const local = m.source_kind === "path" && m.source_path && fs.existsSync(m.source_path)
    ? { path: m.source_path, kind: "path", downloadId: null } : findLocalSource(link);
  if (local) return local;
  const s = videoSettings();
  if (!download && !s.auto_download) {
    throw new Stop("No hay un archivo de vídeo para este enlace. Adjunta uno (ruta o subida), descárgalo desde Descargas o activa la descarga automática.", "NO_SOURCE");
  }
  patchMedia(link.id, { detail: "Descargando el vídeo…" });
  const height = Math.max(144, Math.min(2160, Number(maxHeight) || 480));
  const started = media.startDownload({ url: link.url_original || link.url, format: "video", quality: String(height), max_height: height,
    max_duration_s: Math.max(s.max_duration_s, Number(maxDurationS) || 0), save_link: false });
  const done = await media.waitForDownload(started.id, 20 * 60_000);
  if (abort.signal.aborted) throw new Stop("Interrumpido al cerrar la app.", "ABORT");
  if (!done || done.status !== "done") throw new Error(`La descarga del vídeo no terminó (${done?.status || "sin estado"}${done?.error ? `: ${done.error}` : ""}).`);
  const file = (done.files || []).find((f) => f?.path && ["video", "audio"].includes(mediaKindOf(f.path)) && fs.existsSync(f.path));
  if (!file) throw new Error("La descarga no produjo un archivo de vídeo.");
  return { path: file.path, kind: "download", downloadId: started.id };
}

async function runJob(id) {
  if (!isOpen()) return;
  const link = links.getLink(id);
  let m = link ? getMedia(id) : null;
  if (!m) return;
  const signal = abort.signal;
  const opts = pendingOpts.get(id) || {};
  const attempts = m.attempts + 1;
  patchMedia(id, { status: "running", attempts, detail: "Preparando…", next_retry_at: null });
  const wav = path.join(linkDir(id), "audio.wav");
  try {
    const src = await acquire(link, getMedia(id), { download: !!opts.download, maxHeight: opts.maxHeight, maxDurationS: opts.maxDurationS });
    const fp = fingerprint(src.path);
    m = getMedia(id);
    if (m.source_fp !== fp || opts.force) {
      patchMedia(id, { frames_status: "pending", frames_error: "", transcript_status: "pending", transcript_error: "", transcript_text: "" });
    }
    patchMedia(id, { source_kind: src.kind, source_path: src.path, source_fp: fp, download_id: src.downloadId });
    const ffmpeg = await media.resolveTool("ffmpeg");
    if (!ffmpeg?.found) throw new Stop("Falta ffmpeg para analizar el vídeo. Instálalo (por ejemplo: winget install ffmpeg) y vuelve a intentarlo.", "NO_FFMPEG");
    const info = await probeSource(ffmpeg, src.path, signal);
    const settings = videoSettings();
    const duration = info.duration ?? 0;
    patchMedia(id, { duration: info.duration, has_audio: info.hasAudio ? 1 : 0 });
    m = getMedia(id);

    // key frames
    const haveFrames = m.frames_status === "done"
      && db().prepare("SELECT file FROM link_frames WHERE link_id = ?").all(id).filter((f) => fs.existsSync(path.join(framesDir(id), f.file))).length > 0;
    if (mediaKindOf(src.path) === "audio" || !info.hasVideo) {
      patchMedia(id, { frames_status: "skipped", frames_error: "El archivo no tiene imagen." });
    } else if (!haveFrames) {
      patchMedia(id, { detail: "Buscando fotogramas clave…" });
      try {
        let scenes = [];
        try { scenes = await sceneTimes(ffmpeg, src.path, { threshold: settings.scene_threshold, limitS: settings.max_duration_s, signal }); } catch (e) { if (signal.aborted) throw e; /* timed frames still work */ }
        const plan = planFrames(duration ? Math.min(duration, settings.max_duration_s) : 0, scenes, { max: settings.max_frames });
        const frames = await extractFrames(ffmpeg, src.path, id, plan, { width: 640, signal });
        if (!frames.length) throw new Error("ffmpeg no produjo ningún fotograma.");
        for (const f of frames) Object.assign(f, jpegSize(path.join(framesDir(id), f.file)));
        replaceFrames(id, frames);
        patchMedia(id, { frames_status: "done", frames_error: "" });
      } catch (e) {
        if (signal.aborted) throw e;
        patchMedia(id, { frames_status: "failed", frames_error: String(e.message || e).slice(0, 300) });
      }
    }

    // transcript
    m = getMedia(id);
    if (!info.hasAudio) {
      patchMedia(id, { transcript_status: "no_audio", transcript_error: "", transcript_text: "" });
      replaceSegments(id, []);
    } else if (m.transcript_status !== "done" && m.transcript_status !== "no_speech") {
      patchMedia(id, { detail: "Transcribiendo…" });
      fs.mkdirSync(linkDir(id), { recursive: true });
      try {
        await extractAudio(ffmpeg, src.path, wav, signal);
        const r = await runStt(wav, { language: opts.language || "auto", signal });
        if (r.ok) {
          const t = normalizeTranscript(r, duration);
          if (!t.text) {
            replaceSegments(id, []);
            patchMedia(id, { transcript_status: "no_speech", transcript_error: "", transcript_text: "", transcript_via: r.via || "", transcript_model: r.model || "" });
          } else {
            replaceSegments(id, t.segments);
            patchMedia(id, { transcript_status: "done", transcript_error: "", transcript_text: t.text, transcript_via: r.via || "", transcript_model: r.model || "", transcript_lang: r.language || "" });
          }
        } else {
          patchMedia(id, { transcript_status: r.kind === "unavailable" ? "skipped" : "failed", transcript_error: String(r.error || "").slice(0, 400) });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        patchMedia(id, { transcript_status: "failed", transcript_error: String(e.message || e).slice(0, 300) });
      } finally { fs.rmSync(wav, { force: true }); }
    }
    settle(id, attempts);
  } catch (e) {
    try { fs.rmSync(wav, { force: true }); } catch { /* ignore */ }
    if (e instanceof Stop) {
      if (e.code === "ABORT") patchMedia(id, { status: "queued", detail: "" });
      else patchMedia(id, { status: e.code === "NO_SOURCE" ? "no_source" : "failed", detail: e.message, finished_at: now(), next_retry_at: null });
    } else if (abort.signal.aborted || e?.code === "CANCELLED") {
      patchMedia(id, { status: "queued", detail: "" });
    } else {
      patchMedia(id, { status: "failed", detail: String(e.message || e).slice(0, 400), finished_at: now(), next_retry_at: attempts < MAX_ATTEMPTS ? retryAt(attempts) : null });
    }
  } finally {
    pendingOpts.delete(id);
  }
}

/** Final state of a pass: done when nothing is missing; otherwise partial (or failed), with the next retry when one is worth it. */
function settle(id, attempts) {
  const m = getMedia(id);
  const framesOk = ["done", "skipped"].includes(m.frames_status);
  const textOk = ["done", "no_audio", "no_speech"].includes(m.transcript_status);
  const status = framesOk && textOk ? "done" : (m.frames_status === "done" || m.transcript_status === "done") ? "partial" : "failed";
  const bits = [];
  if (!framesOk) bits.push(`fotogramas: ${m.frames_error || m.frames_status}`);
  if (!textOk) bits.push(`transcripción: ${m.transcript_error || m.transcript_status}`);
  patchMedia(id, {
    status, finished_at: now(), detail: bits.join(" · "),
    next_retry_at: status !== "done" && attempts < MAX_ATTEMPTS ? retryAt(attempts) : null,
  });
}

/**
 * Ask for the analysis of a link. Idempotent: a finished analysis of the same source is returned as it is; one in progress is not started
 * twice. path: a media file to use (it replaces the source); download: allow fetching the video with the app's downloader (maxHeight and
 * maxDurationS widen what that download takes: the digest wants readable screen text and long talks); force: redo it all.
 */
export function requestAnalysis(linkId, { path: file, download = false, force = false, language, maxHeight, maxDurationS } = {}) {
  const link = links.getLink(linkId);
  if (!link) throw Object.assign(new Error("No existe ese enlace."), { status: 404 });
  let m = getMedia(linkId);
  if (m && ["queued", "running"].includes(m.status)) return videoView(linkId);
  const given = file ? checkMediaFile(file) : null;
  const sameFile = !!(given && m && m.source_path === given && m.source_fp === fingerprint(given));
  if (m && m.status === "done" && !force && (!given || sameFile)) {
    const same = !m.source_path || (fs.existsSync(m.source_path) && fingerprint(m.source_path) === m.source_fp);
    if (same) return videoView(linkId);
  }
  m = ensureRow(linkId);
  const patch = { status: "queued", detail: "En cola…", finished_at: null, next_retry_at: null };
  if (force || given) patch.attempts = 0;
  if (given) Object.assign(patch, { source_kind: "path", source_path: given });
  patchMedia(linkId, patch);
  pendingOpts.set(linkId, { force, download, language, maxHeight, maxDurationS });
  enqueue(linkId);
  return videoView(linkId);
}

/** Store an uploaded file as the link's source and analyse it. */
export function attachUpload(linkId, tempFile, originalName = "") {
  const link = links.getLink(linkId);
  if (!link) throw Object.assign(new Error("No existe ese enlace."), { status: 404 });
  const ext = path.extname(originalName || "").toLowerCase();
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) throw Object.assign(new Error("Solo se admiten archivos de vídeo o de audio (indica el nombre con la extensión)."), { status: 400 });
  const dir = linkDir(linkId);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) if (n.startsWith("source.")) fs.rmSync(path.join(dir, n), { force: true });
  const dest = path.join(dir, `source${ext}`);
  fs.renameSync(tempFile, dest);
  return requestAnalysis(linkId, { path: dest, force: true });
}

export function uploadTempPath() {
  fs.mkdirSync(videoRoot(), { recursive: true });
  return path.join(videoRoot(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
}

export function frameFile(linkId, index) {
  const f = db().prepare("SELECT file FROM link_frames WHERE link_id = ? AND idx = ?").get(linkId, Number(index));
  if (!f) return null;
  const abs = path.join(framesDir(linkId), f.file);
  return fs.existsSync(abs) ? abs : null;
}

// ---------------------------------------------------------------------------
// start up, the periodic sweep, the hook of finished downloads
// ---------------------------------------------------------------------------

/** On boot: a job that was running when the app closed goes back to the queue; finished downloads of videos start an analysis. */
export function initVideoInsight() {
  stopping = false;
  abort = new AbortController();
  const rows = db().prepare("SELECT link_id FROM link_media WHERE status IN ('queued','running')").all();
  for (const r of rows) { patchMedia(r.link_id, { status: "queued" }); enqueue(r.link_id); }
  media.setDoneHook((row) => {
    try {
      if (!row?.link_id || row.asr || !videoSettings().auto) return;
      if ((row.files || []).some((f) => f?.path && ["video", "audio"].includes(mediaKindOf(f.path)))) requestAnalysis(row.link_id);
    } catch { /* the link may be gone */ }
  });
}

/** One pass of the background loop: due retries, then video links that have a file (or may be downloaded) and no analysis yet. */
export async function sweepVideo({ limit = 5 } = {}) {
  if (!isOpen() || stopping) return { retried: 0, started: 0 };
  let retried = 0, started = 0;
  const due = db().prepare(
    "SELECT link_id, source_kind FROM link_media WHERE status IN ('partial','failed') AND next_retry_at IS NOT NULL AND next_retry_at <= ? AND attempts < ? ORDER BY next_retry_at LIMIT ?",
  ).all(now(), MAX_ATTEMPTS, limit);
  for (const r of due) {
    patchMedia(r.link_id, { status: "queued", detail: "Reintentando…", next_retry_at: null });
    pendingOpts.set(r.link_id, { download: r.source_kind === "download" });
    enqueue(r.link_id);
    retried++;
  }
  const s = videoSettings();
  if (s.auto || s.auto_download) {
    const cands = db().prepare(
      "SELECT id FROM links WHERE kind = 'video' AND fetch_status = 'ok' AND id NOT IN (SELECT link_id FROM link_media) ORDER BY saved_at DESC LIMIT ?",
    ).all(limit * 4);
    for (const c of cands) {
      if (started >= limit) break;
      const link = links.getLink(c.id);
      if (s.auto_download || findLocalSource(link)) {
        try { requestAnalysis(c.id, { download: s.auto_download }); started++; } catch { /* skip */ }
      }
    }
  }
  return { retried, started };
}
