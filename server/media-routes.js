// REST routes for media downloads, installed behind the same guard as the
// rest of /api. Errors bubble to the shared handler in app.js as { error }.
import * as media from "./media.js";

const notFound = (res) => res.status(404).json({ error: "No existe esa descarga." });
const truthy = (v) => v === "1" || v === "true" || v === true;

export function installMediaRoutes(app) {
  app.get("/api/media", (req, res, next) => {
    try { res.json(media.listDownloads({ status: req.query.status, limit: req.query.limit })); } catch (e) { next(e); }
  });

  app.get("/api/media/tools", async (req, res, next) => {
    try { res.json(await media.toolsStatus({ refresh: truthy(req.query.refresh) })); } catch (e) { next(e); }
  });
  app.post("/api/media/tools/update", async (req, res, next) => {
    try {
      const tools = Array.isArray(req.body?.tools) && req.body.tools.length ? req.body.tools : undefined;
      res.json(await media.updateTools(tools ? { tools } : {}));
    } catch (e) { next(e); }
  });

  app.get("/api/media/settings", (req, res, next) => {
    try { res.json(media.getMediaSettings()); } catch (e) { next(e); }
  });
  app.put("/api/media/settings", (req, res, next) => {
    try { res.json(media.setMediaSettings(req.body || {})); } catch (e) { next(e); }
  });

  app.post("/api/media/probe", async (req, res, next) => {
    try { res.json(await media.probeUrl(req.body || {})); } catch (e) { next(e); }
  });

  app.post("/api/media", (req, res, next) => {
    try {
      const out = media.startDownload(req.body || {});
      res.status(out.existing ? 200 : 202).json(out);
    } catch (e) { next(e); }
  });

  app.get("/api/media/:id", (req, res) => {
    const row = media.getDownload(req.params.id);
    return row ? res.json(row) : notFound(res);
  });
  app.post("/api/media/:id/cancel", (req, res, next) => {
    try { res.json(media.cancelDownload(req.params.id)); } catch (e) { next(e); }
  });
  app.post("/api/media/:id/retry", (req, res, next) => {
    try { res.status(202).json(media.retryDownload(req.params.id)); } catch (e) { next(e); }
  });
  app.delete("/api/media/:id", (req, res, next) => {
    try { res.json(media.removeDownload(req.params.id, { deleteFiles: truthy(req.query.files) })); } catch (e) { next(e); }
  });
  app.post("/api/media/:id/reveal", (req, res, next) => {
    try { res.json(media.revealDownload(req.params.id, req.body?.i ?? req.query.i ?? 0)); } catch (e) { next(e); }
  });

  // Streams one produced file. Express' sendFile answers Range requests (206,
  // Accept-Ranges, 416) so <video> and <audio> can seek.
  app.get("/api/media/:id/file", (req, res, next) => {
    let file;
    try { file = media.fileOf(req.params.id, req.query.i ?? 0); } catch (e) { return next(e); }
    const disposition = truthy(req.query.download) ? "attachment" : "inline";
    res.sendFile(file.path, {
      dotfiles: "allow",
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }, (error) => { if (error && !res.headersSent) next(error); });
  });
}
