// REST routes for video insight (transcript + key frames of a saved video link), behind the same guard as the rest of /api.
import fs from "node:fs";
import * as links from "./links.js";
import * as video from "./videoinsight.js";

const notFound = (res, what = "No existe.") => res.status(404).json({ error: what });
const truthy = (v) => v === true || v === "1" || v === "true";
const MAX_UPLOAD_BYTES = () => (Number(process.env.LINKS_VIDEO_MAX_UPLOAD_MB) || 500) * 1024 * 1024;

export function installVideoRoutes(app) {
  app.get("/api/links/:id/video", (req, res) => {
    const out = video.videoView(req.params.id);
    return out ? res.json(out) : notFound(res);
  });

  // Start (or repeat) the analysis. Body: { path?, download?, force?, language? }. 202 while it runs, 200 when it is already finished.
  app.post("/api/links/:id/video/analyze", (req, res, next) => {
    try {
      const b = req.body || {};
      const out = video.requestAnalysis(req.params.id, { path: b.path || undefined, download: truthy(b.download), force: truthy(b.force), language: b.language || undefined });
      res.status(["queued", "running"].includes(out.status) ? 202 : 200).json(out);
    } catch (e) { next(e); }
  });

  // Attach a video or audio file: the raw bytes as the request body, the file name in ?name= (its extension says the type).
  app.put("/api/links/:id/video/file", (req, res, next) => {
    if (!links.getLink(req.params.id)) return notFound(res);
    const name = String(req.query.name || req.get("x-filename") || "");
    const temp = video.uploadTempPath();
    const out = fs.createWriteStream(temp);
    const limit = MAX_UPLOAD_BYTES();
    let size = 0;
    let failed = false;
    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(temp, { force: true }, () => {});
      if (!res.headersSent) res.status(status).json({ error: message });
    };
    req.on("data", (chunk) => { size += chunk.length; if (size > limit) { fail(413, `El archivo supera el máximo (${Math.round(limit / 1048576)} MB).`); req.destroy(); } });
    req.on("error", () => fail(400, "Se interrumpió la subida."));
    out.on("error", () => fail(500, "No se pudo guardar el archivo."));
    out.on("finish", () => {
      if (failed) return;
      try { res.status(202).json(video.attachUpload(req.params.id, temp, name)); } catch (e) { fs.rm(temp, { force: true }, () => {}); next(e); }
    });
    req.pipe(out);
  });

  app.get("/api/links/:id/frames/:idx", (req, res) => {
    const file = video.frameFile(req.params.id, req.params.idx);
    if (!file) return notFound(res, "No existe ese fotograma.");
    res.sendFile(file, { dotfiles: "allow", headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } },
      (error) => { if (error && !res.headersSent) res.status(404).json({ error: "No existe ese fotograma." }); });
  });

  app.get("/api/video/search", (req, res, next) => {
    try { res.json({ query: String(req.query.q || ""), hits: video.searchTranscripts(req.query.q, req.query.limit) }); } catch (e) { next(e); }
  });
  app.get("/api/video/settings", (req, res) => res.json(video.videoSettings()));
  app.put("/api/video/settings", (req, res, next) => {
    try { res.json(video.setVideoSettings(req.body || {})); } catch (e) { next(e); }
  });
}