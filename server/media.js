// Media downloads: video, audio and photos from a link, onto disk.
//
// yt-dlp does video and audio (YouTube, X, Instagram, TikTok, Audiomack and
// the other 1000+ sites it knows); gallery-dl picks up photo posts and
// carousels that yt-dlp cannot ("There is no video in this post"). A FIFO
// queue with concurrency one runs the downloads; cancelling kills the whole
// process tree. Progress is kept in memory and mirrored to the
// media_downloads table; metadata (title, caption, uploader, date) goes into
// the table too, never into sidecar files. A finished download can also be
// saved as a link (tag "descarga") so read_link and search find its caption.
//
// This module is the OWNER of the family's media service (Hoard Link services.md): media_download
// (sections, max_duration_s, max_height, dest_dir), media_info, media_subtitles and media_audio_for_asr
// are served to the other apps through the hub. Finding the tools, running them, the yt-dlp arguments,
// the progress parser, the failure classifier, the queue, the URL check and the subtitle parsers are
// the shared ones in ./hoard-commons/media.js; what stays here is Links' own: the table, the queue
// wiring, the settings, the link saving and the events.
//
// Restart policy: rows left in "downloading"/"processing" when the app was
// closed become "failed" (interrumpida al cerrar la app); rows still "queued"
// never started, so they are put back in the queue on the next boot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db, uid, now, getSetting, setSetting, isOpen } from "./db.js";
import * as links from "./links.js";
import { enqueueFetch, waitForFetch } from "./fetcher.js";
import { excerptOf, wordCount } from "./extract.js";
import * as family from "./hoard-link.js";
import { appLink } from "./public-url.js";
import { allowPrivateUrls } from "./net-policy.js";
import { evaluateUrl } from "./hoard-commons/web.js";
import {
  MediaError, setLanguage, INSTALL_COMMAND, installHint, resolveTool as resolveSharedTool, runProcess, runCapture,
  toolsStatus as toolsStatusShared, updateTools as updateToolsShared, resetToolsCache,
  detectPlatform as detectPlatformShared, PLATFORM_NAMES, FORMATS, QUALITIES, STATUSES, ACTIVE_STATUSES, COOKIE_BROWSERS, DEFAULT_MAX_ITEMS,
  fileKind, mimeOf, PARTIAL, cookieAttempts, buildYtdlpArgs, buildGalleryArgs, buildProbeArgs, parseYtdlpLine, ProgressTracker,
  explainFailure, etaSeconds, ytdlpAgeDays, parseCodecs, needsTranscode, normalizeMediaUrl as normalizePublicMediaUrl,
  MediaQueue, subtitleCues, cuesToText, ytdlpBaseArgs, cookieArgs,
} from "./hoard-commons/media.js";

// Links speaks Spanish to its user: the commons' messages come out in Spanish.
setLanguage("es");

export {
  resetToolsCache, PLATFORM_NAMES, FORMATS, QUALITIES, STATUSES, ACTIVE_STATUSES, COOKIE_BROWSERS, DEFAULT_MAX_ITEMS,
  fileKind, mimeOf, etaSeconds, ytdlpAgeDays,
};

// ---------------------------------------------------------------------------
// tools: the shared lookup, plus the sibling app's bin folder as one more candidate
// ---------------------------------------------------------------------------

const SIBLING_NAME = "Writers hoard desktop";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The Writers app's binaries folder (checked after $HOARD_HOME/bin and before PATH); LINKS_MEDIA_SIBLING_DIR overrides it, "0" or "off" turns it off. */
export function defaultSiblingDir(env = process.env) {
  const override = env.LINKS_MEDIA_SIBLING_DIR;
  if (override !== undefined && override !== "") {
    if (/^(0|off|no|false)$/i.test(override.trim())) return null;
    return path.resolve(override);
  }
  return path.resolve(ROOT, "..", SIBLING_NAME, "resources", "bin");
}

/** The shared resolveTool (HOARD_<NAME> / LINKS_<NAME> variables, $HOARD_HOME/bin, PATH, python module...) with the sibling folder as a candidate. */
export const resolveTool = (tool, options = {}) => resolveSharedTool(tool, { siblingDir: defaultSiblingDir(options.env || process.env), ...options });
const MEDIA_TOOLS = ["ytdlp", "gallerydl", "ffmpeg"];
/** What was found, for GET /api/media/tools and media_tools. */
export const toolsStatus = (options = {}) => toolsStatusShared({ tools: MEDIA_TOOLS, siblingDir: defaultSiblingDir(options.env || process.env), ...options });
export const updateTools = (options = {}) => updateToolsShared({ siblingDir: defaultSiblingDir(options.env || process.env), ...options });

// ---------------------------------------------------------------------------
// platforms and URLs
// ---------------------------------------------------------------------------

// The label stored in old rows stays "Otro (yt-dlp)" (the commons' own is English).
export const OTHER_PLATFORM = "Otro (yt-dlp)";

/** Label for the site a URL belongs to; unknown sites are still attempted by yt-dlp. */
export const detectPlatform = (url) => detectPlatformShared(url, { other: OTHER_PLATFORM });
export const isKnownPlatform = (url) => detectPlatform(url) !== OTHER_PLATFORM;

/**
 * A clean http(s) URL for a download, or a MediaError. Refused (shared rule, no DNS): other schemes, hosts without a dot, localhost,
 * *.local / *.internal and IP literals of this machine or a private network. LINKS_ALLOW_PRIVATE_URLS=1 lifts the address rule for a
 * server on the user's own network (the scheme and host-shape rules stay).
 */
export function normalizeMediaUrl(input) {
  if (!allowPrivateUrls()) return normalizePublicMediaUrl(input);
  let text = String(input ?? "").trim();
  if (!text) throw new MediaError("Falta la URL.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let parsed;
  try { parsed = new URL(text); } catch { throw new MediaError(`«${input}» no es una URL válida.`); }
  const host = parsed.hostname.toLowerCase();
  if (!/^https?:$/.test(parsed.protocol) || !host || !(host.includes(".") || host.startsWith("[") || host === "localhost")) {
    throw new MediaError(`«${input}» no es una URL http(s) válida.`);
  }
  return parsed.toString();
}

/** The part of the SSRF guard that needs DNS: a public-looking name that resolves to a private address. An unresolvable name passes (yt-dlp reports it). */
async function refusePrivateResolution(url) {
  if (allowPrivateUrls()) return;
  let reason = null;
  try {
    const verdict = await evaluateUrl(url, {});
    reason = verdict.kind === "policy" ? verdict.reason : null;
  } catch { reason = null; }
  if (reason) throw new MediaError(`«${url}» apunta a este equipo o a una red privada (${reason}); solo se pueden descargar páginas públicas.`);
}


const missingTool = (tool) => new MediaError(
  `No se encontró ${tool === "ytdlp" ? "yt-dlp" : tool === "gallerydl" ? "gallery-dl" : "ffmpeg"}. ${tool === "ffmpeg" ? installHint("ffmpeg") : `Instálalo con: ${INSTALL_COMMAND}`}`,
  { code: "BINARY_MISSING", status: 424 },
);

// ---------------------------------------------------------------------------
// settings and folders
// ---------------------------------------------------------------------------

export function defaultMediaDir() {
  const env = (process.env.LINKS_MEDIA_DIR || "").trim();
  return env || path.join(os.homedir(), "Downloads", "Links Hoard");
}

const cookiesFileSetting = () => {
  const fromEnv = (process.env.LINKS_COOKIES_FILE || "").trim();
  return String(getSetting("media.cookies_file", "") || fromEnv || "");
};

const cookieBrowsers = () => {
  const env = (process.env.LINKS_COOKIES_BROWSERS || "").split(",").map((b) => b.trim().toLowerCase()).filter(Boolean);
  return env.length ? env : COOKIE_BROWSERS;
};

/** The folder downloads go to: per-call override > setting media.dir > LINKS_MEDIA_DIR > ~/Downloads/Links Hoard. */
export function resolveMediaDir(override = "") {
  const chosen = String(override || "").trim() || String(getSetting("media.dir", "") || "").trim() || defaultMediaDir();
  if (!path.isAbsolute(chosen)) {
    throw new MediaError(`La carpeta de descargas debe ser una ruta absoluta (por ejemplo C:\\Users\\tu-usuario\\Downloads\\Links Hoard); recibido «${chosen}».`);
  }
  return path.normalize(chosen);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (error) {
    throw new MediaError(`No se pudo crear la carpeta de descargas «${dir}»: ${error.message}`, { status: 500 });
  }
}

export function getMediaSettings() {
  const custom = String(getSetting("media.dir", "") || "");
  return {
    dir: resolveMediaDir(),
    dir_is_default: !custom,
    default_dir: defaultMediaDir(),
    cookies_file: String(getSetting("media.cookies_file", "") || ""),
    cookies_browsers: cookieBrowsers(),
    auto_update: autoUpdateEnabled(),
    last_auto_update: getSetting("media.last_auto_update_result", null),
  };
}

export function setMediaSettings(input = {}) {
  const body = z.object({ dir: z.string().trim().max(1000).optional(), cookies_file: z.string().trim().max(1000).optional(), auto_update: z.boolean().optional() }).strict().parse(input);
  if (body.auto_update !== undefined) setSetting("media.auto_update", body.auto_update);
  if (body.dir !== undefined) {
    if (body.dir) { resolveMediaDir(body.dir); ensureDir(path.normalize(body.dir)); }
    setSetting("media.dir", body.dir ? path.normalize(body.dir) : "");
  }
  if (body.cookies_file !== undefined) {
    if (body.cookies_file) {
      if (!path.isAbsolute(body.cookies_file)) throw new MediaError("El archivo de cookies debe indicarse con una ruta absoluta.");
      if (!fs.existsSync(body.cookies_file)) throw new MediaError(`No existe el archivo de cookies «${body.cookies_file}».`);
    }
    setSetting("media.cookies_file", body.cookies_file);
  }
  return getMediaSettings();
}

export function safeName(text, max = 80) {
  let s = String(text || "").normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  s = s.slice(0, max).trim().replace(/[. ]+$/, "");
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(s)) s = `_${s}`;
  return s || "descarga";
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

const COLUMNS = new Set(["url", "platform", "format", "quality", "kind", "status", "progress", "speed", "eta", "detail", "title", "uploader",
  "upload_date", "description", "duration", "dir", "files", "total_bytes", "save_link", "playlist", "max_items", "link_id", "error",
  "cookies_request", "cookies_browser", "started_at", "finished_at", "sections", "max_duration_s", "max_height", "asr"]);

const live = new Map(); // id -> patch not yet written (throttled mirror of progress)
const lastWrite = new Map();
let flushTimer = null;
const WRITE_EVERY_MS = 400;

function writeRow(id, patch) {
  if (!isOpen()) return;
  const keys = Object.keys(patch).filter((k) => COLUMNS.has(k));
  if (!keys.length) return;
  db().prepare(`UPDATE media_downloads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => (patch[k] === undefined ? null : patch[k])), id);
}

function flushLive() {
  flushTimer = null;
  for (const [id, patch] of live) { writeRow(id, patch); lastWrite.set(id, Date.now()); }
  live.clear();
}

/** Progress-only changes: kept in memory, written at most every 400 ms. */
function trickle(id, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  live.set(id, { ...(live.get(id) || {}), ...clean });
  if (Date.now() - (lastWrite.get(id) || 0) >= WRITE_EVERY_MS) flushLive();
  else if (!flushTimer) { flushTimer = setTimeout(flushLive, WRITE_EVERY_MS); flushTimer.unref?.(); }
  if (clean.progress !== undefined) jobProgress(id);
}

/** Any other change: pending progress goes out together with it. */
function patchRow(id, patch) {
  const pending = live.get(id) || {};
  live.delete(id);
  writeRow(id, { ...pending, ...patch });
  lastWrite.set(id, Date.now());
}

function parseRow(r) {
  if (!r) return null;
  let files = [];
  try { files = JSON.parse(r.files || "[]"); } catch { files = []; }
  let sections = [];
  try { sections = r.sections ? JSON.parse(r.sections) : []; } catch { sections = []; }
  return { ...r, files, sections, save_link: !!r.save_link, playlist: !!r.playlist, asr: !!r.asr };
}

function getRow(id) {
  if (!isOpen()) return null;
  const row = parseRow(db().prepare("SELECT * FROM media_downloads WHERE id = ?").get(id));
  if (!row) return null;
  const pending = live.get(id);
  return pending ? { ...row, ...pending } : row;
}

export function present(row) {
  if (!row) return null;
  return {
    id: row.id, url: row.url, platform: row.platform, format: row.format, quality: row.quality, kind: row.kind || null,
    status: row.status, progress: Math.round((row.progress || 0) * 10) / 10, speed: row.speed, eta: row.eta, detail: row.detail,
    title: row.title, uploader: row.uploader, upload_date: row.upload_date, description: row.description, duration: row.duration,
    dir: row.dir, files: row.files, total_bytes: row.total_bytes, save_link: row.save_link, playlist: row.playlist, max_items: row.max_items,
    link_id: row.link_id, error: row.error, cookies_browser: row.cookies_browser,
    sections: row.sections, max_duration_s: row.max_duration_s ?? null, max_height: row.max_height ?? null, asr: row.asr,
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
  };
}

export function getDownload(id) { return present(getRow(id)); }

export function listDownloads({ status = "", limit = 50 } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const params = [];
  let where = "";
  const wanted = String(status || "").trim();
  if (wanted === "active") { where = `WHERE status IN ('queued','downloading','processing')`; }
  else if (wanted === "finished") { where = `WHERE status IN ('done','failed','cancelled')`; }
  else if (wanted) {
    if (!STATUSES.includes(wanted)) throw new MediaError(`Estado no válido «${wanted}». Usa: ${STATUSES.join(", ")}, active o finished.`);
    where = "WHERE status = ?"; params.push(wanted);
  }
  const rows = db().prepare(`SELECT id FROM media_downloads ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, max);
  const total = db().prepare(`SELECT COUNT(*) AS n FROM media_downloads ${where}`).get(...params).n;
  return { total, items: rows.map((r) => getDownload(r.id)) };
}

// ---------------------------------------------------------------------------
// the queue, waiting and events
// ---------------------------------------------------------------------------

const queue = new MediaQueue();
const bus = new EventEmitter();
bus.setMaxListeners(0);
const post = new Set(); // link text tasks still running
let shuttingDown = false;

const isTerminal = (status) => ["done", "failed", "cancelled"].includes(status);

function terminal(id) { bus.emit("terminal", id); }

/** Resolves with the row once it is done, failed or cancelled, or when timeoutMs passes. */
export function waitForDownload(id, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const current = getRow(id);
    if (!current || isTerminal(current.status)) return resolve(present(current));
    let timer = null;
    const onTerminal = (doneId) => {
      if (doneId !== id) return;
      cleanup();
      resolve(getDownload(id));
    };
    const cleanup = () => { clearTimeout(timer); bus.off("terminal", onTerminal); };
    bus.on("terminal", onTerminal);
    timer = setTimeout(() => { cleanup(); resolve(getDownload(id)); }, timeoutMs);
    timer.unref?.();
  });
}

/** Wait until the queue is empty and every follow-up task (link text) is done. Used by shutdown and tests. */
export async function drainMedia(timeoutMs = 15_000) {
  await queue.idle(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (post.size && Date.now() < deadline) await Promise.race([...post, new Promise((r) => setTimeout(r, 50))]);
}

/** App is closing: kill the running download (it stays failed "interrumpida…"), leave queued ones queued for the next boot. */
export async function shutdownMedia() {
  shuttingDown = true;
  queue.cancelAll();
  await drainMedia(10_000);
  flushLive();
}

/** Boot: fix up rows left by a previous run and re-queue the ones that never started. */
export function initMedia() {
  shuttingDown = false;
  live.clear();
  lastWrite.clear();
  lastProgress.clear();
  const ts = now();
  db().prepare(`UPDATE media_downloads SET status = 'failed', error = 'Descarga interrumpida al cerrar la app.', finished_at = ?, speed = '', eta = '' WHERE status IN ('downloading','processing')`).run(ts);
  const waiting = db().prepare(`SELECT id FROM media_downloads WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC`).all();
  for (const { id } of waiting) queue.enqueue(id, (signal) => runDownload(id, signal));
  return { requeued: waiting.length };
}

// Canonical job events on the family bus: links.job.queued|started|progress|done|failed|cancelled with
// {job_id, title, kind: "download", progress 0..1, gpu, eta_s, url, error}. The download's own facts ride along (source_url,
// platform, format, media_kind, dir, files, bytes, link_id). The hub's older names (links.media.*) are not sent as well: it maps
// them to these, so both would count the same download twice.
const PROGRESS_EVERY_MS = 3000;
const lastProgress = new Map(); // id -> { at, progress }

function jobEvent(name, row, extra = {}) {
  if (!row) return;
  const progress = name === "done" ? 1 : Math.max(0, Math.min(1, (Number(row.progress) || 0) / 100));
  family.emit(`links.job.${name}`, {
    job_id: row.id, title: (row.title || row.url || "").slice(0, 200), kind: "download", progress, gpu: false,
    eta_s: name === "progress" || name === "started" ? etaSeconds(row.eta) : null,
    url: appLink("descargas"), error: extra.error || "",
    source_url: row.url, platform: row.platform, format: row.format, media_kind: row.kind || "",
    dir: row.dir, files: (row.files || []).length, bytes: row.total_bytes || 0, link_id: row.link_id || null,
  });
  if (["done", "failed", "cancelled"].includes(name)) lastProgress.delete(row.id);
}

/** A progress event at most every 3 s, and only when the number moved. */
function jobProgress(id) {
  const last = lastProgress.get(id);
  const t = Date.now();
  if (last && t - last.at < PROGRESS_EVERY_MS) return;
  const row = getRow(id);
  if (!row || row.status !== "downloading" || (last && Math.round(row.progress) === last.progress)) return;
  lastProgress.set(id, { at: t, progress: Math.round(row.progress) });
  jobEvent("progress", row);
}

// ---------------------------------------------------------------------------
// start, cancel, retry, remove
// ---------------------------------------------------------------------------

const sectionPair = z.tuple([z.number().min(0), z.number().positive()]).refine(([s, e]) => e > s, "Cada sección necesita 0 <= inicio < fin (segundos).");

const startInput = z.object({
  url: z.string().trim().min(1, "Falta la URL.").max(4000),
  format: z.enum(FORMATS).default("auto"),
  quality: z.preprocess((v) => (v === undefined || v === null || v === "" ? "best" : String(v)), z.enum(QUALITIES)).default("best"),
  dir: z.string().trim().max(1000).optional(),
  // alias of dir: the family clients send both
  dest_dir: z.string().trim().max(1000).optional(),
  save_link: z.boolean().default(true),
  playlist: z.boolean().default(false),
  max_items: z.number().int().min(1).max(500).default(DEFAULT_MAX_ITEMS),
  cookies_browser: z.string().trim().toLowerCase().regex(/^(?:auto|none|[a-z]+(?::\S+)?)$/, "Navegador no válido (firefox, chrome, edge, brave… o auto/none).").default("auto"),
  // the family service (services.md section 2)
  sections: z.array(sectionPair).max(10, "Como mucho 10 secciones.").optional(),
  max_duration_s: z.number().positive().max(7 * 24 * 3600).optional(),
  max_height: z.number().int().min(144).max(4320).optional(),
  asr: z.boolean().default(false),
});

/** Queue a download. Returns the row; with `existing: true` when the same download is already in progress. */
export function startDownload(input = {}) {
  const data = startInput.parse(input);
  const url = normalizeMediaUrl(data.url);
  const asr = data.asr;
  const wanted = data.dest_dir || data.dir;
  // speech-to-text audio goes to its own folder, away from what the person keeps
  const dir = asr && !wanted ? path.join(resolveMediaDir(), "asr") : resolveMediaDir(wanted);
  const format = asr ? "audio" : data.format;
  const sections = data.sections?.length ? JSON.stringify(data.sections) : "";
  const saveLink = asr ? false : data.save_link;
  const duplicate = db().prepare(
    `SELECT id FROM media_downloads WHERE url = ? AND format = ? AND quality = ? AND dir = ? AND sections = ? AND asr = ? AND COALESCE(max_height, 0) = ?
     AND status IN ('queued','downloading','processing') LIMIT 1`,
  ).get(url, format, data.quality, dir, sections, asr ? 1 : 0, data.max_height || 0);
  if (duplicate) return { ...getDownload(duplicate.id), existing: true };
  ensureDir(dir);
  const id = uid();
  db().prepare(
    `INSERT INTO media_downloads (id, url, platform, format, quality, status, dir, save_link, playlist, max_items, cookies_request, created_at,
       sections, max_duration_s, max_height, asr)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, detectPlatform(url), format, data.quality, dir, saveLink ? 1 : 0, data.playlist ? 1 : 0, data.max_items, data.cookies_browser, now(),
    sections, data.max_duration_s ?? null, data.max_height ?? null, asr ? 1 : 0);
  queue.enqueue(id, (signal) => runDownload(id, signal));
  jobEvent("queued", getRow(id));
  return { ...getDownload(id), existing: false };
}

export function cancelDownload(id) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  if (isTerminal(row.status)) return { ...present(row), already_finished: true };
  const how = queue.cancel(id);
  if (how === "pending") {
    patchRow(id, { status: "cancelled", error: "Cancelada antes de empezar.", finished_at: now(), speed: "", eta: "", detail: "" });
    jobEvent("cancelled", getRow(id));
    terminal(id);
  } else if (how === false) {
    // the row says it is running but nothing is: a leftover from a crash
    patchRow(id, { status: "cancelled", error: "Cancelada.", finished_at: now(), speed: "", eta: "", detail: "" });
    jobEvent("cancelled", getRow(id));
    terminal(id);
  }
  // how === "active": the runner notices the abort, kills the process tree and writes "cancelled"
  return { ...getDownload(id), cancelling: how === "active" };
}

export function retryDownload(id) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  if (ACTIVE_STATUSES.includes(row.status)) throw new MediaError("Esa descarga sigue en curso.", { status: 409 });
  patchRow(id, {
    status: "queued", progress: 0, speed: "", eta: "", detail: "", error: "", files: "[]", total_bytes: 0,
    started_at: null, finished_at: null, cookies_browser: "",
  });
  queue.enqueue(id, (signal) => runDownload(id, signal));
  jobEvent("queued", getRow(id));
  return getDownload(id);
}

/** Remove the record; with deleteFiles also the downloaded files (for real: Node has no recycle bin). */
export function removeDownload(id, { deleteFiles = false } = {}) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  if (ACTIVE_STATUSES.includes(row.status)) throw new MediaError("La descarga sigue en curso: cancélala antes de quitarla.", { status: 409 });
  const removed = [];
  if (deleteFiles) {
    for (const f of row.files) {
      try { fs.rmSync(f.path, { force: true }); removed.push(f.path); } catch { /* keep going */ }
      const parent = path.dirname(f.path);
      if (path.normalize(parent) !== path.normalize(row.dir)) { try { fs.rmdirSync(parent); } catch { /* not empty */ } }
    }
  }
  live.delete(id);
  db().prepare("DELETE FROM media_downloads WHERE id = ?").run(id);
  return { ok: true, id, files_deleted: removed };
}

// ---------------------------------------------------------------------------
// files and "show in folder"
// ---------------------------------------------------------------------------


/** The i-th produced file of a download, checked on disk. */
export function fileOf(id, index = 0) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  const file = row.files[Number(index) || 0];
  if (!file) throw new MediaError("Esa descarga no tiene ese archivo.", { status: 404 });
  let stat;
  try { stat = fs.statSync(file.path); } catch { throw new MediaError("El archivo ya no está en el disco (¿lo moviste o lo borraste?).", { status: 404 }); }
  if (!stat.isFile()) throw new MediaError("El archivo ya no está en el disco.", { status: 404 });
  return { ...file, size: stat.size, mime: mimeOf(file.path) };
}

export function revealCommand(file, platform = process.platform) {
  if (platform === "win32") return { cmd: "explorer.exe", args: [`/select,"${file}"`], verbatim: true };
  if (platform === "darwin") return { cmd: "open", args: ["-R", file], verbatim: false };
  return { cmd: "xdg-open", args: [path.dirname(file)], verbatim: false };
}

let revealRunner = (command) => {
  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: !!command.verbatim });
    child.on("error", () => {});
    child.unref();
  } catch { /* nothing to show */ }
};
/** Tests replace the function that actually opens the file manager. */
export function setRevealRunner(fn) { const old = revealRunner; revealRunner = fn || old; return old; }

export function revealDownload(id, index = 0) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  let target = row.files[Number(index) || 0]?.path;
  if (!target || !fs.existsSync(target)) target = fs.existsSync(row.dir) ? row.dir : null;
  if (!target) throw new MediaError("No hay nada que mostrar: la carpeta ya no existe.", { status: 404 });
  const command = revealCommand(target);
  revealRunner(command);
  return { ok: true, path: target, command: `${command.cmd} ${command.args.join(" ")}` };
}

// ---------------------------------------------------------------------------
// running yt-dlp / gallery-dl
// ---------------------------------------------------------------------------

const AUTH_NAMES = (attempts) => attempts.filter((a) => a.type === "browser").map((a) => a.name).join(", ");

/** Run fn once per cookie attempt: no cookies first, then the browsers, until one works. */
async function withCookieAttempts(request, fn) {
  const attempts = cookieAttempts(request, { cookiesFile: cookiesFileSetting(), browsers: cookieBrowsers() });
  let first = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return { value: await fn(attempts[i]), attempt: attempts[i] };
    } catch (error) {
      if (error.code === "CANCELLED" || error.fatal || error.code === "BINARY_MISSING" || error.code === "NO_FFMPEG") throw error;
      if (i === 0) first = error;
      if (i === 0 && !error.authLike) throw error;
      // an outdated yt-dlp gets updated (and the download repeated) before spending time on every browser's cookies
      if (i === 0 && error.outdatedLike && autoUpdateDue()) throw error;
    }
  }
  if (attempts.length > 1 && first) {
    first.message += ` Probé con las cookies de ${AUTH_NAMES(attempts)} y ninguna sirvió.`;
  }
  throw first;
}

function fileRecord(p) {
  let size = 0;
  try { size = fs.statSync(p).size; } catch { /* gone */ }
  return { path: p, name: path.basename(p), size, kind: fileKind(p) };
}

function newFilesSince(dir, sinceMs) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || PARTIAL.test(e.name) || e.name.endsWith(".json")) continue;
    const p = path.join(dir, e.name);
    try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* skip */ }
  }
  return out;
}

function removePartials(dir, stems) {
  for (const stem of stems) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(stem) && name.length > stem.length && PARTIAL.test(name)) {
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* in use */ }
      }
    }
  }
}

/** The quality yt-dlp is asked for: the lower of the requested one and max_height. */
export function effectiveQuality(quality, maxHeight) {
  const cap = Number(maxHeight) || 0;
  if (!cap) return quality || "best";
  if (!quality || quality === "best" || !/^\d+$/.test(String(quality))) return String(cap);
  return String(Math.min(Number(quality), cap));
}

/** "2 h 10 min", "20 min", "45 s". */
export function durationLabel(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

const sectionLabel = ([start, end]) => `${Math.round(start * 1000) / 1000}-${Math.round(end * 1000) / 1000}`;

/** What `-o` and the extra arguments of one run say: no sections, one section (named after its range) or several ([part N]). */
function sectionRuns(sections) {
  if (!sections?.length) return [{ extra: [] }];
  return sections.map((section, i) => ({
    section,
    extra: [
      "--download-sections", `*${section[0]}-${section[1]}`, "--force-keyframes-at-cuts",
      "-o", `%(title).120s [%(id)s] [${sections.length > 1 ? `part ${i + 1}` : sectionLabel(section)}].%(ext)s`,
    ],
  }));
}

/** yt-dlp options common to the probes: the shared base (--ignore-config, JS runtime) for the build found. */
const probeArgs = (ytdlp, url, cookie, playlist = false) => buildProbeArgs({ url, playlist, cookie, ytdlpVersion: ytdlp.version });

/**
 * yt-dlp --dump-single-json for one cookie attempt, parsed. The whole line is collected here: runProcess keeps only the last 64 KB of
 * output and the JSON of a long video (every format of every stream) is larger than that.
 */
async function ytdlpJson(ytdlp, url, cookie, { playlist = false, signal } = {}) {
  let text = "";
  const r = await runProcess(ytdlp.command, probeArgs(ytdlp, url, cookie, playlist), { signal, timeoutMs: 90_000, onStdoutLine: (line) => { text += line; } });
  if (r.code !== 0) throw explainFailure("yt-dlp", r.stderr, { code: r.code });
  try { return JSON.parse(text); } catch { throw new MediaError("yt-dlp no devolvió información legible sobre este enlace."); }
}

/** Refuse a video longer than the limit before downloading anything. */
async function checkDuration(row, ctx, cookie) {
  const limit = Number(row.max_duration_s) || 0;
  if (!limit || row.playlist) return;
  const info = await ytdlpJson(ctx.tools.ytdlp, row.url, cookie, { signal: ctx.signal });
  const duration = Number(info?.duration) || 0;
  if (duration && duration > limit) {
    throw Object.assign(new MediaError(`El vídeo dura ${durationLabel(duration)} (límite ${durationLabel(limit)}).`, { code: "TOO_LONG", status: 413 }), { fatal: true });
  }
}

async function ytdlpOnce(row, ctx, cookie) {
  const { ytdlp, ffmpeg } = ctx.tools;
  if (!ytdlp.found) throw missingTool("ytdlp");
  if (row.format === "audio" && !ffmpeg.found) {
    throw Object.assign(new MediaError(`Falta ffmpeg para extraer el audio en MP3. ${installHint("ffmpeg")}`, { code: "NO_FFMPEG", status: 424 }), { fatal: true });
  }
  await checkDuration(row, ctx, cookie);
  const runs = sectionRuns(row.sections);
  const produced = [];
  const metas = [];
  let partial = "";
  const startedMs = Date.now();
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const args = buildYtdlpArgs({
      url: row.url, format: row.format === "audio" ? "audio" : "video", quality: effectiveQuality(row.quality, row.max_height), dir: row.dir,
      playlist: row.playlist, maxItems: row.max_items, cookie, hasFfmpeg: ffmpeg.found,
      ffmpegPath: ffmpeg.found && !ffmpeg.command.args.length ? ffmpeg.command.cmd : null,
      ytdlpVersion: ytdlp.version, extra: run.extra,
    });
    const tracker = new ProgressTracker();
    const scale = (patch) => (runs.length > 1 && patch.progress !== undefined ? { ...patch, progress: Math.min(99, (index * 100 + patch.progress) / runs.length) } : patch);
    const before = produced.length;
    const result = await runProcess(ytdlp.command, args, {
      signal: ctx.signal,
      onStdoutLine: (line) => {
        const ev = parseYtdlpLine(line);
        if (!ev) return;
        if (ev.type === "sel") {
          const wasProcessing = tracker.processing;
          tracker.select(ev);
          const label = runs.length > 1 ? `Parte ${index + 1} de ${runs.length}. ${tracker.label}` : tracker.label;
          if (wasProcessing) patchRow(row.id, { status: "downloading", detail: label });
          else if (ev.count > 1 || runs.length > 1) trickle(row.id, { detail: label });
          if (ev.filename) ctx.partials.add(path.basename(ev.filename).replace(/\.[^.]+$/, ""));
          return;
        }
        if (ev.type === "meta") { metas.push(ev.data); if (ev.data.filepath) produced.push(ev.data.filepath); return; }
        if (ev.type === "already") { produced.push(ev.path); return; }
        const patch = tracker.update(ev);
        if (!patch) return;
        const out = scale(patch);
        if (out.status) patchRow(row.id, out); else trickle(row.id, out);
      },
    });
    const made = [...new Set(produced.slice(before))].filter((p) => fs.existsSync(p));
    if (result.code !== 0) {
      if (made.length && row.playlist) { partial = "Algunos elementos de la lista fallaron y se omitieron."; continue; }
      throw explainFailure("yt-dlp", result.stderr, { code: result.code });
    }
  }
  const files = [...new Set(produced)].filter((p) => fs.existsSync(p));
  if (!files.length) {
    const scanned = newFilesSince(row.dir, startedMs);
    if (!scanned.length) throw new MediaError("yt-dlp terminó pero no creó ningún archivo. Prueba de nuevo o actualiza yt-dlp desde la sección Herramientas.");
    files.push(...scanned);
  }
  return { files, metas, partial };
}

function pickMeta(metas, playlist) {
  const first = metas[0] || {};
  const many = metas.length > 1;
  return {
    title: (many && playlist ? first.playlist_title : "") || first.title || "",
    uploader: first.uploader || first.channel || "",
    upload_date: first.upload_date || "",
    description: first.description || "",
    duration: many ? metas.reduce((s, m) => s + (Number(m.duration) || 0), 0) || null : Number(first.duration) || null,
  };
}

async function viaYtdlp(row, ctx) {
  const { value, attempt } = await withCookieAttempts(row.cookies_request, (cookie) => ytdlpOnce(row, ctx, cookie));
  let files = value.files.map(fileRecord);
  if (row.asr) files = await toAsrWav(files, row, ctx);
  else if (row.format !== "audio") files = await ensurePlayable(files, row, ctx);
  const kind = row.format === "audio" || files.every((f) => f.kind === "audio") ? "audio" : files.every((f) => f.kind === "image") ? "image" : "video";
  return { files, meta: pickMeta(value.metas, row.playlist), kind, cookie: attempt, note: value.partial || "" };
}

// -- audio for speech to text: mono 16 kHz PCM WAV ---------------------------

/** Turn each downloaded audio file into `<name>.wav` (ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le) and remove the intermediate file. */
async function toAsrWav(files, row, ctx) {
  const out = [];
  for (const file of files) {
    const target = uniquePath(path.join(path.dirname(file.path), `${path.basename(file.path, path.extname(file.path))}.wav`));
    patchRow(row.id, { status: "processing", detail: "Preparando el audio para transcribir (WAV mono 16 kHz)…", speed: "", eta: "", progress: 95 });
    const temp = `${target}.hoard-tmp.mp4`;
    const r = await runProcess(ctx.tools.ffmpeg.command, ["-hide_banner", "-y", "-i", file.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", temp], { signal: ctx.signal });
    if (r.code !== 0 || !fs.existsSync(temp)) {
      fs.rmSync(temp, { force: true });
      throw explainFailure("ffmpeg", r.stderr, { code: r.code });
    }
    fs.renameSync(temp, target);
    if (path.normalize(file.path) !== path.normalize(target)) fs.rmSync(file.path, { force: true });
    out.push(fileRecord(target));
  }
  return out;
}

// -- H.264 / AAC so the file plays everywhere ------------------------------

async function ensurePlayable(files, row, ctx) {
  if (process.env.LINKS_MEDIA_TRANSCODE === "0" || !ctx.tools.ffmpeg.found) return files;
  const out = [];
  for (const file of files) {
    if (file.kind !== "video") { out.push(file); continue; }
    try {
      const probe = await runCapture(ctx.tools.ffmpeg.command, ["-hide_banner", "-i", file.path], { signal: ctx.signal, timeoutMs: 30_000 });
      if (probe.error?.code === "CANCELLED") throw probe.error;
      if (!needsTranscode(parseCodecs(probe.stderr))) { out.push(file); continue; }
      patchRow(row.id, { status: "processing", detail: "Convirtiendo a H.264/AAC para que se vea en todas partes…", speed: "", eta: "", progress: 99 });
      const temp = path.join(path.dirname(file.path), `${path.basename(file.path, path.extname(file.path))}.lh-h264.mp4`);
      const r = await runProcess(ctx.tools.ffmpeg.command, [
        "-hide_banner", "-y", "-i", file.path, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", temp,
      ], { signal: ctx.signal });
      if (r.code !== 0 || !fs.existsSync(temp)) {
        fs.rmSync(temp, { force: true });
        ctx.notes.push(`No se pudo convertir ${file.name} a H.264; se deja tal cual.`);
        out.push(file);
        continue;
      }
      const sameName = path.extname(file.path).toLowerCase() === ".mp4";
      const finalPath = sameName ? file.path : uniquePath(path.join(path.dirname(file.path), `${path.basename(file.path, path.extname(file.path))}.mp4`));
      fs.rmSync(file.path, { force: true });
      fs.renameSync(temp, finalPath);
      out.push(fileRecord(finalPath));
    } catch (error) {
      if (error.code === "CANCELLED") throw error;
      out.push(file);
    }
  }
  return out;
}

// -- gallery-dl ------------------------------------------------------------

function pickGalleryMeta(json) {
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const nested = (o, k) => (o && typeof o === "object" ? str(o[k]) : "");
  const date = str(json.date) || str(json.post_date) || str(json.upload_date) || (typeof json.taken_at_timestamp === "number" ? new Date(json.taken_at_timestamp * 1000).toISOString() : "");
  const m = date.match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
  const description = str(json.description) || str(json.content) || str(json.caption) || str(json.title);
  return {
    description,
    uploader: str(json.username) || str(json.uploader) || nested(json.author, "name") || nested(json.user, "name") || nested(json.owner, "username") || str(json.fullname) || str(json.owner),
    upload_date: m ? `${m[1]}${m[2]}${m[3]}` : "",
    title: str(json.title) || description.split(/\r?\n/)[0].slice(0, 120),
  };
}

function walkFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

async function galleryOnce(row, ctx, cookie, folder) {
  const { gallerydl } = ctx.tools;
  if (!gallerydl.found) throw missingTool("gallerydl");
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  let count = 0;
  const result = await runProcess(gallerydl.command, buildGalleryArgs({ url: row.url, dir: folder, cookie, maxItems: row.max_items }), {
    signal: ctx.signal,
    onStdoutLine: (line) => {
      if (!line || line.startsWith("#")) return;
      count += 1;
      trickle(row.id, { speed: `${count} archivo${count === 1 ? "" : "s"}`, detail: "Descargando fotos…", progress: Math.min(95, 5 + count * 5) });
    },
  });
  const all = walkFiles(folder);
  const media = all.filter((p) => !p.endsWith(".json"));
  if (!media.length) {
    const err = explainFailure("gallery-dl", result.stderr, { code: result.code });
    if (!err.unsupported && !err.authLike && result.code === 0) {
      // exit 0 and nothing downloaded: most likely it needs a logged-in session
      err.authLike = true;
      err.message = "gallery-dl no descargó ningún archivo. Si es contenido privado, inicia sesión en tu navegador o indica un archivo de cookies en Ajustes.";
    }
    throw err;
  }
  return { media, jsons: all.filter((p) => p.endsWith(".json")), partial: result.code !== 0 ? "Algunas imágenes fallaron y se omitieron." : "" };
}

async function viaGallery(row, ctx) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let folder = uniquePath(path.join(row.dir, safeName(`${row.platform.replace(/ \(.*\)$/, "")} ${stamp}`)));
  ctx.galleryFolder = folder;
  patchRow(row.id, { detail: "Descargando fotos con gallery-dl…" });
  const { value, attempt } = await withCookieAttempts(row.cookies_request, (cookie) => galleryOnce(row, ctx, cookie, folder));
  let meta = { description: "", uploader: "", upload_date: "", title: "" };
  for (const j of value.jsons) {
    try { meta = pickGalleryMeta(JSON.parse(fs.readFileSync(j, "utf8"))); if (meta.description || meta.uploader) break; } catch { /* next */ }
  }
  for (const j of value.jsons) fs.rmSync(j, { force: true });
  // a readable folder name once we know who posted it
  const nice = safeName([meta.uploader, meta.description.split(/\r?\n/)[0].slice(0, 50)].filter(Boolean).join(" - ") || path.basename(folder), 90);
  const renamed = nice === path.basename(folder) ? folder : uniquePath(path.join(row.dir, nice));
  let media = value.media;
  if (path.normalize(renamed) !== path.normalize(folder)) {
    try {
      fs.renameSync(folder, renamed);
      media = media.map((p) => path.join(renamed, path.relative(folder, p)));
      folder = renamed;
      ctx.galleryFolder = folder;
    } catch { /* keep the first name */ }
  }
  const files = media.map(fileRecord);
  const kind = files.every((f) => f.kind === "video") ? "video" : "image";
  return { files, meta: { ...meta, duration: null }, kind, cookie: attempt, note: value.partial };
}

async function perform(row, ctx) {
  await refusePrivateResolution(row.url);
  const [ytdlp, gallerydl, ffmpeg] = await Promise.all([resolveTool("ytdlp"), resolveTool("gallerydl"), resolveTool("ffmpeg")]);
  ctx.tools = { ytdlp, gallerydl, ffmpeg };
  ensureDir(row.dir);
  if (row.format === "image") return await viaGallery(row, ctx);
  try {
    return await viaYtdlp(row, ctx);
  } catch (error) {
    if (row.format !== "auto" || error.code === "CANCELLED" || !(error.noVideo || error.unsupported)) throw error;
    if (!gallerydl.found) {
      if (error.noVideo) {
        throw new MediaError(`Es una publicación de fotos y falta gallery-dl para descargarlas. Instálalo con: ${INSTALL_COMMAND}`, { code: "BINARY_MISSING", status: 424 });
      }
      throw error;
    }
    patchRow(row.id, { detail: "No hay vídeo: probando con gallery-dl (fotos)…", status: "downloading" });
    try {
      return await viaGallery(row, ctx);
    } catch (galleryError) {
      if (galleryError.code === "CANCELLED") throw galleryError;
      if (error.unsupported && galleryError.unsupported) {
        throw new MediaError("Ni yt-dlp ni gallery-dl reconocen esta dirección. Comprueba que el enlace lleva a un contenido concreto.");
      }
      throw galleryError;
    }
  }
}

// ---------------------------------------------------------------------------
// the runner for one queued download
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// keeping yt-dlp current on its own (setting media.auto_update, default on)
// ---------------------------------------------------------------------------

const AUTO_UPDATE_EVERY_MS = 6 * 3600_000; // at most one automatic update attempt every 6 hours
const STALE_AFTER_DAYS = 45; // a yt-dlp build older than this is refreshed before downloading (LINKS_MEDIA_STALE_DAYS)
const staleAfterDays = () => Number(process.env.LINKS_MEDIA_STALE_DAYS) || STALE_AFTER_DAYS;

export function autoUpdateEnabled() {
  if (process.env.LINKS_MEDIA_AUTO_UPDATE === "0") return false;
  return getSetting("media.auto_update", true) !== false;
}

function autoUpdateDue() {
  if (!autoUpdateEnabled()) return false;
  const last = Number(getSetting("media.last_auto_update", 0)) || 0;
  return Date.now() - last >= AUTO_UPDATE_EVERY_MS;
}

/** Updates yt-dlp at most once per AUTO_UPDATE_EVERY_MS; resolves true when a newer version is now in place. */
async function autoUpdateYtdlp(id, why) {
  if (!autoUpdateDue()) return false;
  setSetting("media.last_auto_update", Date.now());
  patchRow(id, { detail: `Actualizando yt-dlp (${why})…` });
  try {
    const { results } = await updateTools({ tools: ["ytdlp"] });
    const r = results[0] || {};
    setSetting("media.last_auto_update_result", { at: now(), why, ok: !!r.ok, before: r.before || "", after: r.after || "", error: r.error || "" });
    return !!(r.ok && r.updated);
  } catch (error) {
    setSetting("media.last_auto_update_result", { at: now(), why, ok: false, error: String(error.message || error).slice(0, 300) });
    return false;
  }
}

async function runDownload(id, signal) {
  const row = getRow(id);
  if (!row || row.status !== "queued") return;
  const ctx = { signal, tools: null, partials: new Set(), notes: [], galleryFolder: "" };
  patchRow(id, { status: "downloading", started_at: now(), finished_at: null, progress: 0, speed: "", eta: "", detail: "Preparando…", error: "" });
  jobEvent("started", getRow(id));
  try {
    let out;
    if (row.format !== "image" && autoUpdateEnabled()) {
      const yt = await resolveTool("ytdlp");
      const age = yt.found ? ytdlpAgeDays(yt.version) : null;
      if (age !== null && age > staleAfterDays() && await autoUpdateYtdlp(id, `versión de hace ${age} días`)) {
        ctx.notes.push(`yt-dlp actualizado antes de descargar (tenía ${age} días).`);
      }
    }
    try {
      out = await perform(row, ctx);
    } catch (error) {
      if (!error.outdatedLike || signal.aborted || error.code === "CANCELLED") throw error;
      if (!(await autoUpdateYtdlp(id, "la descarga falló con la versión anterior"))) throw error;
      ctx.notes.push("yt-dlp se actualizó solo tras un fallo y la descarga se repitió.");
      patchRow(id, { detail: "Reintentando con yt-dlp actualizado…", progress: 0 });
      out = await perform(row, ctx);
    }
    const files = out.files;
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    const meta = out.meta;
    patchRow(id, {
      status: "processing", detail: "Guardando…", progress: 99, speed: "", eta: "",
      kind: out.kind, title: meta.title || path.basename(files[0]?.name || "", path.extname(files[0]?.name || "")),
      uploader: meta.uploader || "", upload_date: meta.upload_date || "", description: (meta.description || "").slice(0, 20000),
      duration: meta.duration ?? null, cookies_browser: out.cookie?.type === "browser" ? out.cookie.name : (out.cookie?.type === "file" ? "archivo de cookies" : ""),
      files: JSON.stringify(files), total_bytes: total,
    });
    let linkId = null;
    let linkTask = null;
    if (row.save_link) {
      try {
        const saved = saveAsLink(getRow(id), files);
        linkId = saved.id;
        linkTask = () => finishLinkText(saved.id, getRow(id), out.kind, saved.isNew);
      } catch (error) { ctx.notes.push(`No se pudo guardar el enlace: ${error.message}`); }
    }
    patchRow(id, {
      status: "done", progress: 100, speed: "", eta: "", link_id: linkId, finished_at: now(),
      detail: [out.note, ...ctx.notes].filter(Boolean).join(" "),
    });
    jobEvent("done", getRow(id));
    terminal(id);
    if (linkTask) {
      const task = linkTask().catch(() => {}).finally(() => post.delete(task));
      post.add(task);
    }
  } catch (error) {
    if (ctx.partials.size) removePartials(row.dir, ctx.partials);
    const aborted = signal.aborted || error.code === "CANCELLED";
    if (aborted) {
      if (ctx.galleryFolder) fs.rmSync(ctx.galleryFolder, { recursive: true, force: true });
      patchRow(id, shuttingDown
        ? { status: "failed", error: "Descarga interrumpida al cerrar la app.", finished_at: now(), speed: "", eta: "", detail: "" }
        : { status: "cancelled", error: "Cancelada.", finished_at: now(), speed: "", eta: "", detail: "" });
      jobEvent(shuttingDown ? "failed" : "cancelled", getRow(id), shuttingDown ? { error: "Descarga interrumpida al cerrar la app." } : {});
    } else {
      if (ctx.galleryFolder) { try { fs.rmdirSync(ctx.galleryFolder); } catch { /* has files or gone */ } }
      patchRow(id, { status: "failed", error: error.message || String(error), finished_at: now(), speed: "", eta: "", detail: "" });
      jobEvent("failed", getRow(id), { error: String(error.message || error).slice(0, 300) });
    }
    terminal(id);
  }
}

// ---------------------------------------------------------------------------
// the library link
// ---------------------------------------------------------------------------

/** Save the URL as a link (tag "descarga", source "download") with a note saying where the files are. */
function saveAsLink(row, files) {
  const where = files.length === 1 ? files[0].path : (path.dirname(files[0].path) === path.normalize(row.dir) ? files.map((f) => f.path).join("; ") : path.dirname(files[0].path));
  const note = `Descargado en ${where}`;
  const created = links.createLink({ url: row.url, tags: ["descarga"], note, source: "download" });
  if (created.existing) {
    const link = created.link;
    links.updateLink(link.id, { tags: [...new Set([...link.tags, "descarga"])], notes: [link.notes, note].filter(Boolean).join("\n").slice(0, 20000) });
    return { id: link.id, isNew: false };
  }
  enqueueFetch(created.link.id, created.link.url);
  return { id: created.link.id, isNew: true };
}

/** Wait for the page fetch, then fill in caption, title and kind where the page gave nothing. */
async function finishLinkText(linkId, row, kind, isNew) {
  for (let i = 0; i < 3; i++) {
    await waitForFetch(linkId, 8_000);
    const link = links.getLink(linkId);
    if (!link) return;
    if (link.fetch_status === "pending" && i < 2) continue;
    const patch = {};
    if (isNew || link.kind === "other") patch.kind = kind;
    if (!link.title && row.title) patch.title = row.title;
    if (!link.byline && row.uploader) patch.byline = row.uploader;
    if (!link.content_text) {
      const text = (row.description || [row.title, row.uploader && `Publicado por ${row.uploader}`].filter(Boolean).join("\n")).trim();
      if (text) {
        Object.assign(patch, { content_text: text, excerpt: excerptOf(text), word_count: wordCount(text), fetch_status: "ok", fetch_error: "" });
        if (!link.description && row.description) patch.description = row.description.slice(0, 2000);
      }
    }
    if (Object.keys(patch).length) links.applyFetchResult(linkId, patch);
    return;
  }
}

// ---------------------------------------------------------------------------
// probe: what is behind a link, without downloading
// ---------------------------------------------------------------------------

const probeInput = z.object({ url: z.string().trim().min(1), playlist: z.boolean().default(false), cookies_browser: startInput.shape.cookies_browser });

/** Language codes of the manual and the automatic captions, deduplicated (manual first). */
function captionLangs(info) {
  const manual = Object.keys(info.subtitles || {}).filter((k) => k !== "live_chat");
  const auto = Object.keys(info.automatic_captions || {}).filter((k) => k !== "live_chat");
  return { manual, auto, all: [...new Set([...manual, ...auto])] };
}

export async function probeUrl(input = {}) {
  const data = probeInput.parse(input);
  const url = normalizeMediaUrl(data.url);
  await refusePrivateResolution(url);
  const platform = detectPlatform(url);
  const [ytdlp, gallerydl] = await Promise.all([resolveTool("ytdlp"), resolveTool("gallerydl")]);
  if (!ytdlp.found) throw missingTool("ytdlp");
  let info;
  try {
    ({ value: info } = await withCookieAttempts(data.cookies_browser, (cookie) => ytdlpJson(ytdlp, url, cookie, { playlist: data.playlist })));
  } catch (error) {
    if (!(error.noVideo || error.unsupported)) throw error;
    if (!gallerydl.found) {
      if (error.noVideo) return { url, platform, photo_post: true, is_playlist: false, note: `Es una publicación de fotos; para descargarla hace falta gallery-dl (${INSTALL_COMMAND}).` };
      throw error;
    }
    const g = await runCapture(gallerydl.command, ["-j", "--range", "1-200", "--", url], { timeoutMs: 90_000 });
    let parsed = null;
    try { parsed = JSON.parse(g.stdout); } catch { parsed = null; }
    if (g.code !== 0 && !Array.isArray(parsed)) throw explainFailure("gallery-dl", g.stderr, { code: g.code });
    const entries = Array.isArray(parsed) ? parsed : [];
    const metas = entries.map((e) => (Array.isArray(e) ? e.find((x) => x && typeof x === "object" && !Array.isArray(x)) : null)).filter(Boolean).map(pickGalleryMeta);
    const m = metas.find((x) => x.uploader || x.description) || { title: "", uploader: "", upload_date: "", description: "" };
    return {
      url, platform, photo_post: true, is_playlist: false, files: entries.filter((e) => Array.isArray(e) && e[0] === 3).length || null,
      title: m.title, uploader: m.uploader, upload_date: m.upload_date, description: m.description,
      note: "Publicación de fotos: usa format image (o auto) para descargarla.",
    };
  }
  const isPlaylist = info._type === "playlist" && Array.isArray(info.entries);
  const heights = [...new Set((info.formats || []).map((f) => f.height).filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => b - a);
  const thumbnail = typeof info.thumbnail === "string" && /^https?:/i.test(info.thumbnail) ? info.thumbnail
    : [...(info.thumbnails || [])].reverse().map((t) => t?.url).find((u) => typeof u === "string" && /^https?:/i.test(u)) || "";
  return {
    url, platform, photo_post: false,
    id: String(info.id || ""), extractor: String(info.extractor_key || info.extractor || ""),
    title: info.title || "", uploader: info.uploader || info.channel || info.uploader_id || "", upload_date: info.upload_date || "",
    duration: Number(info.duration) || null, description: String(info.description || "").slice(0, 2000),
    thumbnail, subtitle_langs: captionLangs(info).all, is_live: !!(info.is_live || info.live_status === "is_live"),
    heights, has_audio: (info.formats || []).some((f) => f.acodec && f.acodec !== "none") || !(info.formats || []).length,
    is_playlist: isPlaylist, entries: isPlaylist ? info.entries.length : undefined,
    entry_titles: isPlaylist ? info.entries.slice(0, 10).map((e) => e?.title || e?.id || "") : undefined,
  };
}

// ---------------------------------------------------------------------------
// subtitles: the captions of a video as text with timing, without downloading it
// ---------------------------------------------------------------------------

const subtitlesInput = z.object({
  url: z.string().trim().min(1),
  langs: z.array(z.string().trim().min(1).max(20)).min(1).max(10).default(["es", "en"]),
  cookies_browser: startInput.shape.cookies_browser,
});

/** The caption track for the first wanted language: manual before automatic; "es" also matches "es-419", "es-ES"... */
export function pickCaptionTrack(info, langs) {
  const { manual, auto } = captionLangs(info);
  for (const wanted of langs) {
    const w = wanted.toLowerCase();
    const same = (key) => key.toLowerCase() === w || key.toLowerCase().startsWith(`${w}-`);
    const m = manual.find(same);
    if (m) return { lang: m, source: "manual" };
    const a = auto.find(same);
    if (a) return { lang: a, source: "auto" };
  }
  return null;
}

/** { text, lang, source: "manual"|"auto", cues: [{start_s, end_s, text}] } for the first of `langs` that has captions. */
export async function getSubtitles(input = {}) {
  const data = subtitlesInput.parse(input);
  const url = normalizeMediaUrl(data.url);
  await refusePrivateResolution(url);
  const ytdlp = await resolveTool("ytdlp");
  if (!ytdlp.found) throw missingTool("ytdlp");
  const work = async (cookie) => {
    const info = await ytdlpJson(ytdlp, url, cookie);
    const track = pickCaptionTrack(info, data.langs);
    if (!track) {
      const available = captionLangs(info).all;
      throw Object.assign(new MediaError(`No hay subtítulos en ${data.langs.join(", ")}${available.length ? ` (disponibles: ${available.join(", ")})` : " (el vídeo no tiene subtítulos)"}.`, { code: "NO_SUBTITLES", status: 404 }), { fatal: true });
    }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "links-subs-"));
    try {
      const args = [
        ...ytdlpBaseArgs({ version: ytdlp.version }),
        "--skip-download", "--no-warnings", "--no-playlist", track.source === "manual" ? "--write-subs" : "--write-auto-subs",
        "--sub-langs", track.lang, "--sub-format", "vtt", ...cookieArgs(cookie), "-P", folder, "-o", "sub.%(ext)s", "--", url,
      ];
      const r = await runProcess(ytdlp.command, args, { timeoutMs: 90_000 });
      const file = fs.readdirSync(folder).find((n) => n.endsWith(".vtt"));
      if (!file) {
        if (r.code !== 0) throw explainFailure("yt-dlp", r.stderr, { code: r.code });
        throw Object.assign(new MediaError("yt-dlp no descargó el archivo de subtítulos.", { code: "NO_SUBTITLES", status: 404 }), { fatal: true });
      }
      const cues = subtitleCues(fs.readFileSync(path.join(folder, file), "utf8"));
      return { text: cuesToText(cues), lang: track.lang, source: track.source, cues: cues.map((c) => ({ start_s: c.start_s, end_s: c.end_s, text: c.text })) };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  };
  return (await withCookieAttempts(data.cookies_browser, work)).value;
}
