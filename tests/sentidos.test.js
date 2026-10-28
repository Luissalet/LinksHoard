// Sentidos: the listening engine seen from the app. The Python worker is replaced by a function (setSentidosRunner), so these tests check
// what the app does with its answers: sources, the MCP tools, the sound layer of a digest, the sound search and the routes.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, serveText, waitFetched, tempDir, FIXTURE_ARTICLE } from "./helpers.js";
import * as core from "../server/digest-core.js";
import * as video from "../server/videoinsight.js";
import * as digest from "../server/videodigest.js";
import * as sentidos from "../server/sentidos.js";
import * as sounds from "../server/sentidos-tools.js";
import { TOOLS } from "../server/agent-tools.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const SKIP = hasFfmpeg ? false : "ffmpeg is not installed";

const TIMELINE = {
  ok: true, tool: "timeline", summary: "x", text: "x",
  data: {
    end: 12, loudness: { integrated_lufs: -23.4, true_peak_dbtp: -3.1, lra_lu: 4.2 }, music: { tempo: 93.4, confidence: "ok" },
    sections: [
      { start: 0, end: 6, label: "uplifting orchestral film score, strings ensemble | also: wild animals (AST)", ast_top: [["Music", 0.49], ["Bird", 0.21]], lufs: -25 },
      { start: 6, end: 12, label: "a busy cafe, people talking in the background", ast_top: [["Speech", 0.9]], lufs: -22 },
    ],
    events: [{ t: 3.2, kind: "HIT", label: "orchestral stab", exposed: true, prominence_db: 21.4 }, { t: 4, kind: "NOTE", label: "weak guess", exposed: false, prominence_db: 3 }],
  },
};

let work;
let clip;
let wav;

function makeVideo(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=10:d=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest", file], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
}

before(() => {
  work = tempDir();
  clip = path.join(work, "concert.mp4");
  wav = path.join(work, "tone.wav");
  fs.writeFileSync(wav, "RIFFfake");
  if (hasFfmpeg) makeVideo(clip);
  process.env.LINKS_VIDEO_RETRY_S = "0,0,0";
});
after(() => { fs.rmSync(work, { recursive: true, force: true }); delete process.env.LINKS_VIDEO_RETRY_S; });
afterEach(() => { sentidos.setSentidosRunner(null); video.setSttProvider(null); digest.setOcrProvider(null); digest.setChatProvider(null); });

test("the sound layer is built from a timeline: sections, loudness, only the exposed events", () => {
  const m = sounds.soundModel(TIMELINE, { start: 0, end: null });
  assert.equal(m.status, "done");
  assert.equal(m.sections.length, 2);
  assert.deepEqual(m.sections[0].ast[0], { name: "Music", score: 0.49 });
  assert.equal(m.events.length, 1, "an event that is not exposed is a weak hint and stays out");
  assert.equal(m.loudness.lufs, -23.4);
  assert.equal(m.music.tempo, 93.4);
  const text = core.renderSound({ sound: m });
  assert.match(text, /Qué suena \(generado, Sentidos\)/);
  assert.match(text, /\[0:00–0:06\] uplifting orchestral film score/);
  assert.match(text, /AudioSet: Music 0.49, Bird 0.21/);
  assert.match(text, /orchestral stab/);
  assert.match(core.renderSound({ sound: m }, { from: 7, to: 12 }), /busy cafe/);
  assert.doesNotMatch(core.renderSound({ sound: m }, { from: 7, to: 12 }), /orchestral film score/);
  assert.match(core.renderSound({ sound: { status: "unavailable", error: "sin motor" } }), /sin análisis de sonido: sin motor/);
  assert.equal(core.soundIn({ sound: m }, 0, 5), "uplifting orchestral film score, strings ensemble");
  assert.match(core.soundHeadline({ sound: m }), /orchestral film score.*busy cafe.*93 BPM · AudioSet: Bird/);
});

test("the MCP tools exist, with a Sinónimos line and a first line the tool index can use", () => {
  for (const name of ["audio_describe", "audio_match", "audio_find", "audio_timeline", "audio_measure", "audio_realness", "audio_sheet", "audio_status"]) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, name);
    assert.ok(t.description.length <= 1000, `${name} ${t.description.length}`);
  }
});

test("audio tools resolve their source, call the worker and refuse bad requests", async () => {
  const s = await bootServer();
  try {
    const calls = [];
    sentidos.setSentidosRunner(async (tool, args) => { calls.push({ tool, args }); return { ok: true, tool, summary: `${tool} ok`, text: `Reading of ${path.basename(args.path)}`, data: { z: 3.1 } }; });
    const d = (await s.agent("audio_describe", { path: wav, top: 3 })).body;
    assert.equal(d.ok, true);
    assert.match(d.text, /Reading of tone\.wav/);
    assert.equal(d.data, undefined, "numbers only on request");
    assert.equal(calls[0].tool, "describe");
    assert.equal(calls[0].args.top, 3);
    const withData = (await s.agent("audio_match", { path: wav, query: "a bell", with_data: true })).body;
    assert.equal(withData.data.z, 3.1);
    assert.equal(calls.at(-1).args.query, "a bell");
    const sheet = (await sentidos.callTool("describe", { path: wav }));
    assert.equal(sheet.ok, true);

    assert.equal((await s.agent("audio_describe", {})).status, 400, "no source");
    assert.equal((await s.agent("audio_describe", { path: path.join(work, "nope.wav") })).status, 404);
    const txt = path.join(work, "notes.txt");
    fs.writeFileSync(txt, "hola");
    assert.equal((await s.agent("audio_describe", { path: txt })).status, 400, "not a sound file");
    assert.equal((await s.agent("audio_describe", { id: "no-such-link" })).status, 404);

    // a worker that fails comes back as a readable error, not as a crash
    sentidos.setSentidosRunner(async () => ({ ok: false, error: "the file has no audio" }));
    const failed = (await s.agent("audio_measure", { path: wav })).body;
    assert.equal(failed.ok, false);
    assert.match(failed.error, /no audio/);

    const st = (await s.agent("audio_status", {})).body;
    assert.equal(st.ready, true);
    assert.ok(st.tools.includes("timeline"));
  } finally { await s.stop(); }
});

test("a saved link with no downloaded audio or video says what to do", async () => {
  const s = await bootServer();
  try {
    const page = await serveText(FIXTURE_ARTICLE);
    let id;
    try { const created = await s.call("POST", "/api/links", { url: page.url }); await waitFetched(s, created.body.id); id = created.body.id; } finally { await page.close(); }
    const r = await s.agent("audio_describe", { id });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.body), /media_download/);
  } finally { await s.stop(); }
});

test("a digest gets a sound layer that is searchable and askable; without the engine it only says so", { skip: SKIP, timeout: 120_000 }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(async () => ({ ok: true, language: "es", via: "mock-stt", model: "tiny", text: "Hola.", segments: [{ start_s: 0.5, end_s: 3, text: "Hola a todos." }] }));
    digest.setOcrProvider(async () => ({ ok: true, backend: "mock-ocr", text: "ROJO" }));
    digest.setChatProvider(async (args) => {
      if (args.json?.properties?.sentences) {
        const input = JSON.parse(args.messages[1].content);
        const a = input.passages.find((p) => p.kind === "sound");
        return { ok: true, model: "mock-llm", json: { sentences: a ? [{ text: "Suena a música orquestal.", citations: [{ ref: a.ref, quote: "orchestral film score" }] }] : [] } };
      }
      if (args.capability === "vision") return { ok: true, model: "mock-vl", json: { kind: "scene", caption: "Pantalla roja.", important: false } };
      if (args.json?.properties?.chapters) { const i = JSON.parse(args.messages[1].content); return { ok: true, model: "mock-llm", json: { chapters: i.chapters.map((c) => ({ id: c.id, title: `Cap ${c.id}`, summary: "r" })) } }; }
      return { ok: true, model: "mock-llm", json: { tldr: "Un concierto.", key_points: ["Cuerdas"], focus_answer: "", focus_chapters: [] } };
    });
    const page = await serveText(FIXTURE_ARTICLE);
    let id;
    try { const created = await s.call("POST", "/api/links", { url: page.url }); await waitFetched(s, created.body.id); id = created.body.id; } finally { await page.close(); }

    // no engine: the digest is complete, with a note, and has no sound layer
    await s.call("POST", `/api/links/${id}/digest`, { path: clip });
    const first = await digest.waitDigest(id, 90_000);
    assert.equal(first.status, "done", `${first.status}: ${first.error} ${first.detail}`);
    assert.match(digest.readLayer(id, "card"), /Sin capa de sonido/);
    assert.match(digest.readLayer(id, "sound"), /sin análisis de sonido/);

    // the engine is there: asking again adds only the sound layer
    const seen = [];
    sentidos.setSentidosRunner(async (tool, args) => { seen.push({ tool, args }); return TIMELINE; });
    await s.call("POST", `/api/links/${id}/digest`, {});
    const second = await digest.waitDigest(id, 90_000);
    assert.equal(second.status, "done");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, "timeline");
    assert.equal(seen[0].args.detail, "normal");
    const view = (await s.call("GET", `/api/links/${id}/digest?level=brief`)).body;
    assert.ok(view.files.sound && fs.existsSync(view.files.sound));
    assert.match(view.text, /\*\*Suena\*\* \*\(generado · Sentidos\)\*: uplifting orchestral film score/);
    assert.match(view.text, /Suena: uplifting orchestral film score, strings ensemble \*\(gen\.\)\*/);
    assert.equal(view.stats.sound_sections, 2);
    assert.equal(view.stats.engines.sound, "sentidos");
    const layer = (await s.agent("video_digest_read", { id, level: "sound" })).body;
    assert.match(layer.text, /busy cafe/);
    assert.match((await s.agent("video_digest_read", { id, level: "sound", from: 7 })).body.text, /busy cafe/);
    assert.match(digest.readLayer(id, "full"), /Qué suena/);

    // video_find finds what it sounds like; audio_find without a source reads the same index
    const hits = (await s.agent("video_find", { query: "orchestral" })).body.hits;
    assert.ok(hits.some((h) => h.where === "sound" && h.time === "0:00"), JSON.stringify(hits));
    const byAudio = (await s.agent("audio_find", { query: "cafe" })).body;
    assert.equal(byAudio.indexed.length, 1);
    assert.equal(byAudio.indexed[0].start_s, 6);
    assert.match((await s.agent("audio_find", { query: "submarine" })).body.note, /Ningún digest/);
    assert.equal((await s.call("GET", "/api/sentidos/search?q=cafe")).body.hits.length, 1);

    // ask: the sound passage can be cited, its quote is checked
    const ask = (await s.call("POST", `/api/links/${id}/digest/ask`, { question: "¿Qué música suena?" })).body;
    assert.equal(ask.status, "answered", JSON.stringify(ask));
    assert.equal(ask.sentences[0].citations[0].kind, "sound");

    // the engine fails on a forced rerun: the digest stays done and says why there is no sound layer
    sentidos.setSentidosRunner(async () => ({ ok: false, error: "boom" }));
    await s.call("POST", `/api/links/${id}/digest`, { force: true });
    const third = await digest.waitDigest(id, 90_000);
    assert.equal(third.status, "done");
    assert.match(digest.readLayer(id, "card"), /Sin capa de sonido: boom/);
  } finally { await s.stop(); }
});

test("routes: status, the tools through /run, the source list, bad requests", async () => {
  const s = await bootServer();
  try {
    sentidos.setSentidosRunner(async (tool, args) => ({ ok: true, tool, summary: tool, text: `${tool} of ${path.basename(args.path || "")}`, data: {} }));
    const st = (await s.call("GET", "/api/sentidos/status")).body;
    assert.equal(st.ready, true);
    assert.equal(st.installed, false, "the test environment has no Sentidos venv");
    const run = await s.call("POST", "/api/sentidos/run", { tool: "describe", path: wav });
    assert.equal(run.status, 200);
    assert.match(run.body.text, /describe of tone\.wav/);
    assert.equal((await s.call("POST", "/api/sentidos/run", { tool: "forge", path: wav })).status, 400);
    assert.equal((await s.call("POST", "/api/sentidos/run", { tool: "find" })).status, 400);
    assert.equal((await s.call("POST", "/api/sentidos/run", { tool: "find", query: "bell" })).body.indexed.length, 0);
    assert.ok(Array.isArray((await s.call("GET", "/api/sentidos/sources")).body.sources));
    assert.equal((await s.call("GET", "/api/sentidos/sheet/..%2Fx.png")).status, 404);
    const set = await s.call("PUT", "/api/sentidos/settings", { idle_min: 5, warm: false });
    assert.equal(set.body.idle_min, 5);
    assert.equal(set.body.warm, false);
    assert.equal((await s.call("PUT", "/api/sentidos/settings", { idle_min: -1 })).status, 400);
    // with no venv the worker cannot start, and the answer says what to do
    sentidos.setSentidosRunner(null);
    const noVenv = await s.call("POST", "/api/sentidos/start");
    assert.equal(noVenv.status, 424);
    assert.match(noVenv.body.error, /Preparar Sentidos/);
  } finally { await s.stop(); }
});
