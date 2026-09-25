// REST routes for the UI. Bodies are zod-validated in the domain modules;
// errors bubble to the shared error handler in app.js as { error }.
import * as links from "./links.js";
import * as highlights from "./highlights.js";
import { runImport } from "./imports.js";
import { enqueueFetch } from "./fetcher.js";
import { renderSharePage } from "./share.js";
import { manifest, serviceWorker } from "./manifest.js";
import { dataDir } from "./db.js";
import * as watches from "./watches.js";
import * as family from "./hoard-link.js";

const notFound = (res) => res.status(404).json({ error: "No existe." });

export function installRoutes(app, { version, dataDirConfigured }) {
  app.get("/api/health", (req, res) => {
    res.json({ service: "links-hoard", version, dataDirConfigured, hoard_link: family.healthBlock() });
  });

  app.get("/api/state", (req, res) => {
    res.json({
      stats: links.stats(),
      tags: links.listTags(),
      sites: links.listSites(),
      ftsEnabled: links.listLinks({ limit: 1 }).ftsEnabled,
      watches: watches.stats(),
      dataDir: dataDir(),
      version,
    });
  });

  // Watches (feeds, GitHub repositories, pages checked on a schedule)
  app.get("/api/watches", (req, res) => res.json({ watches: watches.listWatches(), stats: watches.stats() }));
  app.post("/api/watches", async (req, res, next) => {
    try {
      const out = await watches.addWatch(req.body || {});
      res.status(out.existing ? 200 : 201).json(out);
    } catch (e) { next(e); }
  });
  app.patch("/api/watches/:id", (req, res) => res.json(watches.updateWatch(req.params.id, req.body || {})));
  app.delete("/api/watches/:id", (req, res) => res.json({ ok: true, removed: watches.removeWatch(req.params.id) }));
  app.post("/api/watches/:id/check", async (req, res, next) => {
    try { res.json(await watches.checkWatch(req.params.id)); } catch (e) { next(e); }
  });
  app.post("/api/watches/check", async (req, res, next) => {
    try { res.json({ results: await watches.checkDue() }); } catch (e) { next(e); }
  });
  app.get("/api/watch-items", (req, res) => res.json({ items: watches.listItems({
    watch_id: req.query.watch_id || null, since: req.query.since || null, unread: req.query.unread === "1" || req.query.unread === "true",
    limit: Number(req.query.limit || 50) }) }));
  app.post("/api/watch-items/:id/dismiss", (req, res) => res.json(watches.dismissItem(req.params.id, true)));
  app.post("/api/watch-items/:id/undismiss", (req, res) => res.json(watches.dismissItem(req.params.id, false)));

  // Links
  app.get("/api/links", (req, res) => res.json(links.listLinks(req.query)));

  app.get("/api/links/:id", (req, res) => {
    const link = links.getLink(req.params.id);
    if (!link) return notFound(res);
    res.json({ ...link, highlights: highlights.listHighlights(link.id) });
  });

  app.post("/api/links", (req, res) => {
    const { link, existing } = links.createLink(req.body || {});
    if (!existing) enqueueFetch(link.id, link.url);
    res.status(existing ? 200 : 201).json({ ...link, existing });
  });

  app.patch("/api/links/:id", (req, res) => {
    const out = links.updateLink(req.params.id, req.body || {});
    return out ? res.json(out) : notFound(res);
  });

  app.delete("/api/links/:id", (req, res) => res.json({ ok: links.deleteLink(req.params.id) }));

  app.post("/api/links/:id/read", (req, res) => {
    const out = links.markRead(req.params.id, true);
    return out ? res.json(out) : notFound(res);
  });
  app.post("/api/links/:id/unread", (req, res) => {
    const out = links.markRead(req.params.id, false);
    return out ? res.json(out) : notFound(res);
  });
  app.post("/api/links/:id/archive", (req, res) => {
    const archived = req.body?.archived !== false;
    const out = links.setArchived(req.params.id, archived);
    return out ? res.json(out) : notFound(res);
  });
  app.post("/api/links/:id/favorite", (req, res) => {
    const favorite = req.body?.favorite !== false;
    const out = links.setFavorite(req.params.id, favorite);
    return out ? res.json(out) : notFound(res);
  });
  app.post("/api/links/:id/refetch", async (req, res) => {
    const link = links.getLink(req.params.id);
    if (!link) return notFound(res);
    const pending = links.markFetchPending(link.id);
    enqueueFetch(link.id, link.url);
    res.json(pending);
  });

  // Highlights
  app.get("/api/links/:id/highlights", (req, res) => {
    if (!links.getLink(req.params.id)) return notFound(res);
    res.json(highlights.listHighlights(req.params.id));
  });
  app.post("/api/links/:id/highlights", (req, res) => {
    res.status(201).json(highlights.addHighlight(req.params.id, req.body || {}));
  });
  app.patch("/api/highlights/:id", (req, res) => {
    const out = highlights.updateHighlight(req.params.id, req.body || {});
    return out ? res.json(out) : notFound(res);
  });
  app.delete("/api/highlights/:id", (req, res) => res.json({ ok: highlights.deleteHighlight(req.params.id) }));

  // Facets
  app.get("/api/tags", (req, res) => res.json(links.listTags()));
  app.get("/api/sites", (req, res) => res.json(links.listSites()));

  // Import
  app.post("/api/import", (req, res) => res.status(201).json(runImport(req.body || {})));

  // Digest
  app.get("/api/digest", (req, res) => {
    res.json(links.digestSince(req.query.since || "7d"));
  });

  // PWA share target + bookmarklet endpoint, and manifest/service worker.
  app.get("/share", async (req, res) => {
    const url = req.query.url || req.query.text || "";
    const title = req.query.title || "";
    res.set("Content-Type", "text/html; charset=utf-8");
    if (!url) return res.send(renderSharePage({ ok: false, message: "Falta la URL." }));
    try {
      const { link, existing } = links.createLink({ url, tags: [], note: "", source: "share" });
      if (title && !existing) links.updateLink(link.id, { title });
      if (!existing) enqueueFetch(link.id, link.url);
      res.send(renderSharePage({ ok: true, existing, link }));
    } catch (error) {
      res.send(renderSharePage({ ok: false, message: error.message }));
    }
  });
  app.get("/manifest.webmanifest", (req, res) => {
    res.set("Content-Type", "application/manifest+json");
    res.send(JSON.stringify(manifest()));
  });
  app.get("/sw.js", (req, res) => {
    res.set("Content-Type", "application/javascript");
    res.send(serviceWorker());
  });
}
