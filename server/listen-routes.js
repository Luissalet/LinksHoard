// REST routes of Escuchar (see listen.js): the audio of a link, its resume point and the «Escuchar después» queue.
import fs from "node:fs";
import * as links from "./links.js";
import * as listen from "./listen.js";

const notFound = (res) => res.status(404).json({ error: "No existe." });

export function installListenRoutes(app) {
  // the page: the queue in order, everything that has audio, and the settings
  app.get("/api/listen", (req, res) => res.json({ queue: listen.queueList(), library: listen.listenLibrary(), settings: listen.listenSettings() }));
  app.post("/api/listen/settings", (req, res) => res.json(listen.setListenSettings(req.body || {})));

  app.get("/api/listen/queue", (req, res) => res.json({ queue: listen.queueList() }));
  app.post("/api/listen/queue", (req, res, next) => {
    try { res.json({ queue: listen.queueAdd(String(req.body?.id || ""), { position: req.body?.position || null }) }); } catch (e) { next(e); }
  });
  app.post("/api/listen/queue/order", (req, res, next) => {
    try { res.json({ queue: listen.queueOrder(Array.isArray(req.body?.ids) ? req.body.ids : []) }); } catch (e) { next(e); }
  });
  app.delete("/api/listen/queue", (req, res) => res.json({ queue: listen.queueClear() }));
  app.delete("/api/listen/queue/:id", (req, res) => res.json({ queue: listen.queueRemove(req.params.id) }));

  app.get("/api/links/:id/listen", (req, res) => {
    const view = listen.listenView(req.params.id);
    return view ? res.json(view) : notFound(res);
  });
  app.post("/api/links/:id/listen", (req, res, next) => {
    try { res.json(listen.startListen(req.params.id, req.body || {})); } catch (e) { next(e); }
  });
  app.delete("/api/links/:id/listen", (req, res) => {
    if (!links.getLink(req.params.id)) return notFound(res);
    res.json({ ok: listen.deleteListen(req.params.id) });
  });
  app.post("/api/links/:id/listen/position", (req, res, next) => {
    try { res.json(listen.setPosition(req.params.id, req.body || {})); } catch (e) { next(e); }
  });
  app.get("/api/links/:id/listen/lines", (req, res) => {
    if (!links.getLink(req.params.id)) return notFound(res);
    res.json({ lines: listen.listenLines(req.params.id) });
  });
  // the MP3 itself; ranges are served so the player can seek and resume
  app.get("/api/links/:id/listen/audio", (req, res) => {
    const file = listen.listenAudioFile(req.params.id);
    if (!file) return notFound(res);
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    res.set({ "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
    if (!range || (range[1] === "" && range[2] === "")) {
      res.set("Content-Length", String(size));
      return fs.createReadStream(file).pipe(res);
    }
    let start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.status(416).set("Content-Range", `bytes */${size}`).end();
    res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
    return fs.createReadStream(file, { start, end }).pipe(res);
  });
}
