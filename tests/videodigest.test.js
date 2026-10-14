// Video digest: the pure rules (segmentation, chapters, tokens, layers) and the whole job on a generated video with mocked speech to text,
// OCR and models.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, serveText, waitFetched, tempDir, FIXTURE_ARTICLE } from "./helpers.js";
import * as core from "../server/digest-core.js";
import * as video from "../server/videoinsight.js";
import * as digest from "../server/videodigest.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const SKIP = hasFfmpeg ? false : "ffmpeg is not installed";

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------

const flat = (v) => new Uint8Array(core.THUMB_BYTES).fill(v);

test("parseTime and clock", () => {
  assert.equal(core.parseTime("83"), 83);
  assert.equal(core.parseTime("1:23"), 83);
  assert.equal(core.parseTime("1:02:03"), 3723);
  assert.equal(core.parseTime("1m23s"), 83);
  assert.equal(core.parseTime(12.5), 12.5);
  assert.equal(core.parseTime("ayer"), null);
  assert.equal(core.clock(3723), "1:02:03");
  assert.equal(core.clock(83), "1:23");
});

test("imageTokens follows the resize rules; naive frame cost scales with the duration", () => {
  assert.equal(core.imageTokens(1000, 1000), Math.ceil((1000 * 1000) / 750));
  const big = core.imageTokens(3840, 2160);
  assert.ok(big <= 1540 && big > 1400, `4K frame ~1.5k tokens, got ${big}`);
  assert.equal(core.naiveFrameTokens(3600, 1280, 720, 5), 720 * core.imageTokens(1280, 720));
  assert.equal(core.naiveFrameTokens(0, 1280, 720, 5), 0);
});

test("segmentThumbs: one segment per stable picture, short flashes absorbed, montage kept in pieces", () => {
  const thumbs = [...Array(8).fill(flat(0)), ...Array(8).fill(flat(255)), ...Array(8).fill(flat(128))];
  const segs = core.segmentThumbs(thumbs, 2, { threshold: 0.1, minSegS: 2, duration: 12 });
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 4], [4, 8], [8, 12]]);
  // a one-frame flash inside a stable shot does not become its own segment
  const flash = [...Array(10).fill(flat(0)), flat(255), ...Array(10).fill(flat(0))];
  assert.ok(core.segmentThumbs(flash, 2, { threshold: 0.1, minSegS: 2 }).length <= 2);
  // a montage of half-second cuts becomes segments of a couple of seconds, not one and not dozens
  const montage = [];
  for (let i = 0; i < 40; i++) montage.push(flat(i % 2 ? 250 : 5));
  const m = core.segmentThumbs(montage, 2, { threshold: 0.1, minSegS: 2 });
  assert.ok(m.length >= 4 && m.length <= 10, `montage gave ${m.length}`);
  assert.equal(m[0].start, 0);
  assert.equal(m[m.length - 1].end, 20);
});

test("capSegments merges the most alike neighbours; markRepeats finds a slide shown again", () => {
  const thumbs = [flat(0), flat(10), flat(200), flat(0)];
  const segs = thumbs.map((_, i) => ({ start: i * 5, end: i * 5 + 5, anchor: i }));
  const capped = core.capSegments(segs, thumbs, 3);
  assert.deepEqual(capped.map((s) => [s.start, s.end]), [[0, 10], [10, 15], [15, 20]]);
  assert.deepEqual(core.markRepeats(segs, thumbs, 0.02), [null, null, null, 0]);
});

test("planChapters cuts near the target at picture changes and pauses; short clips are one chapter", () => {
  assert.deepEqual(core.planChapters(40, [], []), [{ start: 0, end: 40 }]);
  const speech = [];
  for (let t = 0; t < 600; t += 10) speech.push({ start_s: t, end_s: t + 8, text: `frase ${t}.` });
  const visual = [{ start: 0, end: 130 }, { start: 130, end: 290 }, { start: 290, end: 600 }];
  const ch = core.planChapters(600, speech, visual);
  assert.ok(ch.length >= 6 && ch.length <= 15, `${ch.length} chapters`);
  assert.equal(ch[0].start, 0);
  assert.equal(ch[ch.length - 1].end, 600);
  for (let i = 1; i < ch.length; i++) assert.equal(ch[i].start, ch[i - 1].end);
  assert.ok(ch.some((c) => c.start === 130 || c.end === 130), "a picture change is a preferred cut");
});

test("paragraphs, cleanOcr and textSimilarity", () => {
  const p = core.paragraphs([{ start_s: 0, end_s: 2, text: "Hola." }, { start_s: 2.2, end_s: 4, text: "Seguimos" }, { start_s: 9, end_s: 10, text: "Tras la pausa" }]);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, "Hola. Seguimos");
  assert.equal(core.cleanOcr("  def  main():\n|\n~\n  return 42  "), "def main():\nreturn 42");
  assert.equal(core.textSimilarity("uno dos tres", "tres dos uno"), 1);
  assert.ok(core.textSimilarity("uno dos tres", "cuatro cinco") === 0);
  assert.ok(core.textSimilarity("MAXPOWER NASA KENNEDYSPACE CENTER", "MAXPOWER NASAKENNEDYSPACECENTER") >= 0.9, "same screen, different spacing");
  assert.equal(core.decodeEntities("astronauts &amp; more &#39;hi&#39; &#x1F680; &bogus;"), "astronauts & more 'hi' 🚀 &bogus;");
});

test("renderers keep literal and generated material apart", () => {
  const m = {
    title: "Charla", url: "https://example.com/v", duration: 125, generated_at: "2026-10-15 01:00", post_text: "Mira esto",
    summary: { tldr: "Explica la caché.", key_points: ["Punto A"], model: "glm" }, focus: "", notes: [],
    chapters: [{ id: 1, start: 0, end: 125, title: "Caché", summary: "Habla de la caché.", focus: false }],
    visual: [{ idx: 1, start: 0, end: 60, t: 30, file: "frames/v001.jpg", same_as: null, kind: "slide", caption: "", important: false, ocr: "CACHE L2", ocr_same_as: null },
      { idx: 2, start: 60, end: 125, t: 90, file: "", same_as: 1, kind: "", caption: "", important: false, ocr: "" }],
    transcript: { status: "done", via: "mock", segments: [{ start_s: 0, end_s: 3, text: "Hoy hablamos de la caché." }] },
  };
  const card = core.renderCard(m, { full: 900, index: 100, visual: 200, transcript: 300, naive_5s: 30000 });
  assert.match(card, /\*\*Resumen\*\* \*\(generado · glm\)\*: Explica la caché\./);
  assert.match(card, /Texto de la publicación\*\* \(literal\)/);
  assert.match(card, /un fotograma cada 5 s costaría ~30000/);
  const idx = core.renderIndex(m);
  assert.match(idx, /### 1 · \[0:00–2:05\] Caché \*\(generado · glm\)\*/);
  assert.match(idx, /texto: «CACHE L2»/);
  const vis = core.renderVisual(m);
  assert.match(vis, /OCR literal/);
  assert.match(vis, /vuelve el mismo plano que v1/);
  assert.match(core.renderTranscript(m), /\[0:00\] Hoy hablamos de la caché\./);
  assert.match(core.renderTranscript(m, { from: 10, to: 20 }), /sin transcripción/);
});

// ---------------------------------------------------------------------------
// the job, end to end
// ---------------------------------------------------------------------------

let work;
let clip;

/** 12 s: red, blue, red again (a repeated "slide"), 4 s each, with a sine tone. */
function makeVideo(file) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const c of ["red", "blue", "red"]) args.push("-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=10:d=4`);
  args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=12");
  args.push("-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a", "-c:a", "aac", "-pix_fmt", "yuv420p", file);
  const r = spawnSync("ffmpeg", args, { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
}

before(() => {
  work = tempDir();
  clip = path.join(work, "talk.mp4");
  if (hasFfmpeg) makeVideo(clip);
  process.env.LINKS_VIDEO_RETRY_S = "0,0,0";
});
after(() => { fs.rmSync(work, { recursive: true, force: true }); delete process.env.LINKS_VIDEO_RETRY_S; });
afterEach(() => { video.setSttProvider(null); digest.setOcrProvider(null); digest.setChatProvider(null); });

const stt = async () => ({ ok: true, language: "es", via: "mock-stt", model: "tiny", text: "Hoy explico la caché de nivel dos. Luego vemos el resultado final.",
  segments: [{ start_s: 0.5, end_s: 3.5, text: "Hoy explico la caché de nivel dos." }, { start_s: 6, end_s: 9, text: "Luego vemos el resultado final." }] });

function mockChat(calls, { vision = true } = {}) {
  return async (args) => {
    calls.push(args);
    const props = args.json?.properties || {};
    if (args.capability === "vision") {
      if (!vision) return { ok: false, error: "no_model", detail: "no vision", text: "", json: null };
      return { ok: true, model: "mock-vl", json: { kind: "slide", caption: "Una diapositiva de color liso.", important: false } };
    }
    if (props.chapters) {
      const input = JSON.parse(args.messages[1].content);
      return { ok: true, model: "mock-llm", json: { chapters: input.chapters.map((c) => ({ id: c.id, title: `Capítulo ${c.id}`, summary: `Resumen ${c.id}.` })) } };
    }
    if (props.tldr) return { ok: true, model: "mock-llm", json: { tldr: "Un vídeo sobre la caché.", key_points: ["Nivel dos"], focus_answer: "Habla de la caché L2.", focus_chapters: [1] } };
    if (props.sentences) {
      return { ok: true, model: "mock-llm", json: { sentences: [
        { text: "Explica la caché de nivel dos.", citations: [{ ref: "s0", quote: "explico la caché de nivel dos" }] },
        { text: "Dice algo inventado.", citations: [{ ref: "s1", quote: "esto no lo dijo nunca" }] },
        { text: "En pantalla pone CACHE L2.", citations: [{ ref: "v1", quote: "CACHE L2" }] },
      ] } };
    }
    return { ok: false, error: "no_model" };
  };
}

async function savedLink(s) {
  const page = await serveText(FIXTURE_ARTICLE);
  try {
    const created = await s.call("POST", "/api/links", { url: page.url });
    await waitFetched(s, created.body.id);
    return created.body.id;
  } finally { await page.close(); }
}

test("digest of a local video: layers, frames, OCR, chapters, sheet, then ask / find / frame", { skip: SKIP, timeout: 120_000 }, async () => {
  const s = await bootServer();
  try {
    const calls = [];
    video.setSttProvider(stt);
    digest.setOcrProvider(async (file) => ({ ok: true, backend: "mock-ocr", text: path.basename(file) === "v001.jpg" ? "CACHE L2\n|\nlatencia 4 ns" : "RESULTADO" }));
    digest.setChatProvider(mockChat(calls));
    const id = await savedLink(s);
    const started = await s.call("POST", `/api/links/${id}/digest`, { path: clip, focus: "la caché" });
    assert.equal(started.status, 202);
    const row = await digest.waitDigest(id, 90_000);
    assert.equal(row.status, "done", `${row.status}: ${row.error} ${row.detail}`);

    const view = (await s.call("GET", `/api/links/${id}/digest?level=brief`)).body;
    assert.equal(view.status, "done");
    for (const k of ["card", "index", "visual", "transcript", "full", "overview"]) assert.ok(view.files[k] && fs.existsSync(view.files[k]), `file ${k}`);
    assert.match(view.text, /Un vídeo sobre la caché\./);
    assert.match(view.text, /Sobre el foco\*\* \*\(generado · mock-llm\)\*: Habla de la caché L2\./);
    assert.match(view.text, /Capítulo 1/);
    assert.ok(view.tokens > 50 && view.tokens < 3000, `brief tokens ${view.tokens}`);
    const st = view.stats;
    assert.equal(st.visual_segments, 3);
    assert.equal(st.distinct_frames, 2, "the red shot shown again is a repeat, not a new frame");
    assert.equal(st.engines.ocr, "mock-ocr");
    assert.equal(st.engines.vision, "mock-vl");
    assert.ok(st.tokens.naive_1s > st.tokens.full, "the digest is cheaper than looking at the frames");

    const visual = (await s.call("GET", `/api/links/${id}/digest?level=visual`)).body.text;
    assert.match(visual, /CACHE L2\nlatencia 4 ns/, "OCR kept literally, noise lines dropped");
    assert.match(visual, /vuelve el mismo plano que v1/);
    const transcript = (await s.call("GET", `/api/links/${id}/digest?level=transcript&from=5&to=12`)).body.text;
    assert.match(transcript, /Luego vemos el resultado final/);
    assert.doesNotMatch(transcript, /nivel dos/);

    const sheet = await fetch(`${s.base}/api/links/${id}/digest/files/overview.jpg`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.headers.get("content-type"), "image/jpeg");
    assert.equal((await fetch(`${s.base}/api/links/${id}/digest/files/..%2Fsource.mp4`)).status, 404);

    // ask: the invented quote is dropped, the others are kept with their time
    const ask = (await s.call("POST", `/api/links/${id}/digest/ask`, { question: "¿De qué caché habla?" })).body;
    assert.equal(ask.status, "partial_answer");
    assert.equal(ask.sentences.length, 2);
    assert.equal(ask.rejected_sentences, 1);
    assert.equal(ask.sentences[0].citations[0].time, "0:00");
    assert.equal(ask.sentences[1].citations[0].kind, "screen");

    const find = (await s.agent("video_find", { query: "latencia", id })).body;
    assert.equal(find.hits.length, 1);
    assert.equal(find.hits[0].where, "screen");
    const spoken = (await s.agent("video_find", { query: "resultado final" })).body;
    assert.ok(spoken.hits.some((h) => h.where === "speech" && h.time === "0:06"));

    const frame = (await s.agent("video_frame", { id, t: "0:05", width: 320 })).body;
    assert.ok(fs.existsSync(frame.path));
    assert.equal(frame.width, 320);
    assert.ok(frame.tokens > 0);

    // asking again with the same focus reuses it; the MCP tool returns the brief text
    const again = (await s.agent("video_digest", { id, focus: "la caché", timeout_s: 30 })).body;
    assert.equal(again.status, "done");
    assert.match(again.text, /Índice por capítulos/);
    const list = (await s.agent("video_digests", {})).body;
    assert.equal(list.digests[0].link_id, id);
  } finally { await s.stop(); }
});

test("without a vision model or OCR the digest still finishes and says what is missing", { skip: SKIP, timeout: 120_000 }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(stt);
    digest.setOcrProvider(async () => ({ ok: false, kind: "unavailable", error: "Sin OCR de prueba." }));
    digest.setChatProvider(mockChat([], { vision: false }));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/digest`, { path: clip });
    const row = await digest.waitDigest(id, 90_000);
    assert.equal(row.status, "partial", `${row.status}: ${row.error}`);
    const view = digest.digestView(id, { level: "card" });
    assert.match(view.text, /Sin OCR de prueba/);
    assert.match(view.text, /no hay un modelo de visión servido/);
    assert.equal(view.stats.engines.vision, null);
    // once the engines are there, asking again fills only what was missing (the frames are not extracted again)
    const before = fs.statSync(path.join(digest.digestDir(id), "frames", "v001.jpg")).mtimeMs;
    digest.setOcrProvider(async () => ({ ok: true, backend: "mock-ocr", text: "AHORA SÍ" }));
    digest.setChatProvider(mockChat([]));
    await s.call("POST", `/api/links/${id}/digest`, {});
    const again = await digest.waitDigest(id, 90_000);
    assert.equal(again.status, "done");
    assert.equal(fs.statSync(path.join(digest.digestDir(id), "frames", "v001.jpg")).mtimeMs, before);
    assert.match(digest.readLayer(id, "visual"), /AHORA SÍ/);
    assert.match(digest.readLayer(id, "visual"), /Una diapositiva de color liso/);
  } finally { await s.stop(); }
});

test("a digest with no transcript engine is partial and the transcript layer says why", { skip: SKIP, timeout: 120_000 }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(async () => ({ ok: false, kind: "unavailable", error: "sin motor" }));
    digest.setOcrProvider(async () => ({ ok: true, backend: "mock-ocr", text: "PANTALLA" }));
    digest.setChatProvider(mockChat([]));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/digest`, { path: clip });
    const row = await digest.waitDigest(id, 90_000);
    assert.equal(row.status, "partial");
    assert.match(digest.readLayer(id, "transcript"), /sin transcripción/);
    assert.match(digest.readLayer(id, "card"), /Sin transcripción: no había motor de voz a texto/);
  } finally { await s.stop(); }
});

test("video_digest from an unknown url saves the link; bad requests are refused", async () => {
  const s = await bootServer();
  try {
    const none = await s.agent("video_digest", {});
    assert.equal(none.status, 400);
    const read = await s.agent("video_digest_read", { url: "https://example.com/never-saved" });
    assert.equal(read.status, 400);
    const r = await s.agent("video_digest", { url: "http://127.0.0.1:9/nothing-here.mp4", wait: false });
    assert.equal(r.status, 200);
    assert.ok(r.body.link_id);
    assert.ok(["queued", "running", "failed"].includes(r.body.status));
  } finally { await s.stop(); }
});
