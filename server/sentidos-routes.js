// REST routes of Sentidos (the listening engine), behind the same guard as the rest of /api.
import * as sentidos from "./sentidos.js";
import * as sounds from "./sentidos-tools.js";

const TOOLS = ["describe", "match", "find", "timeline", "measure", "realness", "sheet"];

export function installSentidosRoutes(app) {
  app.get("/api/sentidos/status", async (req, res, next) => {
    try { res.json(await sentidos.status()); } catch (e) { next(e); }
  });
  app.post("/api/sentidos/setup", (req, res) => res.status(202).json(sentidos.setup()));
  app.post("/api/sentidos/start", async (req, res, next) => {
    try { await sentidos.start(); res.json(await sentidos.status()); } catch (e) { next(e); }
  });
  app.post("/api/sentidos/stop", async (req, res, next) => {
    try { await sentidos.stop(); res.json(await sentidos.status()); } catch (e) { next(e); }
  });
  app.get("/api/sentidos/settings", (req, res) => res.json(sentidos.sentidosSettings()));
  app.put("/api/sentidos/settings", (req, res, next) => {
    try { res.json(sentidos.setSentidosSettings(req.body || {})); } catch (e) { next(e); }
  });

  // audio and video files the library already holds, for the source picker
  app.get("/api/sentidos/sources", (req, res, next) => {
    try { res.json({ sources: sounds.listSources({ limit: req.query.limit }) }); } catch (e) { next(e); }
  });

  // one tool: { tool, path | id | url, start?, end?, query?, alts?, detail?, top?, kind?, music?, ast?, deep? }
  app.post("/api/sentidos/run", async (req, res, next) => {
    try {
      const b = req.body || {};
      const tool = String(b.tool || "");
      if (!TOOLS.includes(tool)) return res.status(400).json({ error: `Herramienta no válida. Usa: ${TOOLS.join(", ")}.` });
      if (tool === "find" && !(b.path || b.id || b.url)) {
        const query = String(b.query || "").trim();
        if (!query) return res.status(400).json({ error: "Escribe qué sonido buscas." });
        const indexed = sounds.searchSounds(query, { limit: 20 });
        const library = b.deep ? await sounds.rankLibrary(query, { top: Number(b.top) || 10 }) : undefined;
        return res.json({ ok: true, tool, query, indexed, library });
      }
      const out = await sounds.runTool(tool, b, { withData: Boolean(b.with_data) });
      res.status(out.ok ? 200 : 422).json(out);
    } catch (e) { next(e); }
  });

  app.get("/api/sentidos/search", (req, res, next) => {
    try { res.json({ query: String(req.query.q || ""), hits: sounds.searchSounds(req.query.q, { limit: req.query.limit }) }); } catch (e) { next(e); }
  });

  // the PNG written by audio_sheet
  app.get("/api/sentidos/sheet/:name", (req, res) => {
    const file = sounds.sheetFile(req.params.name);
    if (!file) return res.status(404).json({ error: "No existe esa hoja." });
    res.sendFile(file, { dotfiles: "allow", headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } },
      (error) => { if (error && !res.headersSent) res.status(404).json({ error: "No existe esa hoja." }); });
  });
}
