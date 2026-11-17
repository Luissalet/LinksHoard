// The pictures of a post that is not a video: a carousel of photos (Instagram, X, Threads, TikTok photo mode…) or a single photo.
//
// The digest of a link starts here: it asks yt-dlp what the link is made of (media.inspectPost: one slide per entry of a carousel,
// each photo slide with its picture) and, for a post with photos, collects the pictures in order, so that the same layers a video has
// (OCR, a description of each picture, a summary, a contact sheet) can be built over them. The pictures come from gallery-dl with the
// signed-in session when there is one, and from the pictures yt-dlp lists for each slide when there is not (the carousel of a public
// post reads without an account). The link may carry the slide the person opened (?img_index=7): it is kept so the digest can mark it.
//
// Everything is kept under <data>/video/<link id>/photos with a manifest, so asking again does not download the post again.
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import * as media from "./media.js";
import * as video from "./videoinsight.js";

export const MAX_PHOTOS = 40;
/** A picture whose long side is under this is a preview, not the photo: the originals are then asked of gallery-dl. */
export const SMALL_EDGE = 720;
const IMAGE_BYTES = 25 * 1024 * 1024;
const SLIDE_PARAMS = ["img_index", "image_index", "slide"];

/** The slide a link points at (Instagram's ?img_index=7 is the seventh), or null. */
export function imageIndexOf(...urls) {
  for (const raw of urls) {
    if (!raw) continue;
    let u;
    try { u = new URL(String(raw)); } catch { continue; }
    for (const key of SLIDE_PARAMS) {
      const n = Number.parseInt(u.searchParams.get(key) || "", 10);
      if (Number.isInteger(n) && n >= 1 && n <= 200) return n;
    }
  }
  return null;
}

export const photosDir = (id) => path.join(video.linkDir(id), "photos");
const manifestFile = (id) => path.join(photosDir(id), "photos.json");

const EXT_BY_TYPE = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/heic": ".heic" };
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".heic", ".tiff"]);

/** The longest side of a JPEG (0 when it cannot be told: other formats, a damaged file). */
const longSide = (file) => { const z = video.jpegSize(file); return Math.max(z.width || 0, z.height || 0); };

export const isImageFile = (file) => IMAGE_EXT.has(path.extname(file).toLowerCase());

/** A fingerprint of the set of pictures: their names and sizes, in order. */
export function fingerprintOf(files) {
  return files.map((f) => { let size = 0; try { size = fs.statSync(f.path).size; } catch { /* gone */ } return `${f.path}|${size}`; }).join(";");
}

function readManifest(id) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(id), "utf8"));
    if (!Array.isArray(m?.files) || !m.files.length) return null;
    if (!m.files.every((f) => f?.path && fs.existsSync(f.path))) return null;
    return m;
  } catch { return null; }
}

function writeManifest(id, manifest) {
  fs.mkdirSync(photosDir(id), { recursive: true });
  const tmp = `${manifestFile(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1), "utf8");
  fs.renameSync(tmp, manifestFile(id));
}

/** Photos the person already downloaded for this link (Descargas, format photos): { files, meta } or null. */
export function localPhotoDownload(link) {
  const rows = db().prepare(
    "SELECT id, files, title, uploader, upload_date, description, platform FROM media_downloads WHERE status = 'done' AND kind = 'image' AND asr = 0 AND (link_id = ? OR url = ? OR url = ?) ORDER BY finished_at DESC",
  ).all(link.id, link.url, link.url_original || link.url);
  for (const r of rows) {
    let files = [];
    try { files = JSON.parse(r.files || "[]"); } catch { files = []; }
    const kept = files.filter((f) => f?.path && fs.existsSync(f.path) && (f.kind === "image" || isImageFile(f.path)));
    if (kept.length) {
      return {
        files: kept.map((f, i) => ({ path: f.path, slide: i + 1, kind: "photo" })),
        meta: { title: r.title, uploader: r.uploader, upload_date: r.upload_date, description: r.description, platform: r.platform },
      };
    }
  }
  return null;
}

async function downloadImage(url, dest, { headers = {}, signal } = {}) {
  await media.refusePrivateResolution(url);
  const res = await fetch(url, {
    headers: { Accept: "image/*,*/*;q=0.5", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LinksHoard/1.0", ...(headers.Referer ? { Referer: headers.Referer } : {}) },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`la imagen respondió ${res.status}`);
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error(`no era una imagen (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > IMAGE_BYTES) throw new Error("imagen vacía o demasiado grande");
  const file = `${dest}${EXT_BY_TYPE[type] || ".jpg"}`;
  fs.writeFileSync(file, buf);
  return file;
}

/** The pictures yt-dlp lists for the slides of a post, downloaded in order (up to four at a time). { files, failed }. */
export async function downloadSlides(post, dir, { signal, detail } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const slides = post.slides.slice(0, MAX_PHOTOS);
  const out = new Array(slides.length).fill(null);
  let next = 0, done = 0;
  const lane = async () => {
    while (next < slides.length) {
      const i = next++;
      const slide = slides[i];
      if (!slide.image_url) continue;
      if (signal?.aborted) return;
      try {
        const file = await downloadImage(slide.image_url, path.join(dir, `slide-${String(slide.n).padStart(3, "0")}`), { headers: post.headers, signal });
        out[i] = { path: file, slide: slide.n, kind: slide.has_video ? "video" : "photo" };
      } catch { /* that slide is reported as missing */ }
      done++;
      detail?.(`Descargando las fotos (${done}/${slides.length})…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, slides.length) }, lane));
  const files = out.filter(Boolean);
  return { files, failed: slides.filter((s) => s.image_url).length - files.length };
}

/** Download the post through gallery-dl (the signed-in session, the originals). Returns the files in order, or null when it could not. */
async function viaGallery(link, dir, { signal, detail } = {}) {
  detail?.("Descargando las fotos con gallery-dl…");
  const started = media.startDownload({ url: link.url_original || link.url, format: "image", save_link: false, dest_dir: dir, max_items: MAX_PHOTOS });
  const onAbort = () => { try { media.cancelDownload(started.id); } catch { /* already over */ } };
  signal?.addEventListener("abort", onAbort, { once: true });
  let done;
  try { done = await media.waitForDownload(started.id, 10 * 60_000); } finally { signal?.removeEventListener("abort", onAbort); }
  if (!done || done.status !== "done") return { files: [], error: done?.error || "" };
  const files = (done.files || []).filter((f) => f?.path && fs.existsSync(f.path)).map((f, i) => ({ path: f.path, slide: i + 1, kind: f.kind === "video" ? "video" : "photo" }));
  return { files, meta: { title: done.title, uploader: done.uploader, upload_date: done.upload_date, description: done.description, platform: done.platform } };
}

const fill = (meta, over) => {
  const out = { ...(meta || {}) };
  for (const [k, v] of Object.entries(over || {})) if (v && !out[k]) out[k] = v;
  return out;
};

/**
 * What a link is for the digest. { kind: "photos", files: [{ path, slide, kind }], meta, via, focus, notes } for a post of pictures,
 * { kind: "video", meta } for a video (the meta read here is reused, so the link is not asked again), { kind: "unknown", error } when
 * yt-dlp could not say (the video path then reports its own failure). `force` downloads the pictures again.
 */
export async function acquire(link, { signal, detail, force = false } = {}) {
  const url = link.url_original || link.url;
  const focus = imageIndexOf(url, link.url);
  const notes = [];
  if (!force) {
    const kept = readManifest(link.id);
    if (kept) return { kind: "photos", files: kept.files, meta: kept.meta || {}, via: kept.via || "", focus, notes: kept.notes || [] };
    const local = localPhotoDownload(link);
    if (local) return { kind: "photos", files: local.files, meta: local.meta, via: "descarga guardada", focus, notes };
  }
  let post = null;
  let inspectError = null;
  try { post = await media.inspectPost({ url }, { signal }); } catch (e) { inspectError = e; }
  if (post && post.kind === "video") return { kind: "video", meta: post.meta };
  if (!post && !(inspectError?.noVideo || inspectError?.unsupported)) return { kind: "unknown", error: String(inspectError?.message || inspectError || "") };

  const dir = photosDir(link.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let files = [];
  let meta = post?.meta || {};
  let via = "";
  // The pictures the post lists come first: anonymous and quick. They are kept when they are the photos themselves; when they are
  // previews (listed small, or small once downloaded), or none could be had, gallery-dl is asked for the originals (the signed-in session).
  const thumbs = post?.photos ? await downloadSlides(post, path.join(dir, "slides"), { signal, detail }) : { files: [], failed: 0 };
  const listedSmall = !!post?.slides.some((s) => !s.has_video && s.image_url && s.width && Math.max(s.width, s.height) < SMALL_EDGE);
  const measuredSmall = thumbs.files.some((f) => f.kind === "photo" && (longSide(f.path) || Infinity) < SMALL_EDGE);
  const preview = listedSmall || measuredSmall;
  if (thumbs.files.length && !preview) {
    files = thumbs.files; via = "yt-dlp";
    if (thumbs.failed) notes.push(`No se pudieron descargar ${thumbs.failed} fotos de la publicación.`);
  } else {
    const g = await viaGallery(link, path.join(dir, "gallery"), { signal, detail });
    if (g.files.length) { files = g.files; via = "gallery-dl"; meta = fill(g.meta, meta); }
    else if (thumbs.files.length) {
      files = thumbs.files; via = "yt-dlp";
      notes.push("Las fotos son las que lista la publicación, a su tamaño de vista previa: con la sesión iniciada se descargan los originales.");
      if (thumbs.failed) notes.push(`No se pudieron descargar ${thumbs.failed} fotos de la publicación.`);
    } else {
      const why = g.error || inspectError?.message || "no se pudo descargar ninguna foto";
      throw Object.assign(new Error(`No se pudieron descargar las fotos de la publicación: ${why}`), { photos: true });
    }
  }
  files = files.slice(0, MAX_PHOTOS);
  const kept = { files, meta, via, notes, fetched_at: new Date().toISOString() };
  writeManifest(link.id, kept);
  return { kind: "photos", files, meta, via, focus, notes };
}
