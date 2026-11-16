// REST routes of Plegar (fold.js), the bilingual reader (translate.js) and the browser extension's capture (capture.js).
import { foldDocument, foldLink, foldRead } from "./fold.js";
import { translateLink, translationLanguages } from "./translate.js";
import { capturePage } from "./capture.js";

export function installFoldRoutes(app) {
  // the whole fold in its open JSON format; ?download=1 saves it as a file
  app.get("/api/links/:id/fold", (req, res, next) => {
    try {
      const doc = foldDocument(req.params.id, { lang: req.query.lang || "es" });
      if (req.query.download) res.set("Content-Disposition", `attachment; filename="fold-${doc.link.id}-${doc.lang}.json"`);
      res.json(doc);
    } catch (e) { next(e); }
  });
  app.post("/api/links/:id/fold", async (req, res, next) => {
    try {
      const b = req.body || {};
      res.json(await foldLink(req.params.id, { lang: b.lang || "es", force: b.force === true, wait_s: Math.max(0, Math.min(600, Number(b.wait_s) || 0)) }));
    } catch (e) { next(e); }
  });
  app.get("/api/links/:id/fold/read", (req, res, next) => {
    try {
      res.json(foldRead(req.params.id, { level: req.query.level || 5, section: req.query.section, lang: req.query.lang || "es", from_section: req.query.from_section }));
    } catch (e) { next(e); }
  });

  app.post("/api/links/:id/translate", async (req, res, next) => {
    try { res.json(await translateLink(req.params.id, req.body || {})); } catch (e) { next(e); }
  });
  app.get("/api/links/:id/translations", (req, res) => res.json({ languages: translationLanguages(req.params.id) }));

  // the browser extension: the page as the browser shows it (rendered HTML or a document's bytes)
  app.post("/api/capture", async (req, res, next) => {
    try {
      const out = await capturePage(req.body || {});
      res.status(out.existing ? 200 : 201).json(out);
    } catch (e) { next(e); }
  });
}
