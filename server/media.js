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
// Restart policy: rows left in "downloading"/"processing" when the app was
// closed become "failed" (interrumpida al cerrar la app); rows still "queued"
// never started, so they are put back in the queue on the next boot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { z } from "zod";
import { db, uid, now, getSetting, setSetting, isOpen } from "./db.js";
import * as links from "./links.js";
import { enqueueFetch, waitForFetch } from "./fetcher.js";
import { excerptOf, wordCount } from "./extract.js";
import * as family from "./hoard-link.js";
import { MediaQueue } from "./media-queue.js";
import {
  MediaError, INSTALL_COMMAND, installHint, resolveTool, runProcess, runCapture, toolsStatus, updateTools, resetToolsCache,
} from "./media-tools.js";

export { toolsStatus, updateTools, resetToolsCache };

// ---------------------------------------------------------------------------
// platforms
// ---------------------------------------------------------------------------

const PLATFORMS = [
  ["YouTube", ["youtube.com", "youtu.be", "youtube-nocookie.com"]],
  ["X (Twitter)", ["twitter.com", "x.com", "t.co", "fxtwitter.com", "vxtwitter.com", "fixupx.com"]],
  ["Instagram", ["instagram.com", "instagr.am"]],
  ["TikTok", ["tiktok.com"]],
  ["Audiomack", ["audiomack.com"]],
  ["SoundCloud", ["soundcloud.com", "snd.sc"]],
  ["Vimeo", ["vimeo.com"]],
  ["Twitch", ["twitch.tv"]],
  ["Reddit", ["reddit.com", "redd.it"]],
  ["Facebook", ["facebook.com", "fb.watch", "fb.com"]],
  ["Bilibili", ["bilibili.com", "b23.tv"]],
  ["Dailymotion", ["dailymotion.com", "dai.ly"]],
  ["Bandcamp", ["bandcamp.com"]],
  ["Pinterest", ["pinterest.com", "pin.it"]],
  ["Threads", ["threads.net"]],
];
export const OTHER_PLATFORM = "Otro (yt-dlp)";
export const PLATFORM_NAMES = PLATFORMS.map(([name]) => name);

/** Label for the site a URL belongs to; unknown sites are still attempted by yt-dlp. */
export function detectPlatform(url) {
  let host = "";
  try { host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`).hostname.toLowerCase(); } catch { return OTHER_PLATFORM; }
  for (const [label, domains] of PLATFORMS) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return label;
  }
  return OTHER_PLATFORM;
}

export const isKnownPlatform = (url) => detectPlatform(url) !== OTHER_PLATFORM;

// ---------------------------------------------------------------------------
// formats, quality, arguments
// ---------------------------------------------------------------------------

export const FORMATS = ["auto", "video", "audio", "image"];
export const QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360"];
export const STATUSES = ["queued", "downloading", "processing", "done", "failed", "cancelled"];
export const ACTIVE_STATUSES = ["queued", "downloading", "processing"];
export const COOKIE_BROWSERS = ["firefox", "chrome", "edge", "brave", "chromium", "vivaldi", "opera"];
export const OUTPUT_TEMPLATE = "%(title).120s [%(id)s].%(ext)s";
export const DEFAULT_MAX_ITEMS = 50;

const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".ts"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".opus", ".ogg", ".oga", ".flac", ".wav", ".aac", ".wma"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif", ".bmp", ".tiff"]);
const PARTIAL = /(?:\.part(?:-Frag\d+)?|\.ytdl|\.temp(?:\.\w+)?|\.f(?:\d+|hls|dash|http)[\w-]*(?:\.\w+)?(?:\.part)?|\.lh-h264\.mp4)$/i;

export function fileKind(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (IMAGE_EXT.has(ext)) return "image";
  return "other";
}

/** yt-dlp -f expression: H.264 + AAC first (plays everywhere), then anything. */
export function videoSelector(quality = "best", hasFfmpeg = true) {
  const h = /^\d+$/.test(String(quality)) ? `[height<=${quality}]` : "";
  if (!hasFfmpeg) return `b[ext=mp4]${h}/b${h}/b`;
  return [`bv*[vcodec^=avc1]${h}+ba[ext=m4a]`, `b[ext=mp4]${h}`, `bv*${h}+ba`, `b${h}`, "b"].join("/");
}

/** One cookie attempt as yt-dlp arguments. */
export function cookieArgs(attempt) {
  if (!attempt || attempt.type === "none") return [];
  if (attempt.type === "file") return ["--cookies", attempt.path];
  return ["--cookies-from-browser", attempt.name];
}

/** The ordered cookie attempts for a request ("auto" | "none" | a browser name) and an optional cookies file. */
export function cookieAttempts(request = "auto", { cookiesFile = "", browsers = COOKIE_BROWSERS } = {}) {
  const r = String(request || "auto").trim().toLowerCase();
  if (r === "none") return [{ type: "none" }];
  if (r && r !== "auto") return [{ type: "browser", name: r }];
  if (cookiesFile) return [{ type: "file", path: cookiesFile }];
  return [{ type: "none" }, ...browsers.map((name) => ({ type: "browser", name }))];
}

export function buildYtdlpArgs({ url, format = "video", quality = "best", dir, playlist = false, maxItems = DEFAULT_MAX_ITEMS, cookie = null, hasFfmpeg = true, ffmpegPath = null, extra = [] }) {
  const args = [
    "--newline", "--no-colors", "--no-warnings", "--progress", "--windows-filenames", "--no-mtime",
    "--retries", "10", "--fragment-retries", "10", "--concurrent-fragments", "4",
    ...(playlist ? ["--yes-playlist", "--playlist-end", String(maxItems)] : ["--no-playlist"]),
    "-P", dir, "-o", OUTPUT_TEMPLATE,
  ];
  if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
  if (format === "audio") {
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata");
  } else {
    args.push("-f", videoSelector(quality, hasFfmpeg));
    if (hasFfmpeg) args.push("--merge-output-format", "mp4");
  }
  args.push(...cookieArgs(cookie));
  args.push(
    "--progress-template", "download:LHP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s",
    "--progress-template", "postprocess:LHPP|%(progress.postprocessor)s|%(progress.status)s",
    "--print", "before_dl:LHSEL|%(format_id)s|%(playlist_index)s|%(n_entries)s|%(filename)s",
    "--print", "after_move:LHMETA|%(.{id,title,uploader,channel,upload_date,description,duration,playlist_title,filepath})j",
    ...extra,
    "--", url,
  );
  return args;
}

export function buildGalleryArgs({ url, dir, cookie = null, maxItems = DEFAULT_MAX_ITEMS }) {
  return [...cookieArgs(cookie), "--write-metadata", "--no-mtime", "--range", `1-${maxItems}`, "-D", dir, "--", url];
}

export function buildProbeArgs({ url, playlist = false, cookie = null }) {
  return ["--dump-single-json", "--no-warnings", "--skip-download", ...(playlist ? ["--flat-playlist"] : ["--no-playlist"]), ...cookieArgs(cookie), "--", url];
}

// ---------------------------------------------------------------------------
// reading yt-dlp output
// ---------------------------------------------------------------------------

const num = (v) => { const n = Number(v); return v === undefined || v === "NA" || v === "" || !Number.isFinite(n) ? null : n; };

/** One stdout line of yt-dlp as an event, or null for lines we ignore. */
export function parseYtdlpLine(line) {
  const text = String(line);
  if (text.startsWith("LHP|")) {
    const p = text.split("|");
    return { type: "progress", downloaded: num(p[1]), total: num(p[2]), estimate: num(p[3]), speed: num(p[4]), eta: num(p[5]), status: p[6] || "downloading" };
  }
  if (text.startsWith("LHPP|")) {
    const p = text.split("|");
    return { type: "pp", name: p[1] || "", status: p[2] || "" };
  }
  if (text.startsWith("LHSEL|")) {
    const p = text.split("|");
    return { type: "sel", formatId: p[1] || "", index: num(p[2]), count: num(p[3]), filename: p.slice(4).join("|") };
  }
  if (text.startsWith("LHMETA|")) {
    try { return { type: "meta", data: JSON.parse(text.slice(7)) }; } catch { return null; }
  }
  const already = text.match(/^\[download\]\s+(.+?)\s+has already been downloaded/);
  if (already) return { type: "already", path: already[1] };
  return null;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bytesPerSecond;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

const PP_TEXT = {
  Merger: "Uniendo audio y vídeo…", FFmpegMerger: "Uniendo audio y vídeo…",
  ExtractAudio: "Extrayendo el audio (MP3)…", FFmpegExtractAudio: "Extrayendo el audio (MP3)…",
  Metadata: "Escribiendo metadatos…", FFmpegMetadata: "Escribiendo metadatos…",
  VideoRemuxer: "Reempaquetando el vídeo…", FFmpegVideoRemuxer: "Reempaquetando el vídeo…",
  MoveFiles: "Guardando el archivo…",
};

/**
 * Turns the progress events of one yt-dlp run into the numbers the UI shows.
 * A merged download has two streams (video + audio), a playlist has several
 * items; both are folded into a single 0–99 % bar (100 is set when done).
 */
export class ProgressTracker {
  constructor() {
    this.streams = 1;
    this.finished = 0;
    this.item = 1;
    this.items = 1;
    this.processing = false;
    this.last = 0;
    this.label = "Descargando…";
  }

  /** before_dl event: a new item (playlist entry) starts, with its stream count. */
  select(ev) {
    this.streams = Math.max(1, String(ev.formatId || "").split("+").length);
    this.finished = 0;
    this.item = ev.index || 1;
    this.items = ev.count || 1;
    this.processing = false;
    this.label = this.items > 1 ? `Elemento ${this.item} de ${this.items}…` : "Descargando…";
  }

  /** Returns the patch to store, or null when nothing changes. */
  update(ev) {
    if (ev.type === "progress") {
      const total = ev.total || ev.estimate || 0;
      const pct = total > 0 ? Math.min(1, (ev.downloaded || 0) / total) : 0;
      const within = ev.status === "finished" ? 1 : pct;
      if (ev.status === "finished") this.finished += 1;
      const stream = Math.min(this.streams, ev.status === "finished" ? this.finished : this.finished + within);
      const overall = ((this.item - 1) + stream / this.streams) / this.items;
      this.last = Math.max(this.last, Math.min(99, Math.round(overall * 1000) / 10));
      return { progress: this.last, speed: formatSpeed(ev.speed), eta: formatEta(ev.eta), detail: this.processing ? undefined : this.label };
    }
    if (ev.type === "pp" && ev.status === "started") {
      this.processing = true;
      return { status: "processing", detail: PP_TEXT[ev.name] || "Procesando…", speed: "", eta: "" };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// errors in plain Spanish
// ---------------------------------------------------------------------------

const RX = {
  noVideo: /there is no video in this post|no video could be found|no video formats? found|does not contain (?:a )?video|no video in this (?:post|tweet)/i,
  unsupported: /unsupported url|no suitable extractor|no extractor found/i,
  ffmpeg: /ffmpeg.*(?:not found|not installed|could not be found)|ffprobe and ffmpeg not found|requires ffmpeg|ffmpeg is required|ffmpeg or avconv/i,
  auth: /login required|log ?in|sign ?in|logged in|cookies|authenticat|private (?:video|account|post|tweet)|not a bot|rate[- ]limit|empty media response|restricted video|age[- ]restricted|confirm your age|members[- ]only|requires? (?:an )?account|nsfw|protected tweet|tweet is protected|\b40[13]\b|forbidden|autherror|authrequired/i,
  unavailable: /video unavailable|this video is (?:not available|unavailable|private)|has been removed|no longer available|been deleted|does not exist|http error 404|not found|geo[- ]restrict|not available in your country|NotFound/i,
  outdated: /no such option|unrecognized arguments|invalid (?:output )?template|unknown (?:output )?template|unsupported field|nsig extraction failed|unable to extract (?:uploader|video data|\w+ (?:data|info|player))/i,
  // YouTube and others answer 403 to an old yt-dlp's media requests: an update fixes it far more often than cookies
  blocked: /unable to download video data:? http error 403|requested format is not available|sabr|po token|signature (?:extraction|decipher)/i,
  network: /getaddrinfo|temporary failure in name|timed out|timeout|connection (?:reset|refused|aborted)|network is unreachable|unable to download (?:webpage|json)|ssl|certificate/i,
};

const lastLines = (text, n = 1) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n);
const errorLine = (text) => {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /\bERROR\b|\[error\]/i.test(l));
  return (marked.at(-1) || lines.at(-1) || "").replace(/^ERROR:\s*/i, "").slice(0, 240);
};

/** Classify the stderr of a failed run and build a MediaError with a message the user can act on. */
export function explainFailure(tool, stderr, { code = null } = {}) {
  const raw = String(stderr || "");
  const line = errorLine(raw);
  const flags = {};
  let message;
  let status = 400;
  if (RX.ffmpeg.test(raw)) {
    message = `Falta ffmpeg, necesario para unir o convertir audio y vídeo. ${installHint("ffmpeg")}`;
    flags.fatal = true;
    flags.code = "NO_FFMPEG";
  } else if (RX.noVideo.test(raw)) {
    message = "La publicación no contiene vídeo (es una foto o un carrusel).";
    flags.noVideo = true;
  } else if (RX.unsupported.test(raw)) {
    message = "Esta dirección no es compatible (URL no admitida). Comprueba que el enlace lleva a un vídeo, un audio o una publicación concreta.";
    flags.unsupported = true;
  } else if (tool === "yt-dlp" && RX.blocked.test(raw) && !/sign in|log ?in|private|age[- ]restricted|members[- ]only|not a bot/i.test(raw)) {
    message = "La plataforma rechazó la descarga (403). Suele deberse a un yt-dlp desactualizado: actualízalo (Descargas → Herramientas → Actualizar) o, si el vídeo es privado o con restricción de edad, inicia sesión en Firefox o Chrome.";
    flags.authLike = true;
    flags.outdatedLike = true;
  } else if (RX.auth.test(raw) || (tool === "gallery-dl" && code && (code & 16))) {
    message = "Este contenido necesita iniciar sesión (cuenta privada, restricción de edad o límite de la plataforma). Inicia sesión en Firefox o Chrome y vuelve a intentarlo, o indica un archivo de cookies en Ajustes. Si sigue fallando, actualiza yt-dlp (Descargas → Herramientas → Actualizar).";
    flags.authLike = true;
  } else if (RX.outdated.test(raw)) {
    flags.outdatedLike = true;
    message = "Es probable que yt-dlp esté desactualizado (las plataformas cambian a menudo). Actualízalo desde Descargas → Herramientas → Actualizar, o con: python -m pip install -U yt-dlp.";
  } else if (RX.unavailable.test(raw)) {
    message = "El contenido no está disponible: es privado, se ha borrado o está bloqueado en tu país.";
  } else if (RX.network.test(raw)) {
    message = "No se pudo conectar con el sitio. Comprueba tu conexión e inténtalo de nuevo.";
    status = 502;
  } else {
    message = `${tool} falló${line ? `: ${line}` : code != null ? ` (código ${code})` : ""}.`;
    return Object.assign(new MediaError(message, { status, detail: line }), flags);
  }
  if (line && !flags.noVideo) message += ` Detalle: ${line}`;
  return Object.assign(new MediaError(message, { status, detail: line, code: flags.code || "MEDIA" }), flags);
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
  "cookies_request", "cookies_browser", "started_at", "finished_at"]);

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
  return { ...r, files, save_link: !!r.save_link, playlist: !!r.playlist };
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
  const ts = now();
  db().prepare(`UPDATE media_downloads SET status = 'failed', error = 'Descarga interrumpida al cerrar la app.', finished_at = ?, speed = '', eta = '' WHERE status IN ('downloading','processing')`).run(ts);
  const waiting = db().prepare(`SELECT id FROM media_downloads WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC`).all();
  for (const { id } of waiting) queue.enqueue(id, (signal) => runDownload(id, signal));
  return { requeued: waiting.length };
}

function emitFamily(type, row, extra = {}) {
  family.emit(type, {
    id: row.id, url: row.url, platform: row.platform, format: row.format, kind: row.kind || "", title: (row.title || "").slice(0, 200),
    dir: row.dir, files: (row.files || []).length, bytes: row.total_bytes || 0, link_id: row.link_id || null, ...extra,
  });
}

// ---------------------------------------------------------------------------
// start, cancel, retry, remove
// ---------------------------------------------------------------------------

const startInput = z.object({
  url: z.string().trim().min(1, "Falta la URL.").max(4000),
  format: z.enum(FORMATS).default("auto"),
  quality: z.preprocess((v) => (v === undefined || v === null || v === "" ? "best" : String(v)), z.enum(QUALITIES)).default("best"),
  dir: z.string().trim().max(1000).optional(),
  save_link: z.boolean().default(true),
  playlist: z.boolean().default(false),
  max_items: z.number().int().min(1).max(500).default(DEFAULT_MAX_ITEMS),
  cookies_browser: z.string().trim().toLowerCase().regex(/^(?:auto|none|[a-z]+(?::\S+)?)$/, "Navegador no válido (firefox, chrome, edge, brave… o auto/none).").default("auto"),
});

export function normalizeMediaUrl(input) {
  let text = String(input || "").trim();
  if (!text) throw new MediaError("Falta la URL.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let parsed;
  try { parsed = new URL(text); } catch { throw new MediaError(`«${input}» no es una URL válida.`); }
  const plainHost = parsed.hostname.includes(".") || parsed.hostname === "localhost" || /^\[/.test(parsed.hostname);
  if (!/^https?:$/.test(parsed.protocol) || !plainHost) {
    throw new MediaError(`«${input}» no es una URL http(s) válida.`);
  }
  return parsed.toString();
}

/** Queue a download. Returns the row; with `existing: true` when the same download is already in progress. */
export function startDownload(input = {}) {
  const data = startInput.parse(input);
  const url = normalizeMediaUrl(data.url);
  const dir = resolveMediaDir(data.dir);
  const duplicate = db().prepare(
    `SELECT id FROM media_downloads WHERE url = ? AND format = ? AND quality = ? AND dir = ? AND status IN ('queued','downloading','processing') LIMIT 1`,
  ).get(url, data.format, data.quality, dir);
  if (duplicate) return { ...getDownload(duplicate.id), existing: true };
  ensureDir(dir);
  const id = uid();
  db().prepare(
    `INSERT INTO media_downloads (id, url, platform, format, quality, status, dir, save_link, playlist, max_items, cookies_request, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, detectPlatform(url), data.format, data.quality, dir, data.save_link ? 1 : 0, data.playlist ? 1 : 0, data.max_items, data.cookies_browser, now());
  queue.enqueue(id, (signal) => runDownload(id, signal));
  return { ...getDownload(id), existing: false };
}

export function cancelDownload(id) {
  const row = getRow(id);
  if (!row) throw new MediaError("No existe esa descarga.", { status: 404 });
  if (isTerminal(row.status)) return { ...present(row), already_finished: true };
  const how = queue.cancel(id);
  if (how === "pending") {
    patchRow(id, { status: "cancelled", error: "Cancelada antes de empezar.", finished_at: now(), speed: "", eta: "", detail: "" });
    terminal(id);
  } else if (how === false) {
    // the row says it is running but nothing is: a leftover from a crash
    patchRow(id, { status: "cancelled", error: "Cancelada.", finished_at: now(), speed: "", eta: "", detail: "" });
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

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac", ".aac": "audio/aac",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
};
export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

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

async function ytdlpOnce(row, ctx, cookie) {
  const { ytdlp, ffmpeg } = ctx.tools;
  if (!ytdlp.found) throw missingTool("ytdlp");
  if (row.format === "audio" && !ffmpeg.found) {
    throw Object.assign(new MediaError(`Falta ffmpeg para extraer el audio en MP3. ${installHint("ffmpeg")}`, { code: "NO_FFMPEG", status: 424 }), { fatal: true });
  }
  const args = buildYtdlpArgs({
    url: row.url, format: row.format === "audio" ? "audio" : "video", quality: row.quality, dir: row.dir,
    playlist: row.playlist, maxItems: row.max_items, cookie, hasFfmpeg: ffmpeg.found,
    ffmpegPath: ffmpeg.found && !ffmpeg.command.args.length ? ffmpeg.command.cmd : null,
  });
  const tracker = new ProgressTracker();
  const produced = [];
  const metas = [];
  const startedMs = Date.now();
  const result = await runProcess(ytdlp.command, args, {
    signal: ctx.signal,
    onStdoutLine: (line) => {
      const ev = parseYtdlpLine(line);
      if (!ev) return;
      if (ev.type === "sel") {
        const wasProcessing = tracker.processing;
        tracker.select(ev);
        if (wasProcessing) patchRow(row.id, { status: "downloading", detail: tracker.label });
        else if (ev.count > 1) trickle(row.id, { detail: tracker.label });
        if (ev.filename) ctx.partials.add(path.basename(ev.filename).replace(/\.[^.]+$/, ""));
        return;
      }
      if (ev.type === "meta") { metas.push(ev.data); if (ev.data.filepath) produced.push(ev.data.filepath); return; }
      if (ev.type === "already") { produced.push(ev.path); return; }
      const patch = tracker.update(ev);
      if (!patch) return;
      if (patch.status) patchRow(row.id, patch); else trickle(row.id, patch);
    },
  });
  const files = [...new Set(produced)].filter((p) => fs.existsSync(p));
  if (result.code !== 0) {
    if (files.length && row.playlist) {
      return { files, metas, partial: "Algunos elementos de la lista fallaron y se omitieron." };
    }
    throw explainFailure("yt-dlp", result.stderr, { code: result.code });
  }
  if (!files.length) {
    const scanned = newFilesSince(row.dir, startedMs);
    if (!scanned.length) throw new MediaError("yt-dlp terminó pero no creó ningún archivo. Prueba de nuevo o actualiza yt-dlp desde la sección Herramientas.");
    files.push(...scanned);
  }
  return { files, metas };
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
  if (row.format !== "audio") files = await ensurePlayable(files, row, ctx);
  const kind = row.format === "audio" || files.every((f) => f.kind === "audio") ? "audio" : files.every((f) => f.kind === "image") ? "image" : "video";
  return { files, meta: pickMeta(value.metas, row.playlist), kind, cookie: attempt, note: value.partial || "" };
}

// -- H.264 / AAC so the file plays everywhere ------------------------------

export function parseCodecs(stderr) {
  const text = String(stderr || "");
  let video = null;
  for (const m of text.matchAll(/Stream #\d+:\d+[^\n]*?: Video: ([A-Za-z0-9_]+)([^\n]*)/g)) {
    if (/attached pic/i.test(m[2])) continue;
    video = { codec: m[1].toLowerCase(), rest: m[2] };
    break;
  }
  const audio = text.match(/Stream #\d+:\d+[^\n]*?: Audio: ([A-Za-z0-9_]+)/);
  return { video, audio: audio ? audio[1].toLowerCase() : null };
}

export function needsTranscode({ video, audio }) {
  if (video && (video.codec !== "h264" || /yuv420p(?:10|12)|yuv4[24]{2}p|rgb|gbr/i.test(video.rest))) return true;
  if (audio && !["aac", "mp3"].includes(audio)) return true;
  return false;
}

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

/** Age in days of a yt-dlp version string (YYYY.MM.DD[.N]), or null when it is not a date. */
export function ytdlpAgeDays(version, today = new Date()) {
  const m = String(version || "").match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const built = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.floor((today.getTime() - built) / 86_400_000);
}

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
    emitFamily("links.media.done", getRow(id));
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
    } else {
      if (ctx.galleryFolder) { try { fs.rmdirSync(ctx.galleryFolder); } catch { /* has files or gone */ } }
      patchRow(id, { status: "failed", error: error.message || String(error), finished_at: now(), speed: "", eta: "", detail: "" });
      emitFamily("links.media.failed", getRow(id), { error: String(error.message || error).slice(0, 300) });
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

export async function probeUrl(input = {}) {
  const data = z.object({ url: z.string().trim().min(1), playlist: z.boolean().default(false), cookies_browser: startInput.shape.cookies_browser }).parse(input);
  const url = normalizeMediaUrl(data.url);
  const platform = detectPlatform(url);
  const [ytdlp, gallerydl] = await Promise.all([resolveTool("ytdlp"), resolveTool("gallerydl")]);
  if (!ytdlp.found) throw missingTool("ytdlp");
  const attempt = async (cookie) => {
    const r = await runProcess(ytdlp.command, buildProbeArgs({ url, playlist: data.playlist, cookie }), { timeoutMs: 90_000 });
    if (r.code !== 0) throw explainFailure("yt-dlp", r.stderr, { code: r.code });
    try { return JSON.parse(r.stdout); } catch { throw new MediaError("yt-dlp no devolvió información legible sobre este enlace."); }
  };
  let info;
  try {
    ({ value: info } = await withCookieAttempts(data.cookies_browser, attempt));
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
  return {
    url, platform, photo_post: false,
    title: info.title || "", uploader: info.uploader || info.channel || info.uploader_id || "", upload_date: info.upload_date || "",
    duration: Number(info.duration) || null, description: String(info.description || "").slice(0, 600),
    heights, has_audio: (info.formats || []).some((f) => f.acodec && f.acodec !== "none") || !(info.formats || []).length,
    is_playlist: isPlaylist, entries: isPlaylist ? info.entries.length : undefined,
    entry_titles: isPlaylist ? info.entries.slice(0, 10).map((e) => e?.title || e?.id || "") : undefined,
  };
}
