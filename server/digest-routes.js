// REST routes for the video digest (see videodigest.js), behind the same guard as the rest of /api.
import * as digest from "./videodigest.js";

const notFound = (res, what = "No existe.") => res.status(404).json({ error: what });
const truthy = (v) => v === true || v === "1" || v === "true";

export function installDigestRoutes(app) {
  // Start (or reuse) a digest. Body: { url? | id?, path?, focus?, force?, redo_media?, language? }. 202 while it runs.
  app.post("/api/video-digests", (req, res, next) => {
    try {
      const out = digest.requestDigest(req.body || {});
      res.status(["queued", "running"].includes(out.status) ? 202 : 200).json(out);
    } catch (e) { next(e); }
  });
  app.get("/api/video-digests", (req, res) => res.json({ digests: digest.listDigests({ limit: req.query.limit }) }));
  app.get("/api/video-digests/search", (req, res, next) => {
    try { res.json({ query: String(req.query.q || ""), hits: digest.findInVideos(req.query.q, { id: req.query.id || null, limit: req.query.limit }) }); } catch (e) { next(e); }
  });
  app.get("/api/video-digests/settings", (req, res) => res.json(digest.digestSettings()));
  app.put("/api/video-digests/settings", (req, res, next) => {
    try { res.json(digest.setDigestSettings(req.body || {})); } catch (e) { next(e); }
  });

  // State, and with ?level=card|index|visual|transcript|full|brief the text of that layer (&from=&to= cut visual/transcript to a span).
  app.get("/api/links/:id/digest", (req, res) => {
    const level = req.query.level && digest.LEVELS.includes(String(req.query.level)) ? String(req.query.level) : null;
    const out = digest.digestView(req.params.id, { level, from: req.query.from ?? null, to: req.query.to ?? null });
    return out ? res.json(out) : notFound(res);
  });
  app.post("/api/links/:id/digest", (req, res, next) => {
    try {
      const b = req.body || {};
      const out = digest.requestDigest({ id: req.params.id, focus: b.focus || undefined, path: b.path || undefined, force: truthy(b.force), redo_media: truthy(b.redo_media) });
      res.status(["queued", "running"].includes(out.status) ? 202 : 200).json(out);
    } catch (e) { next(e); }
  });
  app.post("/api/links/:id/digest/ask", async (req, res, next) => {
    try { res.json(await digest.askVideo(req.params.id, (req.body || {}).question)); } catch (e) { next(e); }
  });
  app.get("/api/links/:id/digest/frame", async (req, res, next) => {
    try {
      const f = await digest.frameAt(req.params.id, req.query.t, { width: req.query.width });
      if (truthy(req.query.json)) return res.json(f);
      res.sendFile(f.path, { dotfiles: "allow", headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    } catch (e) { next(e); }
  });
  // Files of the digest: the markdown layers, the frames and the contact sheets.
  app.get(/^\/api\/links\/([^/]+)\/digest\/files\/(.+)$/, (req, res) => {
    const file = digest.digestFile(req.params[0], req.params[1]);
    if (!file) return notFound(res, "No existe ese fichero del digest.");
    const type = file.endsWith(".md") ? "text/markdown; charset=utf-8" : "image/jpeg";
    res.sendFile(file, { dotfiles: "allow", headers: { "Content-Type": type, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } },
      (error) => { if (error && !res.headersSent) notFound(res); });
  });
}
