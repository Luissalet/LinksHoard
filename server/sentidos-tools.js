// What the assistant and the UI can ask Sentidos: the sources (a file, a saved link, a URL), the eight worker tools with readable
// answers, the sound search over the digests, and the sound layer of a video digest. The worker itself is sentidos.js.
import fs from "node:fs";
import path from "node:path";
import { db, ftsEnabled, transaction, isOpen } from "./db.js";
import * as links from "./links.js";
import * as media from "./media.js";
import * as video from "./videoinsight.js";
import * as sentidos from "./sentidos.js";

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".mka"]);
const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".flv", ".wmv", ".3gp"]);
export const isSoundFile = (file) => { const e = path.extname(String(file || "")).toLowerCase(); return AUDIO_EXT.has(e) || VIDEO_EXT.has(e); };

const bad = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });
const fileOk = (p) => { try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; } };

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/** The sound file of a saved link: its analysed video, else its newest finished download that is audio or video. */
export function fileOfLink(id) {
  const m = video.getMedia(id);
  if (m && fileOk(m.source_path)) return m.source_path;
  const rows = db().prepare("SELECT id FROM media_downloads WHERE link_id = ? AND status = 'done' ORDER BY finished_at DESC, rowid DESC").all(id);
  for (const r of rows) {
    const d = media.getDownload(r.id);
    for (const f of d?.files || []) if (fileOk(f.path) && isSoundFile(f.path)) return f.path;
  }
  return null;
}

/**
 * One of: { path } an absolute file; { id } a saved link that has a download or an analysed video; { url } a link or page to
 * download (audio only) when it is not saved yet. Returns { path, label, link_id?, downloaded? }.
 */
export async function resolveSource({ path: p, id, url, timeoutS = 150 } = {}) {
  if (p) {
    const abs = path.resolve(String(p));
    if (!fileOk(abs)) throw bad(`No existe el archivo «${abs}».`, 404, "no_file");
    if (!isSoundFile(abs)) throw bad("Ese archivo no es de audio ni de vídeo.", 400, "not_sound");
    return { path: abs, label: path.basename(abs) };
  }
  let link = null;
  if (id) {
    link = links.getLink(id);
    if (!link) throw bad(`No existe un enlace con id «${id}».`, 404, "no_link");
  } else if (url) {
    link = links.getLinkByUrl(url);
  } else {
    throw bad("Indica path, id o url del sonido.", 400, "no_source");
  }
  if (link) {
    const file = fileOfLink(link.id);
    if (file) return { path: file, label: link.title || path.basename(file), link_id: link.id };
    if (id) throw bad("Ese enlace no tiene un audio o vídeo descargado: usa media_download primero (o pasa su url para bajarlo ahora).", 409, "no_media");
  }
  const started = media.startDownload({ url, format: "audio", save_link: true });
  const done = await media.waitForDownload(started.id, timeoutS * 1000);
  if (!done || done.status !== "done") {
    throw bad(done?.status === "failed" ? `No se pudo bajar el audio: ${done.error || "error desconocido"}` : "La descarga sigue en curso: vuelve a pedirlo cuando termine (media_status).", 409, "download");
  }
  const file = (done.files || []).map((f) => f.path).find((f) => fileOk(f) && isSoundFile(f));
  if (!file) throw bad("La descarga no produjo un archivo de audio.", 409, "no_media");
  return { path: file, label: done.title || path.basename(file), link_id: done.link_id || undefined, downloaded: true };
}

/** Audio and video files the library already has (for pickers and for searching by sound). Newest first. */
export function listSources({ limit = 60 } = {}) {
  const max = Math.max(1, Math.min(300, Number(limit) || 60));
  const rows = db().prepare("SELECT id FROM media_downloads WHERE status = 'done' ORDER BY finished_at DESC, rowid DESC LIMIT ?").all(max * 3);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const d = media.getDownload(r.id);
    for (const f of d?.files || []) {
      if (!fileOk(f.path) || !isSoundFile(f.path) || seen.has(f.path)) continue;
      seen.add(f.path);
      out.push({ path: f.path, name: path.basename(f.path), title: d.title || path.basename(f.path), link_id: d.link_id || undefined, size: f.size || undefined,
        kind: AUDIO_EXT.has(path.extname(f.path).toLowerCase()) ? "audio" : "video", duration: d.duration || undefined });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const sheetsDir = () => path.join(sentidos.sentidosHome(), "sheets");
export const sheetFile = (name) => {
  const clean = path.basename(String(name || ""));
  const file = path.join(sheetsDir(), clean);
  return /^[\w .,()\-\[\]]+\.png$/i.test(clean) && fileOk(file) ? file : null;
};
const slug = (s) => String(s || "sonido").replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").slice(0, 60) || "sonido";

const PASS = { describe: ["top", "start", "end"], match: ["query", "alts", "start", "end"], find: ["query", "kind", "win", "hop", "top", "start", "end"],
  timeline: ["start", "end", "detail"], measure: ["start", "end", "music", "light"], realness: ["start", "end", "ast"], sheet: ["start", "end", "detail"] };

/**
 * Run one worker tool on a source. Returns { ok, tool, source, text, data?, image? }; a worker failure comes back as { ok: false, error }.
 * `withData` adds the compact numbers (z-scores, segments) next to the readable text.
 */
export async function runTool(tool, input = {}, { withData = false } = {}) {
  const src = await resolveSource(input);
  const args = { path: src.path };
  for (const k of PASS[tool] || []) if (input[k] !== undefined && input[k] !== null && input[k] !== "") args[k] = input[k];
  if (tool === "sheet") {
    fs.mkdirSync(sheetsDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    args.out_png = path.join(sheetsDir(), `${slug(src.label)}-${stamp}.png`);
  }
  const r = await sentidos.callTool(tool, args);
  if (!r || r.ok === false) return { ok: false, tool, source: src, error: String(r?.error || "El análisis de sonido falló.") };
  const out = { ok: true, tool, source: src, text: r.text || r.summary || "" };
  if (tool === "sheet" && r.data?.png) { out.image = r.data.png; out.image_name = path.basename(r.data.png); out.width = r.data.width; out.height = r.data.height; }
  if (withData) out.data = r.data;
  return out;
}

/** Rank saved sound files by how much they sound like a description (the worker's rank tool, CLAP). */
export async function rankLibrary(query, { top = 10, limit = 30 } = {}) {
  const files = listSources({ limit }).map((s) => s.path);
  if (!files.length) return { ok: true, text: "No hay audios ni vídeos descargados que revisar.", ranked: [] };
  const r = await sentidos.callTool("rank", { paths: files, query, top });
  if (!r || r.ok === false) return { ok: false, error: String(r?.error || "No se pudo ordenar la biblioteca.") };
  return { ok: true, text: r.text || r.summary || "", checked: files.length, data: r.data };
}

// ---------------------------------------------------------------------------
// the sound layer of a video digest
// ---------------------------------------------------------------------------

const oneLine = (s, max = 220) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t; };

/** The compact model kept in digest.json: sections with their reading, the loudness and tempo, and the most exposed tagged events. */
export function soundModel(result, { start = 0, end = null, detail = "normal" } = {}) {
  const d = result.data || {};
  const sections = (d.sections || []).map((s) => ({
    start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, label: oneLine(s.label, 260),
    ast: (s.ast_top || []).slice(0, 4).map(([name, score]) => ({ name, score: Math.round(score * 100) / 100 })),
    lufs: typeof s.lufs === "number" ? Math.round(s.lufs * 10) / 10 : null,
  })).filter((s) => s.label || s.ast.length);
  const events = (d.events || []).filter((e) => e.label && e.exposed).sort((a, b) => (b.prominence_db || 0) - (a.prominence_db || 0)).slice(0, 24)
    .map((e) => ({ t: Math.round(e.t * 10) / 10, kind: e.kind || "", label: e.label, over_bed_db: Math.round(e.prominence_db || 0) })).sort((a, b) => a.t - b.t);
  const music = d.music?.tempo && d.music.confidence && d.music.confidence !== "none" ? { tempo: d.music.tempo, confidence: d.music.confidence } : null;
  return {
    status: "done", via: "sentidos", detail, span: [start, end ?? d.end ?? null],
    loudness: d.loudness ? { lufs: d.loudness.integrated_lufs, true_peak: d.loudness.true_peak_dbtp, lra: d.loudness.lra_lu ?? null } : null,
    music, sections, events, summary: oneLine(result.summary || result.text || "", 900),
  };
}

/** Run the timeline of a video's soundtrack for the digest; never throws: { status: "unavailable" | "failed", error } comes back instead. */
export async function analyzeSoundtrack(file, { durationS = 0, maxS = 1800, detail = "normal" } = {}) {
  if (!canListen()) return { status: "unavailable", error: "Sentidos no está instalado (Sentidos > Preparar)." };
  const end = durationS && durationS > maxS ? maxS : null;
  try {
    const r = await sentidos.callTool("timeline", { path: file, detail, full: true, ...(end ? { start: 0, end } : {}) }, { timeoutMs: 25 * 60_000 });
    if (!r || r.ok === false) return { status: "failed", error: String(r?.error || "falló el análisis de sonido") };
    const model = soundModel(r, { start: 0, end, detail });
    if (end) model.note = `Solo se analizaron los primeros ${Math.round(end / 60)} minutos.`;
    return model;
  } catch (e) {
    return { status: e.code === "not_installed" || e.code === "start_failed" ? "unavailable" : "failed", error: String(e.message || e).slice(0, 300) };
  }
}

/** True when something can answer a listening call: the installed worker (or a test runner). */
export const canListen = () => sentidos.isInstalled() || sentidos.hasRunner();

/** Index the sections of a sound model so that video_find can search what a video sounds like. */
export function replaceSounds(linkId, sound) {
  if (!isOpen()) return;
  transaction(() => {
    db().prepare("DELETE FROM link_sounds WHERE link_id = ?").run(linkId);
    if (ftsEnabled()) db().prepare("DELETE FROM link_sounds_fts WHERE link_id = ?").run(linkId);
    if (!sound || sound.status !== "done") return;
    const ins = db().prepare("INSERT INTO link_sounds (link_id, idx, start_s, end_s, label, detail) VALUES (?, ?, ?, ?, ?, ?)");
    const fts = ftsEnabled() ? db().prepare("INSERT INTO link_sounds_fts (text, link_id, idx) VALUES (?, ?, ?)") : null;
    sound.sections.forEach((s, i) => {
      const detail = s.ast.map((a) => a.name).join(", ");
      ins.run(linkId, i + 1, s.start, s.end, s.label, detail);
      const text = [s.label, detail].filter(Boolean).join("\n");
      if (fts && text) fts.run(text, linkId, i + 1);
    });
  });
}

/** Search the indexed soundtracks of the digests by words ("orchestral", "piano", "bird"). */
export function searchSounds(query, { id = null, limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  const quoted = `"${q.replace(/"/g, '""')}"`;
  const sql = ftsEnabled()
    ? `SELECT s.link_id, s.idx, s.start_s, s.end_s, s.label, s.detail FROM link_sounds_fts f JOIN link_sounds s ON s.link_id = f.link_id AND s.idx = f.idx
        WHERE link_sounds_fts MATCH ? ${id ? "AND s.link_id = ?" : ""} ORDER BY rank LIMIT ?`
    : `SELECT link_id, idx, start_s, end_s, label, detail FROM link_sounds WHERE (label LIKE ? OR detail LIKE ?) ${id ? "AND link_id = ?" : ""} LIMIT ?`;
  const params = ftsEnabled() ? [quoted] : [`%${q}%`, `%${q}%`];
  const rows = db().prepare(sql).all(...params, ...(id ? [id] : []), max);
  return rows.map((r) => ({ link_id: r.link_id, title: links.getLink(r.link_id)?.title || "", where: "sound", ref: `a${r.idx}`, start_s: r.start_s, end_s: r.end_s, label: r.label, also: r.detail || undefined }));
}
