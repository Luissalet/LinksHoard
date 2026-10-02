// Media downloads end to end with fake yt-dlp / gallery-dl / ffmpeg (see
// media-fakes.js): REST routes, the queue, cancel, the gallery-dl fallback,
// cookies from the browser, the saved link, file streaming, the MCP tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { bootServer, tempDir, waitFetched, FIXTURE_ARTICLE } from "./helpers.js";
import { installFakes } from "./media-fakes.js";
import * as media from "../server/media.js";
import * as links from "../server/links.js";
import { db, now, setSetting } from "../server/db.js";
import { resetToolsCache } from "../server/media-tools.js";
import * as family from "../server/hoard-link.js";
import { AGENT_INSTRUCTIONS } from "../server/agent-tools.js";

const ENV_KEYS = ["LINKS_YTDLP", "LINKS_GALLERYDL", "LINKS_FFMPEG", "PYTHON", "FAKE_DIR", "FAKE_LOG", "LINKS_MEDIA_DIR", "LINKS_MEDIA_SIBLING_DIR", "LINKS_MEDIA_AUTO_UPDATE", "LINKS_MEDIA_STALE_DAYS", "PATH", "LINKS_COOKIES_FILE", "LINKS_MEDIA_TRANSCODE", "LINKS_COOKIES_BROWSERS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (patch) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetToolsCache(); };

let s, fakes, tmp, mediaDir, hub, hubEvents, page;

const until = async (fn, timeoutMs = 10_000, step = 20) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, step));
  }
};
const TERMINAL = ["done", "failed", "cancelled"];
const get = async (id) => (await s.call("GET", `/api/media/${id}`)).body;
const waitTerminal = (id) => until(async () => { const r = await get(id); return TERMINAL.includes(r.status) ? r : null; });
const start = async (body) => {
  const r = await s.call("POST", "/api/media", { save_link: false, ...body });
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
  return r.body;
};
const run = async (body) => waitTerminal((await start(body)).id);
const ytCalls = () => fakes.calls("yt-dlp").filter((c) => !c.argv.includes("--version") && !c.argv.includes("-U"));
const galleryCalls = () => fakes.calls("gallery-dl").filter((c) => !c.argv.includes("--version") && !c.argv.includes("-U"));
const arg = (call, name) => call.argv[call.argv.indexOf(name) + 1];
const lastUrl = (call) => call.argv[call.argv.length - 1];
const isAlive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8")); } catch { return true; }
};

before(async () => {
  tmp = tempDir();
  fakes = installFakes(path.join(tmp, "fakes"));
  mediaDir = path.join(tmp, "Mis descargas");
  setEnv({ ...fakes.env, LINKS_MEDIA_DIR: mediaDir, LINKS_COOKIES_FILE: undefined, LINKS_MEDIA_TRANSCODE: undefined, LINKS_COOKIES_BROWSERS: undefined });
  s = await bootServer();

  // the family hub: records the events this app posts
  hubEvents = [];
  hub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/api/events") { try { hubEvents.push(JSON.parse(body)); } catch { /* ignore */ } }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  family.configure({ app: "links", dataDir: s.dataDir, hub: `http://127.0.0.1:${hub.address().port}` });

  // a site: articles for /video/*, a page that fails for /photos/*
  page = http.createServer((req, res) => {
    if (req.url.startsWith("/photos/")) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FIXTURE_ARTICLE);
  });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  page.base = `http://127.0.0.1:${page.address().port}`;
});

after(async () => {
  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  await s.stop();
  await new Promise((r) => hub.close(r));
  await new Promise((r) => page.close(r));
  setEnv(savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the tools report what was found, with versions and how", async () => {
  const r = await s.call("GET", "/api/media/tools");
  assert.equal(r.status, 200);
  assert.equal(r.body.ytdlp.found, true);
  assert.equal(r.body.ytdlp.how, "env");
  assert.equal(r.body.ytdlp.version, "2026.01.01");
  assert.equal(r.body.gallerydl.version, "1.30.0");
  assert.equal(r.body.ffmpeg.version, "6.1-fake");
  assert.equal(r.body.python.found, true);
  assert.equal(r.body.install_command, "python -m pip install -U yt-dlp gallery-dl");
  const settings = await s.call("GET", "/api/media/settings");
  assert.equal(settings.body.dir, mediaDir);
  assert.equal(settings.body.dir_is_default, true);
});

let videoId;
test("a video download: queued, then done with the file, metadata and no sidecars", async () => {
  const started = await s.call("POST", "/api/media", { url: "https://www.youtube.com/video/vid1", save_link: false });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, "queued");
  assert.equal(started.body.platform, "YouTube");
  assert.equal(started.body.format, "auto");
  assert.equal(started.body.dir, mediaDir);
  const done = await waitTerminal(started.body.id);
  videoId = done.id;
  assert.equal(done.status, "done", done.error);
  assert.equal(done.kind, "video");
  assert.equal(done.progress, 100);
  assert.equal(done.title, "Título vid1");
  assert.equal(done.uploader, "Canal de prueba");
  assert.equal(done.upload_date, "20260930");
  assert.equal(done.duration, 12.5);
  assert.match(done.description, /Descripción de prueba del vídeo vid1/);
  assert.equal(done.files.length, 1);
  const file = done.files[0];
  assert.equal(file.path, path.join(mediaDir, "Título vid1 [vid1].mp4"));
  assert.equal(file.name, "Título vid1 [vid1].mp4");
  assert.equal(file.kind, "video");
  assert.equal(fs.statSync(file.path).size, file.size);
  assert.equal(done.total_bytes, file.size);
  assert.equal(done.link_id, null);
  assert.ok(done.started_at && done.finished_at);
  assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => /\.(json|part|ytdl|jpg|webp)$/.test(n)), []);
  const call = ytCalls().find((c) => lastUrl(c).endsWith("/video/vid1"));
  assert.equal(arg(call, "-P"), mediaDir, "the folder (with a space) travels as one argument");
  assert.match(arg(call, "-f"), /^bv\*\[vcodec\^=avc1\]\+ba\[ext=m4a\]/);
  assert.ok(call.argv.includes("--no-playlist"));
  // the DB row mirrors it
  const row = db().prepare("SELECT status, progress, files, total_bytes FROM media_downloads WHERE id = ?").get(done.id);
  assert.equal(row.status, "done");
  assert.equal(row.progress, 100);
  assert.equal(JSON.parse(row.files)[0].path, file.path);
});

test("audio gives an MP3; quality and playlist reach yt-dlp", async () => {
  const audio = await run({ url: "https://example.com/video/aud1", format: "audio" });
  assert.equal(audio.status, "done", audio.error);
  assert.equal(audio.kind, "audio");
  assert.equal(audio.files[0].name, "Título aud1 [aud1].mp3");
  assert.equal(audio.files[0].kind, "audio");
  const audioCall = ytCalls().find((c) => lastUrl(c).endsWith("/video/aud1"));
  assert.ok(audioCall.argv.includes("-x") && audioCall.argv.includes("mp3"));

  const q = await run({ url: "https://example.com/video/q720", format: "video", quality: "720" });
  assert.equal(q.status, "done", q.error);
  assert.equal(q.quality, "720");
  assert.match(arg(ytCalls().find((c) => lastUrl(c).endsWith("/video/q720")), "-f"), /height<=720/);

  const pl = await run({ url: "https://example.com/video/pl1", playlist: true, max_items: 7 });
  const plCall = ytCalls().find((c) => lastUrl(c).endsWith("/video/pl1"));
  assert.deepEqual(plCall.argv.slice(plCall.argv.indexOf("--yes-playlist"), plCall.argv.indexOf("--yes-playlist") + 3), ["--yes-playlist", "--playlist-end", "7"]);
  assert.equal(pl.playlist, true);
  assert.equal(pl.max_items, 7);
});

test("photo posts: yt-dlp says there is no video, gallery-dl takes over; nothing is overwritten", async () => {
  const before = ytCalls().length;
  const first = await run({ url: "https://www.instagram.com/photos/p1/" });
  assert.equal(first.status, "done", first.error);
  assert.equal(first.platform, "Instagram");
  assert.equal(first.kind, "image");
  assert.equal(first.uploader, "autor_test");
  assert.equal(first.upload_date, "20260930");
  assert.match(first.description, /^Pie de foto de prueba/);
  assert.equal(first.title, "Pie de foto de prueba");
  assert.equal(first.files.length, 2);
  const folder = path.dirname(first.files[0].path);
  assert.equal(path.basename(folder), "autor_test - Pie de foto de prueba");
  assert.deepEqual(fs.readdirSync(folder).sort(), ["photo_1.jpg", "photo_2.jpg"], "metadata .json sidecars are not left behind");
  assert.equal(ytCalls().length, before + 1, "yt-dlp was tried once");
  const gcall = galleryCalls().find((c) => lastUrl(c).includes("/photos/p1"));
  assert.ok(gcall.argv.includes("--write-metadata"));
  assert.equal(arg(gcall, "--range"), "1-50");

  // the same post again lands in a new folder; the first one is untouched
  const again = await run({ url: "https://www.instagram.com/photos/p1/" });
  assert.equal(again.status, "done");
  const folder2 = path.dirname(again.files[0].path);
  assert.notEqual(folder2, folder);
  assert.equal(path.basename(folder2), "autor_test - Pie de foto de prueba (2)");
  assert.equal(fs.readdirSync(folder).length, 2);

  // format image goes straight to gallery-dl
  const yBefore = ytCalls().length;
  const img = await run({ url: "https://www.instagram.com/photos/p2/", format: "image" });
  assert.equal(img.status, "done", img.error);
  assert.equal(ytCalls().length, yBefore, "yt-dlp is not asked for format image");

  // no metadata at all: the folder keeps its timestamp name, nothing is renamed to "(2)"
  const bare = await run({ url: "https://example.com/nometa/nm1", format: "image" });
  assert.equal(bare.status, "done", bare.error);
  assert.match(path.basename(path.dirname(bare.files[0].path)), /^Otro \d{14}$/);
  assert.equal(bare.uploader, "");

  // video format does not fall back: a photo post is an error that says so
  const strict = await run({ url: "https://www.instagram.com/photos/p3/", format: "video" });
  assert.equal(strict.status, "failed");
  assert.match(strict.error, /no contiene vídeo/);
  assert.equal(galleryCalls().filter((c) => lastUrl(c).includes("/photos/p3")).length, 0);
});

test("a second download of the same video does not overwrite or duplicate the file", async () => {
  const first = await run({ url: "https://example.com/exists/e1" });
  assert.equal(first.status, "done", first.error);
  const file = first.files[0].path;
  fs.writeFileSync(file, Buffer.alloc(3 * 1024, 1));
  const mtime = fs.statSync(file).mtimeMs;
  const second = await run({ url: "https://example.com/exists/e1" });
  assert.equal(second.status, "done");
  assert.equal(second.files[0].path, file);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  const call = ytCalls().filter((c) => lastUrl(c).endsWith("/exists/e1")).at(-1);
  assert.ok(!call.argv.includes("--force-overwrites") && !call.argv.includes("--no-continue") && !call.argv.includes("-w"));
});

test("login-only content: no cookies first, then each browser until one works", async () => {
  const before = ytCalls().length;
  const done = await run({ url: "https://www.instagram.com/private/pr1" });
  assert.equal(done.status, "done", done.error);
  assert.equal(done.cookies_browser, "chrome");
  const calls = ytCalls().slice(before);
  assert.deepEqual(calls.map((c) => (c.argv.includes("--cookies-from-browser") ? arg(c, "--cookies-from-browser") : "none")), ["none", "firefox", "chrome"]);

  // a browser named explicitly is the only one tried
  const b2 = ytCalls().length;
  const only = await run({ url: "https://www.instagram.com/private/pr2", cookies_browser: "firefox" });
  assert.equal(only.status, "failed");
  assert.equal(ytCalls().length - b2, 1);

  // "none" never touches the browsers and says what to do
  const b3 = ytCalls().length;
  const none = await run({ url: "https://www.instagram.com/private/pr3", cookies_browser: "none" });
  assert.equal(none.status, "failed");
  assert.match(none.error, /iniciar sesión/);
  assert.equal(ytCalls().length - b3, 1);

  // gallery-dl cascades the same way
  const g0 = galleryCalls().length;
  const g = await run({ url: "https://www.instagram.com/private/g1", format: "image" });
  assert.equal(g.status, "done", g.error);
  assert.equal(g.cookies_browser, "chrome");
  assert.deepEqual(galleryCalls().slice(g0).map((c) => (c.argv.includes("--cookies-from-browser") ? arg(c, "--cookies-from-browser") : "none")), ["none", "firefox", "chrome"]);

  // when nothing works, the message names the browsers that were tried
  setEnv({ LINKS_COOKIES_BROWSERS: "firefox,edge" });
  const bad = await run({ url: "https://www.instagram.com/private/pr4" });
  setEnv({ LINKS_COOKIES_BROWSERS: undefined });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /Probé con las cookies de firefox, edge y ninguna sirvió/);
});

test("a cookies file from the settings is used instead of the browsers", async () => {
  const cookies = path.join(tmp, "cookies.txt");
  const rel = await s.call("PUT", "/api/media/settings", { cookies_file: "cookies.txt" });
  assert.equal(rel.status, 400);
  const missing = await s.call("PUT", "/api/media/settings", { cookies_file: path.join(tmp, "nope.txt") });
  assert.equal(missing.status, 400);
  fs.writeFileSync(cookies, "# Netscape HTTP Cookie File\n");
  const ok = await s.call("PUT", "/api/media/settings", { cookies_file: cookies });
  assert.equal(ok.body.cookies_file, cookies);
  const before = ytCalls().length;
  const r = await run({ url: "https://example.com/video/ck1" });
  assert.equal(r.status, "done");
  const call = ytCalls()[before];
  assert.equal(arg(call, "--cookies"), cookies);
  assert.ok(!call.argv.includes("--cookies-from-browser"));
  await s.call("PUT", "/api/media/settings", { cookies_file: "" });
});

test("errors are plain Spanish; retry puts the same download back and it can succeed", async () => {
  const gone = await run({ url: "https://www.youtube.com/gone/g1" });
  assert.equal(gone.status, "failed");
  assert.match(gone.error, /no está disponible/);
  assert.equal(gone.finished_at !== null, true);

  const flaky = await run({ url: "https://example.com/flaky/f1" });
  assert.equal(flaky.status, "failed");
  assert.match(flaky.error, /No se pudo conectar/);
  fs.writeFileSync(path.join(fakes.dir, "flaky-ok"), "1");
  const retried = await s.call("POST", `/api/media/${flaky.id}/retry`);
  assert.equal(retried.status, 202);
  assert.equal(retried.body.id, flaky.id);
  assert.ok(["queued", "downloading", "processing", "done"].includes(retried.body.status));
  assert.equal(retried.body.error, "");
  const ok = await waitTerminal(flaky.id);
  assert.equal(ok.status, "done", ok.error);
  assert.equal(ok.files.length, 1);

  const none = await run({ url: "https://example.com/nofiles/n1" });
  assert.equal(none.status, "failed");
  assert.match(none.error, /no creó ningún archivo/);
});

test("queue order, cancel of a waiting download and cancel of the running one (process tree killed)", async () => {
  const slowPid = path.join(fakes.dir, "slow.pid");
  const childPid = path.join(fakes.dir, "grandchild.pid");
  fs.rmSync(slowPid, { force: true });
  fs.rmSync(childPid, { force: true });
  const before = ytCalls().length;
  const a = await start({ url: "https://example.com/slow/a" });
  await until(() => fs.existsSync(childPid) && fs.existsSync(slowPid));
  const running = await until(async () => { const r = await get(a.id); return r.progress > 0 ? r : null; });
  assert.equal(running.status, "downloading");
  assert.equal(running.progress, 5, "1 KB of 10 KB on the first of two streams");
  assert.equal(running.speed, "1.0 KB/s");
  assert.equal(running.eta, "00:09");
  const b = await start({ url: "https://example.com/video/qb" });
  const c = await start({ url: "https://example.com/video/qc" });
  assert.equal((await get(b.id)).status, "queued");
  assert.equal((await get(c.id)).status, "queued");

  // the same download asked twice is the same download
  const dup = await s.call("POST", "/api/media", { url: "https://example.com/slow/a", save_link: false });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, a.id);
  assert.equal(dup.body.existing, true);

  // list: newest first, and the active filter
  const active = await s.call("GET", "/api/media?status=active");
  assert.deepEqual(active.body.items.map((i) => i.id), [c.id, b.id, a.id]);

  // cancelling a waiting one removes it: it never runs
  const cancelC = await s.call("POST", `/api/media/${c.id}/cancel`);
  assert.equal(cancelC.body.status, "cancelled");
  assert.equal((await get(b.id)).status, "queued");

  // cancelling the running one kills yt-dlp and everything it started
  const pid = Number(fs.readFileSync(slowPid, "utf8"));
  const grandchild = Number(fs.readFileSync(childPid, "utf8"));
  assert.ok(isAlive(pid) && isAlive(grandchild));
  const cancelA = await s.call("POST", `/api/media/${a.id}/cancel`);
  assert.equal(cancelA.status, 200);
  assert.equal(cancelA.body.cancelling, true);
  const cancelled = await waitTerminal(a.id);
  assert.equal(cancelled.status, "cancelled");
  await until(() => !isAlive(pid) && !isAlive(grandchild), 5000);
  assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => n.endsWith(".part")), [], "partial files are cleaned up");

  // the next one in line then runs, in order; the cancelled one never did
  const doneB = await waitTerminal(b.id);
  assert.equal(doneB.status, "done", doneB.error);
  const urls = ytCalls().slice(before).map(lastUrl);
  assert.deepEqual(urls, ["https://example.com/slow/a", "https://example.com/video/qb"]);

  // finished downloads cannot be cancelled again; a cancelled one can be retried
  const again = await s.call("POST", `/api/media/${doneB.id}/cancel`);
  assert.equal(again.body.already_finished, true);
  const retried = await s.call("POST", `/api/media/${c.id}/retry`);
  assert.equal(retried.status, 202);
  assert.equal((await waitTerminal(c.id)).status, "done");

  // a running download cannot be removed, nor retried
  const slow2 = await start({ url: "https://example.com/slow/a2" });
  await until(async () => (await get(slow2.id)).status === "downloading");
  assert.equal((await s.call("DELETE", `/api/media/${slow2.id}`)).status, 409);
  assert.equal((await s.call("POST", `/api/media/${slow2.id}/retry`)).status, 409);
  await s.call("POST", `/api/media/${slow2.id}/cancel`);
  assert.equal((await waitTerminal(slow2.id)).status, "cancelled");
});

test("a finished download is saved as a link with a note, the caption and the right kind", async () => {
  hubEvents.length = 0;
  const url = `${page.base}/video/v1`;
  const done = await run({ url, format: "video", save_link: true });
  assert.equal(done.status, "done", done.error);
  assert.ok(done.link_id);
  await media.drainMedia();
  const link = links.getLink(done.link_id);
  assert.deepEqual(link.tags, ["descarga"]);
  assert.equal(link.notes, `Descargado en ${done.files[0].path}`);
  assert.equal(link.kind, "video");
  assert.equal(link.title, "The Real Article Title", "the page title wins when the page fetch worked");
  assert.match(link.content_text, /fixture body text/);
  assert.equal(db().prepare("SELECT source FROM links WHERE id = ?").get(link.id).source, "download");

  // a photo post whose page cannot be fetched: the caption becomes the link text
  const photos = await run({ url: `${page.base}/photos/ph1`, save_link: true });
  assert.equal(photos.status, "done", photos.error);
  await media.drainMedia();
  const plink = links.getLink(photos.link_id);
  assert.equal(plink.kind, "image");
  assert.equal(plink.fetch_status, "ok");
  assert.equal(plink.title, "Pie de foto de prueba");
  assert.equal(plink.byline, "autor_test");
  assert.match(plink.content_text, /Pie de foto de prueba\nsegunda línea/);
  assert.match(plink.notes, /^Descargado en .*autor_test - Pie de foto de prueba(?: \(\d+\))?$/);
  const read = await s.agent("read_link", { id: plink.id });
  assert.match(read.body.text, /segunda línea/);
  const found = await s.agent("search_links", { q: "segunda" });
  assert.ok(found.body.items.some((i) => i.id === plink.id), "search finds the caption");
  const tagged = await s.agent("list_links", { state: "all", tag: "descarga" });
  assert.equal(tagged.body.total, 2);

  // an already-saved page: same link, tag and note added, the page text untouched
  const saved = await s.call("POST", "/api/links", { url: `${page.base}/video/v2`, tags: ["mio"], note: "mi nota" });
  await waitFetched(s, saved.body.id);
  const again = await run({ url: `${page.base}/video/v2`, save_link: true });
  assert.equal(again.link_id, saved.body.id);
  await media.drainMedia();
  const merged = links.getLink(saved.body.id);
  assert.deepEqual(merged.tags.sort(), ["descarga", "mio"]);
  assert.match(merged.notes, /^mi nota\nDescargado en /);

  // events on the family bus
  await until(() => hubEvents.some((e) => e.type === "links.media.done"));
  const ev = hubEvents.find((e) => e.type === "links.media.done" && e.data.id === done.id);
  assert.equal(ev.source, "links");
  assert.equal(ev.data.files, 1);
  assert.equal(ev.data.link_id, done.link_id);
  const failed = await run({ url: "https://www.youtube.com/gone/ev1" });
  assert.equal(failed.status, "failed");
  await until(() => hubEvents.some((e) => e.type === "links.media.failed" && e.data.id === failed.id));
  assert.match(hubEvents.find((e) => e.type === "links.media.failed" && e.data.id === failed.id).data.error, /no está disponible/);
});

test("files stream with Range support so the UI can play and seek", async () => {
  const meta = await get(videoId);
  const file = meta.files[0];
  const bytes = fs.readFileSync(file.path);
  const url = `${s.base}/api/media/${videoId}/file?i=0`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(Number(full.headers.get("content-length")), bytes.length);
  assert.match(full.headers.get("content-disposition"), /^inline; filename\*=UTF-8''T%C3%ADtulo%20vid1%20%5Bvid1%5D\.mp4$/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

  const part = await fetch(url, { headers: { Range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${bytes.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  const tail = await fetch(url, { headers: { Range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 5));
  const open = await fetch(url, { headers: { Range: `bytes=${bytes.length - 3}-` } });
  assert.equal(open.status, 206);
  assert.equal((await open.arrayBuffer()).byteLength, 3);
  const bad = await fetch(url, { headers: { Range: "bytes=999999-" } });
  assert.equal(bad.status, 416);
  assert.equal((await fetch(`${s.base}/api/media/${videoId}/file?i=9`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/media/nope/file`)).status, 404);
  const attach = await fetch(`${url}&download=1`);
  assert.match(attach.headers.get("content-disposition"), /^attachment;/);
  await attach.arrayBuffer();

  // a file that vanished from the disk is a clear 404
  const gone = await run({ url: "https://example.com/video/vanish" });
  fs.rmSync(gone.files[0].path);
  const missing = await s.call("GET", `/api/media/${gone.id}/file`);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /ya no está en el disco/);
});

test("REST: validation, filters, unknown ids, remove record vs files", async () => {
  for (const [body, pattern] of [
    [{ url: "" }, /URL/],
    [{ url: "ftp://example.com/x" }, /http\(s\)/],
    [{ url: "https://example.com/x", format: "gif" }, /format/],
    [{ url: "https://example.com/x", quality: "1" }, /quality/],
    [{ url: "https://example.com/x", dir: "relative/folder" }, /absoluta/],
    [{ url: "https://example.com/x", cookies_browser: "not a browser!" }, /Navegador/],
  ]) {
    const r = await s.call("POST", "/api/media", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, pattern);
  }
  assert.equal((await s.call("GET", "/api/media?status=bogus")).status, 400);
  assert.equal((await s.call("GET", "/api/media/nope")).status, 404);
  assert.equal((await s.call("POST", "/api/media/nope/cancel")).status, 404);
  assert.equal((await s.call("POST", "/api/media/nope/retry")).status, 404);
  assert.equal((await s.call("DELETE", "/api/media/nope")).status, 404);

  const done = await s.call("GET", "/api/media?status=done&limit=2");
  assert.equal(done.body.items.length, 2);
  assert.ok(done.body.total > 2);
  assert.ok(done.body.items.every((i) => i.status === "done"));
  assert.ok((await s.call("GET", "/api/media?status=failed")).body.items.every((i) => i.status === "failed"));

  // a per-call folder, created if needed
  const custom = path.join(tmp, "otra carpeta", "sub");
  const r = await run({ url: "https://example.com/video/custom", dir: custom });
  assert.equal(r.status, "done", r.error);
  assert.equal(path.dirname(r.files[0].path), custom);

  // remove the record: the file stays
  const rec = await s.call("DELETE", `/api/media/${r.id}`);
  assert.equal(rec.body.ok, true);
  assert.deepEqual(rec.body.files_deleted, []);
  assert.ok(fs.existsSync(r.files[0].path));
  assert.equal((await s.call("GET", `/api/media/${r.id}`)).status, 404);

  // files=1 deletes the files too (and the gallery folder when it is empty)
  const photos = await run({ url: "https://example.com/photos/del1", format: "image" });
  const folder = path.dirname(photos.files[0].path);
  const wipe = await s.call("DELETE", `/api/media/${photos.id}?files=1`);
  assert.equal(wipe.body.files_deleted.length, 2);
  assert.ok(!fs.existsSync(folder));
});

test("show in folder runs the file manager command for the produced file", async () => {
  const calls = [];
  const old = media.setRevealRunner((command) => calls.push(command));
  try {
    const r = await s.call("POST", `/api/media/${videoId}/reveal`, {});
    assert.equal(r.status, 200);
    const file = (await get(videoId)).files[0].path;
    assert.equal(r.body.path, file);
    assert.equal(calls.length, 1);
    if (process.platform === "win32") assert.deepEqual(calls[0].args, [`/select,"${file}"`]);
    else if (process.platform === "darwin") assert.deepEqual(calls[0].args, ["-R", file]);
    else assert.deepEqual(calls[0].args, [path.dirname(file)]);
    assert.equal((await s.call("POST", "/api/media/nope/reveal", {})).status, 404);
  } finally { media.setRevealRunner(old); }
});

test("the downloads folder: setting, relative paths refused, per-call override", async () => {
  const other = path.join(tmp, "Descargas nuevas");
  const bad = await s.call("PUT", "/api/media/settings", { dir: "descargas" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ruta absoluta/);
  const set = await s.call("PUT", "/api/media/settings", { dir: other });
  assert.equal(set.status, 200);
  assert.equal(set.body.dir, other);
  assert.equal(set.body.dir_is_default, false);
  assert.ok(fs.existsSync(other));
  const r = await run({ url: "https://example.com/video/setdir" });
  assert.equal(path.dirname(r.files[0].path), other);
  const clear = await s.call("PUT", "/api/media/settings", { dir: "" });
  assert.equal(clear.body.dir, mediaDir);
  assert.equal(clear.body.dir_is_default, true);
});

test("H.264/AAC: a VP9 file is re-encoded, an H.264 one is left alone, and it can be switched off", async () => {
  const before = fakes.calls("ffmpeg").length;
  const h264 = await run({ url: "https://example.com/video/ok264", format: "video" });
  const afterOk = fakes.calls("ffmpeg").slice(before);
  assert.ok(afterOk.length >= 1, "the file was probed");
  assert.ok(!afterOk.some((c) => c.argv.includes("libx264")), "H.264 + AAC is not re-encoded");
  assert.equal(h264.files[0].size, 8196);

  const vp9 = await run({ url: "https://example.com/vp9/v9", format: "video" });
  assert.equal(vp9.status, "done", vp9.error);
  const enc = fakes.calls("ffmpeg").find((c) => c.argv.includes("libx264"));
  assert.ok(enc, "ffmpeg was asked to encode");
  assert.ok(enc.argv.includes("aac") && enc.argv.includes("+faststart") && enc.argv.includes("yuv420p"));
  assert.equal(vp9.files[0].name, "Título v9 [v9].mp4");
  assert.equal(fs.readFileSync(vp9.files[0].path).subarray(0, 4).toString(), "H264", "the re-encoded file replaced the original");
  assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => n.includes("lh-h264")), []);

  setEnv({ LINKS_MEDIA_TRANSCODE: "0" });
  const n = fakes.calls("ffmpeg").length;
  const off = await run({ url: "https://example.com/vp9/v10", format: "video" });
  assert.equal(off.status, "done");
  assert.equal(fakes.calls("ffmpeg").length, n, "transcoding is off");
  setEnv({ LINKS_MEDIA_TRANSCODE: undefined });
});

test("missing programs give the install command, not a stack trace", async () => {
  const empty = tempDir();
  const saved = { ...fakes.env, PATH: process.env.PATH };
  try {
    setEnv({ LINKS_YTDLP: path.join(empty, "no-yt-dlp"), LINKS_GALLERYDL: path.join(empty, "no-gallery-dl"), PYTHON: path.join(empty, "no-python"), PATH: empty });
    const r = await run({ url: "https://www.youtube.com/video/nobin" });
    assert.equal(r.status, "failed");
    assert.match(r.error, /No se encontró yt-dlp/);
    assert.match(r.error, /python -m pip install -U yt-dlp gallery-dl/);
    const tools = await s.call("GET", "/api/media/tools?refresh=1");
    assert.equal(tools.body.ytdlp.found, false);
    assert.match(tools.body.ytdlp.hint, /pip install -U yt-dlp gallery-dl/);
    assert.equal(tools.body.python.found, false);
    const photo = await run({ url: "https://example.com/photos/nobin", format: "image" });
    assert.match(photo.error, /No se encontró gallery-dl/);

    // yt-dlp present, ffmpeg missing: audio cannot be extracted and says so; video still works
    setEnv({ LINKS_YTDLP: saved.LINKS_YTDLP, LINKS_GALLERYDL: saved.LINKS_GALLERYDL, LINKS_FFMPEG: path.join(empty, "no-ffmpeg") });
    const audio = await run({ url: "https://example.com/video/noff", format: "audio" });
    assert.equal(audio.status, "failed");
    assert.match(audio.error, /Falta ffmpeg/);
    const video = await run({ url: "https://example.com/video/noff2", format: "video" });
    assert.equal(video.status, "done", video.error);
    const call = ytCalls().filter((c) => lastUrl(c).endsWith("/video/noff2")).at(-1);
    assert.ok(!call.argv.includes("--merge-output-format"), "no merging without ffmpeg");
    assert.match(arg(call, "-f"), /^b\[ext=mp4\]/);
  } finally {
    setEnv({ ...saved });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("yt-dlp keeps itself current: an old build is refreshed first, and a 403 updates it and repeats the download", async () => {
  assert.equal(media.ytdlpAgeDays("2026.08.19", new Date("2026-10-02T00:00:00Z")), 44);
  assert.equal(media.ytdlpAgeDays("1.32.8-dev", new Date()), null);
  const updates = () => fakes.calls("yt-dlp").filter((c) => c.argv.includes("-U")).length;
  const version = path.join(fakes.dir, "ytdlp-version");
  try {
    // 1) a failure that looks like an old yt-dlp: update once, then repeat (no cookie round first)
    fs.rmSync(version, { force: true });
    setEnv({ LINKS_MEDIA_AUTO_UPDATE: undefined, LINKS_MEDIA_STALE_DAYS: "100000" });
    setSetting("media.last_auto_update", 0);
    const before = updates();
    const blockedBefore = ytCalls().filter((c) => lastUrl(c).includes("/blocked/")).length;
    const r = await run({ url: "https://www.youtube.com/blocked/b1", format: "video" });
    assert.equal(r.status, "done", r.error);
    assert.equal(updates(), before + 1);
    const blocked = ytCalls().filter((c) => lastUrl(c).includes("/blocked/")).slice(blockedBefore);
    assert.equal(blocked.length, 2, "one failed try, one after the update");
    assert.ok(!blocked[0].argv.includes("--cookies-from-browser"), "no browser cookies before updating");
    assert.match(r.detail || "", /actualizó solo/);
    assert.equal(media.getMediaSettings().last_auto_update.after, "2026.02.02");

    // 2) at most one automatic update every 6 hours: the next 403 is reported with the hint
    fs.rmSync(version, { force: true });
    const again = await run({ url: "https://www.youtube.com/blocked/b2", format: "video" });
    assert.equal(again.status, "failed");
    assert.match(again.error, /403/);
    assert.match(again.error, /Actualizar/);
    assert.equal(updates(), before + 1);

    // 3) an old build is refreshed before downloading
    fs.rmSync(version, { force: true });
    setEnv({ LINKS_MEDIA_STALE_DAYS: undefined });
    setSetting("media.last_auto_update", 0);
    const fresh = await run({ url: "https://example.com/video/stale1", format: "video" });
    assert.equal(fresh.status, "done", fresh.error);
    assert.equal(updates(), before + 2);
    assert.match(fresh.detail || "", /actualizado antes de descargar/);

    // 4) the setting turns it off
    fs.rmSync(version, { force: true });
    setSetting("media.last_auto_update", 0);
    await s.call("PUT", "/api/media/settings", { auto_update: false });
    assert.equal(media.getMediaSettings().auto_update, false);
    const off = await run({ url: "https://example.com/video/stale2", format: "video" });
    assert.equal(off.status, "done");
    assert.equal(updates(), before + 2);
  } finally {
    await s.call("PUT", "/api/media/settings", { auto_update: true });
    setEnv({ LINKS_MEDIA_AUTO_UPDATE: "0", LINKS_MEDIA_STALE_DAYS: undefined });
    fs.rmSync(version, { force: true });
  }
});

test("updating the tools: self-update when it is a binary, pip when it is a python module", async () => {
  fs.rmSync(path.join(fakes.dir, "ytdlp-version"), { force: true });
  const viaBinary = await s.call("POST", "/api/media/tools/update", { tools: ["ytdlp"] });
  assert.equal(viaBinary.status, 200);
  const y = viaBinary.body.results[0];
  assert.equal(y.tool, "ytdlp");
  assert.equal(y.ok, true);
  assert.equal(y.before, "2026.01.01");
  assert.equal(y.after, "2026.02.02");
  assert.equal(y.updated, true);
  assert.match(y.method, /-U/);
  const status = await s.call("GET", "/api/media/tools");
  assert.equal(status.body.ytdlp.version, "2026.02.02");
  const both = await s.call("POST", "/api/media/tools/update", {});
  assert.deepEqual(both.body.results.map((r) => r.tool), ["ytdlp", "gallerydl"]);
  assert.equal(both.body.results[1].after, "1.31.0");

  // as a module: python -m pip install -U yt-dlp
  fs.rmSync(path.join(fakes.dir, "ytdlp-version"), { force: true });
  const empty = tempDir();
  try {
    setEnv({ LINKS_YTDLP: undefined, LINKS_GALLERYDL: undefined, PATH: empty });
    const t = await s.call("GET", "/api/media/tools?refresh=1");
    assert.equal(t.body.ytdlp.how, "python-module");
    const viaPip = await s.call("POST", "/api/media/tools/update", { tools: ["ytdlp"] });
    const p = viaPip.body.results[0];
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.match(p.method, /-m pip install -U yt-dlp/);
    assert.equal(p.before, "2026.01.01");
    assert.equal(p.after, "2026.03.03");
    const pipCall = fakes.calls("python").find((c) => c.argv.includes("pip"));
    assert.deepEqual(pipCall.argv, ["-m", "pip", "install", "-U", "--disable-pip-version-check", "yt-dlp"]);
  } finally {
    setEnv({ ...fakes.env, PATH: savedEnv.PATH });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the MCP tools: download, status, probe, cancel, retry, tools and delete", async () => {
  // the catalog says how to use them
  const cat = await s.call("GET", "/api/agent/tools");
  const dl = cat.body.tools.find((t) => t.name === "media_download");
  assert.ok(dl.description.split("\n", 1)[0].length <= 110);
  for (const phrase of ["descárgame esto", "descarga este vídeo", "bájame", "bájate", "guarda el vídeo", "sácame el audio", "pásalo a mp3", "descargar de YouTube", "descargar reel", "descargar tweet"]) {
    assert.ok(dl.description.split("\nSinónimos: ")[1].includes(phrase), phrase);
  }
  assert.match(AGENT_INSTRUCTIONS, /media_download — not save_link/);
  assert.match(AGENT_INSTRUCTIONS, /never say a download worked unless/);
  assert.equal(cat.body.tools.find((t) => t.name === "media_delete").annotations.destructiveHint, true);
  assert.equal(cat.body.tools.find((t) => t.name === "media_status").annotations.readOnlyHint, true);

  // media_download waits and returns absolute paths and sizes
  const r = await s.agent("media_download", { url: "https://www.youtube.com/video/mcp1", save_link: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.status, "done");
  assert.equal(r.body.platform, "YouTube");
  assert.equal(path.isAbsolute(r.body.files[0].path), true);
  assert.ok(r.body.files[0].size > 0 && fs.existsSync(r.body.files[0].path));
  assert.equal(r.body.title, "Título mcp1");

  // a numeric quality is accepted
  const q = await s.agent("media_download", { url: "https://example.com/video/mcpq", quality: 480, format: "video", save_link: false });
  assert.equal(q.body.ok, true);
  assert.match(arg(ytCalls().filter((c) => lastUrl(c).endsWith("/video/mcpq")).at(-1), "-f"), /height<=480/);

  // a failure is reported as ok: false with the error, never as success
  const fail = await s.agent("media_download", { url: "https://www.youtube.com/gone/mcp2" });
  assert.equal(fail.status, 200);
  assert.equal(fail.body.ok, false);
  assert.equal(fail.body.status, "failed");
  assert.match(fail.body.error, /no está disponible/);
  assert.deepEqual(fail.body.files, []);

  // wait: false returns at once; media_status follows; cancel stops it
  const bg = await s.agent("media_download", { url: "https://example.com/slow/mcp3", wait: false, save_link: false });
  assert.equal(bg.body.ok, false);
  assert.ok(["queued", "downloading"].includes(bg.body.status));
  assert.match(bg.body.message, /media_status/);
  await until(async () => (await s.agent("media_status", { id: bg.body.id })).body.progress > 0);
  const st = await s.agent("media_status", { id: bg.body.id });
  assert.equal(st.body.status, "downloading");
  assert.equal(st.body.speed, "1.0 KB/s");
  const list = await s.agent("media_status", { status: "active" });
  assert.equal(list.body.items[0].id, bg.body.id);
  const cancel = await s.agent("media_cancel", { id: bg.body.id });
  assert.ok(["downloading", "cancelled"].includes(cancel.body.status));
  assert.equal((await waitTerminal(bg.body.id)).status, "cancelled");
  assert.equal((await s.agent("media_status", { id: "nope" })).status, 400);

  // retry waits for the result
  fs.writeFileSync(path.join(fakes.dir, "flaky-ok"), "1");
  const flaky = await run({ url: "https://example.com/flaky/mcp4" });
  assert.equal(flaky.status, "done");
  fs.rmSync(path.join(fakes.dir, "flaky-ok"));
  const bad = await run({ url: "https://example.com/flaky/mcp5" });
  assert.equal(bad.status, "failed");
  fs.writeFileSync(path.join(fakes.dir, "flaky-ok"), "1");
  const retry = await s.agent("media_retry", { id: bad.id });
  assert.equal(retry.body.ok, true, JSON.stringify(retry.body));

  // probe: no download
  const nBefore = ytCalls().length;
  const probe = await s.agent("media_probe", { url: "https://www.youtube.com/video/pr1" });
  assert.equal(probe.status, 200, JSON.stringify(probe.body));
  assert.equal(probe.body.title, "Título de prueba");
  assert.equal(probe.body.uploader, "Canal de prueba");
  assert.equal(probe.body.duration, 125.5);
  assert.deepEqual(probe.body.heights, [1080, 720, 360]);
  assert.equal(probe.body.is_playlist, false);
  assert.equal(probe.body.photo_post, false);
  assert.equal(probe.body.platform, "YouTube");
  assert.ok(ytCalls().slice(nBefore).every((c) => c.argv.includes("--skip-download")), "probe never downloads");
  const list2 = await s.agent("media_probe", { url: "https://example.com/list/pl", playlist: true });
  assert.equal(list2.body.is_playlist, true);
  assert.equal(list2.body.entries, 2);
  assert.deepEqual(list2.body.entry_titles, ["Uno", "Dos"]);
  const photo = await s.agent("media_probe", { url: "https://www.instagram.com/photos/pp1/" });
  assert.equal(photo.body.photo_post, true);
  assert.equal(photo.body.files, 2);
  assert.equal(photo.body.uploader, "autor_test");
  const gone = await s.agent("media_probe", { url: "https://www.youtube.com/gone/pr2" });
  assert.equal(gone.status, 400);
  assert.match(gone.body.error, /no está disponible/);

  // media_tools
  const tools = await s.agent("media_tools", {});
  assert.equal(tools.body.ytdlp.found, true);
  assert.equal(tools.body.settings.dir, mediaDir);
  assert.equal(tools.body.update, undefined);
  const upd = await s.agent("media_tools", { update: true, tools: ["gallerydl"] });
  assert.equal(upd.body.update.length, 1);
  assert.equal(upd.body.update[0].tool, "gallerydl");

  // media_delete: files only with delete_files AND confirm
  const refuse = await s.agent("media_delete", { id: r.body.id, delete_files: true });
  assert.equal(refuse.status, 400);
  assert.match(refuse.body.error, /confirm: true/);
  assert.ok(fs.existsSync(r.body.files[0].path));
  const recordOnly = await s.agent("media_delete", { id: q.body.id });
  assert.equal(recordOnly.body.ok, true);
  assert.ok(fs.existsSync(q.body.files[0].path));
  const wipe = await s.agent("media_delete", { id: r.body.id, delete_files: true, confirm: true });
  assert.deepEqual(wipe.body.files_deleted, [r.body.files[0].path]);
  assert.ok(!fs.existsSync(r.body.files[0].path));
});

test("on boot, interrupted downloads fail with a clear reason and waiting ones are queued again", async () => {
  const insert = (id, status) => db().prepare(
    `INSERT INTO media_downloads (id, url, platform, format, quality, status, dir, save_link, created_at) VALUES (?, ?, 'Otro (yt-dlp)', 'auto', 'best', ?, ?, 0, ?)`,
  ).run(id, `https://example.com/video/${id}`, status, mediaDir, now());
  insert("boot-running", "downloading");
  insert("boot-processing", "processing");
  insert("boot-waiting", "queued");
  const out = media.initMedia();
  assert.equal(out.requeued, 1);
  for (const id of ["boot-running", "boot-processing"]) {
    const row = await get(id);
    assert.equal(row.status, "failed");
    assert.match(row.error, /interrumpida al cerrar la app/);
  }
  const waiting = await waitTerminal("boot-waiting");
  assert.equal(waiting.status, "done", waiting.error);
  assert.equal(waiting.files.length, 1);
});

test("closing the app kills the running download and leaves the waiting ones for the next start", async () => {
  const slowPid = path.join(fakes.dir, "slow.pid");
  const childPid = path.join(fakes.dir, "grandchild.pid");
  fs.rmSync(slowPid, { force: true });
  fs.rmSync(childPid, { force: true });
  const a = await start({ url: "https://example.com/slow/sd1" });
  await until(() => fs.existsSync(childPid) && fs.existsSync(slowPid));
  const b = await start({ url: "https://example.com/video/sd2" });
  const pid = Number(fs.readFileSync(slowPid, "utf8"));
  const grandchild = Number(fs.readFileSync(childPid, "utf8"));
  await media.shutdownMedia();
  const killed = await get(a.id);
  assert.equal(killed.status, "failed");
  assert.match(killed.error, /interrumpida al cerrar la app/);
  assert.ok(!isAlive(pid) && !isAlive(grandchild));
  assert.equal((await get(b.id)).status, "queued", "it never started, so it stays queued");
  assert.equal(media.initMedia().requeued, 1);
  assert.equal((await waitTerminal(b.id)).status, "done");
});
