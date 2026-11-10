// Escuchar: the narrated audio of a link, its resume point and the «Escuchar después» queue.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { bootServer, waitFetched, serveText, FIXTURE_ARTICLE } from "./helpers.js";
import { startFakeHub } from "./fake-hub.js";
import * as listen from "../server/listen.js";
import * as family from "../server/hoard-link.js";
import { db, now } from "../server/db.js";
import { digestDir } from "../server/videodigest.js";

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(997, 7)]);
const SRT = "1\r\n00:00:00,000 --> 00:00:02,500\r\nThe Real Article Title.\r\n\r\n2\r\n00:00:02,900 --> 00:01:58,000\r\nThis is a paragraph of fixture body text.\r\n";

/** Prospero for the tests: remembers what it was asked and finishes after `pending` polls. */
function fakeStudio() {
  const st = { narrations: [], polls: 0, pending: 1, failWith: null, loseJob: 0, slow: 0, cancelled: [] };
  return {
    st,
    async narrate(request) { st.narrations.push(request); return `job_${st.narrations.length}`; },
    async job() {
      st.polls += 1;
      if (st.slow > 0) { st.slow -= 1; throw Object.assign(new Error("tardó demasiado"), { code: "timeout" }); }
      if (st.loseJob > 0) { st.loseJob -= 1; throw new Error("unknown job"); }
      if (st.failWith) { const error = st.failWith; st.failWith = null; return { state: "failed", error }; }
      if (st.pending > 0) { st.pending -= 1; return { state: "running", progress: 0.5, message: "chapter 1/1: sentence 3" }; }
      return { state: "done", progress: 1, outputs: { duration_s: 118, chapters: [{ index: 0, title: "Chapter 1", start_s: 0, duration_s: 118 }] } };
    },
    async download(id, kind, dest) { fs.writeFileSync(dest, kind === "final" ? MP3 : SRT); return fs.statSync(dest).size; },
    async cancel(id) { st.cancelled.push(id); },
  };
}

let s, fixture, studio, oldWait;
const save = async (suffix = "") => {
  const r = await s.call("POST", "/api/links", { url: `${fixture.url}${suffix}` });
  await waitFetched(s, r.body.id);
  return r.body.id;
};

before(async () => {
  s = await bootServer();
  fixture = await serveText(FIXTURE_ARTICLE);
  oldWait = listen.setPollWait(0);
});
after(async () => {
  listen.setStudio(null);
  listen.setPollWait(oldWait);
  await s.stop();
  await fixture.close();
});
beforeEach(() => { studio = fakeStudio(); listen.setStudio(studio); });

test("the text for the voice has no addresses, markup or reference marks", () => {
  const clean = listen.cleanForSpeech("# Título\n\nUn **párrafo** con [un enlace](https://example.com/x) y https://example.com/suelto .[12]\n\n- punto uno\n\n\n\n```js\ncode()\n```\nFin [cita requerida]");
  assert.equal(clean, "Título\n\nUn párrafo con un enlace y.\n\npunto uno\n\nFin");
  assert.deepEqual(listen.parseSrt(SRT), [
    { start_s: 0, end_s: 2.5, text: "The Real Article Title." },
    { start_s: 2.9, end_s: 118, text: "This is a paragraph of fixture body text." },
  ]);
});

test("a link is narrated once, served with ranges, and remembers where the listener stopped", async () => {
  const id = await save();
  assert.equal((await s.call("GET", `/api/links/${id}/listen`)).body.status, "none");
  const started = await s.call("POST", `/api/links/${id}/listen`, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(["queued", "running", "done"].includes(started.body.status));
  const view = await listen.waitListen(id);
  assert.equal(view.status, "done");
  assert.equal(view.source, "article");
  assert.equal(view.voice, "en_US-lessac-medium", "the fixture is in English");
  assert.equal(view.duration_s, 118);
  assert.equal(view.duration, "1:58");
  assert.equal(view.position_s, 0);
  assert.equal(view.stale, false);
  assert.ok(fs.existsSync(view.file) && view.file.endsWith(path.join("listen", id, "audio.mp3")));
  assert.equal(view.chapters.length, 1);
  const sent = studio.st.narrations[0];
  assert.ok(sent.text.startsWith("The Real Article Title. Por Jane Fixture.\n\n"), sent.text.slice(0, 80));
  assert.ok(!/https?:|Copyright fixture footer|Site Nav Header/.test(sent.text));
  assert.equal(sent.voice, "en_US-lessac-medium");

  // the same text and voice are not narrated twice
  const again = await s.call("POST", `/api/links/${id}/listen`, {});
  assert.equal(again.body.existing, true);
  assert.equal(studio.st.narrations.length, 1);

  // the audio, whole and by ranges
  const whole = await fetch(`${s.base}${view.audio_url}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "audio/mpeg");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), MP3);
  const part = await fetch(`${s.base}/api/links/${id}/listen/audio`, { headers: { Range: "bytes=500-" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 500-999/1000");
  assert.equal((await part.arrayBuffer()).byteLength, 500);
  assert.equal((await fetch(`${s.base}/api/links/${id}/listen/audio`, { headers: { Range: "bytes=5000-" } })).status, 416);
  assert.equal((await s.call("GET", `/api/links/${id}/listen/lines`)).body.lines.length, 2);

  // resume point
  const at = await s.call("POST", `/api/links/${id}/listen/position`, { position_s: 59 });
  assert.equal(at.body.position_s, 59);
  assert.equal(at.body.position, "0:59");
  assert.equal(at.body.percent, 50);
  assert.equal(at.body.finished, false);
  assert.equal((await s.call("GET", `/api/links/${id}`)).body.read_at, null);
  // heard to the end: back to the start, marked read
  const end = await s.call("POST", `/api/links/${id}/listen/position`, { position_s: 117.5 });
  assert.equal(end.body.finished, true);
  assert.equal(end.body.position_s, 0);
  assert.ok((await s.call("GET", `/api/links/${id}`)).body.read_at);
  assert.equal((await s.call("POST", `/api/links/nope/listen/position`, { position_s: 1 })).status, 404);

  // another voice narrates again; deleting the link removes its audio
  const other = await s.call("POST", `/api/links/${id}/listen`, { voice: "en_GB-alba-medium" });
  assert.equal(other.body.existing, false);
  assert.equal((await listen.waitListen(id)).voice, "en_GB-alba-medium");
  assert.equal(studio.st.narrations.length, 2);
  await s.call("DELETE", `/api/links/${id}`);
  assert.equal(fs.existsSync(listen.listenDir(id)), false);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM link_listen WHERE link_id = ?").get(id).n, 0);
});

test("«Escuchar después» keeps its order and lets go of what was heard", async () => {
  const [a, b, c] = [await save("a"), await save("b"), await save("c")];
  await s.call("POST", "/api/listen/queue", { id: a });
  await s.call("POST", "/api/listen/queue", { id: b });
  const third = await s.call("POST", "/api/listen/queue", { id: c, position: 1 });
  assert.deepEqual(third.body.queue.map((q) => q.link_id), [c, a, b]);
  for (const id of [a, b, c]) assert.equal((await listen.waitListen(id)).status, "done", "adding to the queue narrates it");
  assert.equal(studio.st.narrations.length, 3);
  const ordered = await s.call("POST", "/api/listen/queue/order", { ids: [b, c] });
  assert.deepEqual(ordered.body.queue.map((q) => [q.link_id, q.queue_pos]), [[b, 1], [c, 2], [a, 3]]);
  // the one that was heard to the end leaves the queue
  await s.call("POST", `/api/links/${b}/listen/position`, { position_s: 10, finished: true });
  const page = (await s.call("GET", "/api/listen")).body;
  assert.deepEqual(page.queue.map((q) => q.link_id), [c, a]);
  assert.ok(page.library.some((l) => l.link_id === b && l.finished && !l.queued));
  assert.equal(page.settings.voice, "");
  assert.deepEqual((await s.call("DELETE", `/api/listen/queue/${c}`)).body.queue.map((q) => q.link_id), [a]);
  assert.equal((await s.call("GET", `/api/links/${c}/listen`)).body.status, "done", "leaving the queue keeps the audio");
  assert.deepEqual((await s.call("DELETE", "/api/listen/queue")).body.queue, []);
  // deleting the audio keeps the link
  assert.equal((await s.call("DELETE", `/api/links/${a}/listen`)).body.ok, true);
  assert.equal((await s.call("GET", `/api/links/${a}/listen`)).body.status, "none");
  assert.equal((await s.call("GET", `/api/links/${a}`)).status, 200);
  for (const id of [a, b, c]) await s.call("DELETE", `/api/links/${id}`);
});

test("failures are told as they are, and a job the studio forgot is narrated again", async () => {
  const id = await save("f");
  studio.st.failWith = "voice es_XX is not downloaded";
  await s.call("POST", `/api/links/${id}/listen`, {});
  const failed = await listen.waitListen(id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /voice es_XX is not downloaded/);
  assert.equal(failed.file, undefined);
  // Prospero restarted in the middle: the job is unknown once, the narration is asked again and finishes
  studio.st.loseJob = 1;
  await s.call("POST", `/api/links/${id}/listen`, { regenerate: true });
  assert.equal((await listen.waitListen(id)).status, "done");
  assert.equal(studio.st.narrations.length, 3);
  // a busy machine: the studio does not answer in time twice; the same job is asked again, not narrated again
  studio.st.slow = 2;
  await s.call("POST", `/api/links/${id}/listen`, { regenerate: true });
  assert.equal((await listen.waitListen(id)).status, "done");
  assert.equal(studio.st.narrations.length, 4);
  // nothing to read: a saved URL whose text never arrived
  const empty = await serveText("<html><body></body></html>");
  const r = await s.call("POST", "/api/links", { url: empty.url });
  await waitFetched(s, r.body.id);
  const none = await s.call("POST", `/api/links/${r.body.id}/listen`, {});
  assert.equal(none.status, 409);
  assert.match(none.body.error, /no tiene texto/);
  assert.equal((await s.call("POST", "/api/links/nope/listen", {})).status, 404);
  await empty.close();
  for (const x of [id, r.body.id]) await s.call("DELETE", `/api/links/${x}`);
});

test("a digested video is narrated from its summary and chapters", async () => {
  const id = await save("v");
  const ts = now();
  db().prepare("INSERT INTO link_digest (link_id, status, created_at, updated_at) VALUES (?, 'done', ?, ?)").run(id, ts, ts);
  fs.mkdirSync(digestDir(id), { recursive: true });
  fs.writeFileSync(path.join(digestDir(id), "digest.json"), JSON.stringify({
    title: "Charla sobre memoria", status: "done",
    summary: { tldr: "La charla explica cómo repasar a intervalos crecientes mejora el recuerdo.", key_points: ["Repasar justo antes de olvidar", "Intervalos cada vez más largos"] },
    chapters: [{ id: "c1", start: 0, end: 60, title: "La curva del olvido", summary: "Ebbinghaus midió cuánto se olvida con el tiempo." },
      { id: "c2", start: 60, end: 120, title: "", said: "y ahora vamos a ver un ejemplo práctico" }],
  }));
  await s.call("POST", `/api/links/${id}/listen`, {});
  const view = await listen.waitListen(id);
  assert.equal(view.status, "done");
  assert.equal(view.source, "video_digest");
  const text = studio.st.narrations[0].text;
  assert.ok(text.startsWith("The Real Article Title.\n\nLa charla explica cómo repasar"), text.slice(0, 90));
  assert.match(text, /Puntos clave\. Repasar justo antes de olvidar\. Intervalos cada vez más largos\./);
  assert.match(text, /La curva del olvido\. Ebbinghaus midió/);
  assert.match(text, /Empieza diciendo: y ahora vamos a ver un ejemplo práctico/);
  assert.ok(!text.includes("This is a paragraph of fixture body text"), "the page text is not read when there is a digest");
  await s.call("DELETE", `/api/links/${id}`);
});

test("the assistant listens through the tools", async () => {
  const id = await save("t");
  const made = await s.agent("listen_link", { id, wait_s: 20, queue: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.status, "done");
  assert.equal(made.body.existing, false);
  assert.ok(fs.existsSync(made.body.file));
  assert.equal(made.body.queued, true);
  assert.equal((await s.agent("listen_link", { id })).body.existing, true);
  const all = await s.agent("listen_status", {});
  assert.deepEqual(all.body.queue.map((q) => q.link_id), [id]);
  assert.ok(all.body.library.some((l) => l.link_id === id));
  assert.equal((await s.agent("listen_position", { id, position_s: 30 })).body.position_s, 30);
  assert.equal((await s.agent("listen_status", { id })).body.position, "0:30");
  assert.deepEqual((await s.agent("listen_queue", { action: "remove", id })).body.queue, []);
  assert.deepEqual((await s.agent("listen_queue", { action: "add", id })).body.queue.map((q) => q.link_id), [id]);
  assert.equal((await s.agent("listen_queue", { action: "move", id })).status, 400);
  assert.deepEqual((await s.agent("listen_queue", { action: "clear" })).body.queue, []);
  assert.equal((await s.agent("listen_delete", { id })).body.ok, true);
  assert.equal((await s.agent("listen_status", { id })).body.status, "none");
  assert.equal((await s.agent("listen_link", { url: "https://example.com/not-saved" })).status, 400);
  await s.call("DELETE", `/api/links/${id}`);
});

test("through the hub: the voice module is turned on, the job followed and the file copied", async () => {
  listen.setStudio(null);
  const hub = await startFakeHub();
  const files = http.createServer((req, res) => {
    const m = /^\/api\/voice\/audiobook\/(job_x)\/download\?file=(final|srt)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    res.end(m[2] === "final" ? MP3 : SRT);
  });
  await new Promise((resolve) => files.listen(0, "127.0.0.1", resolve));
  hub.state.apps.prospero = { state: "running", url: `http://127.0.0.1:${files.address().port}/` };
  let on = false;
  let polls = 0;
  hub.state.tools["prospero.studio_module_set"] = (a) => { on = a.module === "generation" && a.enabled === true && a.reason.length > 3; return { id: "generation", enabled: true }; };
  hub.state.tools["prospero.voice_audiobook"] = () => (on ? { job: { id: "job_x", state: "queued", progress: 0 } } : { __error: { status: 409, error: "generation is OFF. Enable it explicitly in Modules." } });
  hub.state.tools["prospero.voice_job"] = () => (++polls < 2 ? { id: "job_x", state: "running", progress: 0.4, message: "chapter 1/1" }
    : { id: "job_x", state: "done", progress: 1, outputs: { duration_s: 118, chapter_count: 1, chapters: [{ index: 0, title: "Chapter 1", start_s: 0, duration_s: 118 }] } });
  family.configure({ app: "links", dataDir: s.dataDir, hub: hub.url });
  try {
    const id = await save("h");
    await s.call("POST", `/api/links/${id}/listen`, { voice: "es_ES-sharvard-medium" });
    const view = await listen.waitListen(id);
    assert.equal(view.status, "done", JSON.stringify(view));
    assert.deepEqual(fs.readFileSync(view.file), MP3);
    assert.equal(view.duration_s, 118);
    assert.deepEqual(hub.state.calls.map((c) => c.tool), ["voice_audiobook", "studio_module_set", "voice_audiobook", "voice_job", "voice_job"]);
    const asked = hub.state.calls.find((c) => c.tool === "voice_audiobook").arguments;
    assert.equal(asked.format, "mp3");
    assert.deepEqual(asked.voice, { engine_id: "piper", voice_ref: "es_ES-sharvard-medium", language: "en" });
    assert.ok(asked.reason.length > 3 && asked.text.includes("fixture body text"));
    assert.equal((await s.call("GET", `/api/links/${id}/listen/lines`)).body.lines.length, 2);
    await s.call("DELETE", `/api/links/${id}`);
    // with the hub gone the reason is said, and nothing is left half done
    family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
    const lone = await save("h2");
    await s.call("POST", `/api/links/${lone}/listen`, {});
    const down = await listen.waitListen(lone);
    assert.equal(down.status, "failed");
    assert.match(down.error, /Hoard Hub no responde/);
    await s.call("DELETE", `/api/links/${lone}`);
  } finally {
    family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
    await hub.stop();
    await new Promise((resolve) => files.close(resolve));
  }
});
