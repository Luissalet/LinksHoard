// Video insight: transcript + key frames of a saved video link, with a tiny generated video and a mocked speech-to-text engine.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, serveText, waitFetched, tempDir, FIXTURE_ARTICLE } from "./helpers.js";
import * as video from "../server/videoinsight.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const SKIP = hasFfmpeg ? false : "ffmpeg is not installed";

let work;
let withSound;
let silent;

/** 6 s, three solid colours of very different brightness (two hard scene changes), optional sine audio. */
function makeVideo(file, audio) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const c of ["black", "white", "gray"]) args.push("-f", "lavfi", "-i", `color=c=${c}:s=160x120:r=10:d=2`);
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=6");
  args.push("-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]");
  if (audio) args.push("-map", "3:a", "-c:a", "aac");
  args.push("-pix_fmt", "yuv420p", file);
  const r = spawnSync("ffmpeg", args, { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
}

before(() => {
  work = tempDir();
  withSound = path.join(work, "clip.mp4");
  silent = path.join(work, "silent.mp4");
  if (hasFfmpeg) { makeVideo(withSound, true); makeVideo(silent, false); }
  process.env.LINKS_VIDEO_RETRY_S = "0,0,0";
});
after(() => { fs.rmSync(work, { recursive: true, force: true }); delete process.env.LINKS_VIDEO_RETRY_S; });
afterEach(() => { video.setSttProvider(null); });

const goodStt = (calls) => async (wav) => {
  calls.push(wav);
  assert.ok(fs.existsSync(wav), "the engine receives a real audio file");
  return { ok: true, language: "en", via: "mock-stt", model: "tiny", text: "hello orange world. second line about bananas",
    segments: [{ start_s: 0.2, end_s: 2.5, text: "hello orange world." }, { start_s: 3, end_s: 5.5, text: "second line about bananas" }] };
};

async function savedLink(s) {
  const page = await serveText(FIXTURE_ARTICLE);
  try {
    const created = await s.call("POST", "/api/links", { url: page.url });
    await waitFetched(s, created.body.id);
    return created.body.id;
  } finally { await page.close(); }
}

test("planFrames: scene frames first, timed fallback, never above the cap", () => {
  const none = video.planFrames(60, [], { max: 6 });
  assert.equal(none[0].reason, "start");
  assert.ok(none.length > 1 && none.length <= 6);
  assert.ok(none.slice(1).every((f) => f.reason === "timed"));
  const scenes = video.planFrames(30, [5, 5.5, 10, 20], { max: 10 });
  assert.deepEqual(scenes.filter((f) => f.reason === "scene").map((f) => f.t), [5.1, 10.1, 20.1]); // 5.5 is closer than the minimum gap
  const many = video.planFrames(100, Array.from({ length: 80 }, (_, i) => i * 1.2 + 2), { max: 8 });
  assert.equal(many.length, 8);
  assert.deepEqual(many.map((f) => f.t), [...many.map((f) => f.t)].sort((a, b) => a - b));
  assert.equal(video.planFrames(0, [], { max: 4 }).length, 1);
  assert.ok(video.planFrames(2, [], { max: 24 }).every((f) => f.t >= 0 && f.t < 2));
});

test("parseProbe and parseSceneTimes read ffmpeg output; normalizeTranscript accepts both timestamp spellings", () => {
  const p = video.parseProbe("Duration: 00:01:02.50, start: 0.0\n  Stream #0:0: Video: h264, yuv420p, 1080x1920, 30 fps\n  Stream #0:1: Audio: aac, 44100 Hz");
  assert.deepEqual([p.duration, p.hasAudio, p.hasVideo, p.width, p.height], [62.5, true, true, 1080, 1920]);
  assert.equal(video.parseProbe("Duration: 00:00:05.00\n Stream #0:0: Video: h264, yuv420p, 160x120").hasAudio, false);
  assert.deepEqual(video.parseSceneTimes(["[Parsed_showinfo_1 @ 0x1] n:0 pts:1 pts_time:2.5 pos:3", "unrelated pts_time:9"]), [2.5]);
  const t = video.normalizeTranscript({ segments: [{ start: 1, end: 2, text: " a  b " }, { start_s: 3, end_s: 4, text: "" }] });
  assert.deepEqual(t, { text: "a b", segments: [{ start_s: 1, end_s: 2, text: "a b" }] });
  assert.equal(video.normalizeTranscript({ text: "only text" }, 9).segments[0].end_s, 9);
  assert.equal(video.clock(75), "1:15");
  assert.equal(video.clock(3725), "1:02:05");
});

test("a video file gives key frames and a searchable timed transcript, and repeating it changes nothing", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    const calls = [];
    video.setSttProvider(goodStt(calls));
    const id = await savedLink(s);
    assert.equal((await s.call("GET", `/api/links/${id}/video`)).body.status, "none");

    const started = await s.call("POST", `/api/links/${id}/video/analyze`, { path: withSound });
    assert.equal(started.status, 202);
    await video.waitVideoIdle();

    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "done", JSON.stringify(v));
    assert.equal(v.frames.status, "done");
    assert.ok(v.frames.count >= 3 && v.frames.count <= 24, `frames: ${v.frames.count}`);
    assert.ok(v.frames.items.some((f) => f.reason === "scene"), "scene changes found");
    assert.ok(v.frames.items.every((f) => f.t_s >= 0 && f.t_s < 6 && fs.existsSync(f.path) && f.width > 0));
    assert.equal(v.transcript.status, "done");
    assert.equal(v.transcript.via, "mock-stt");
    assert.equal(v.transcript.segments.length, 2);
    assert.equal(v.transcript.segments[1].time, "0:03");
    assert.ok(Math.abs(v.duration_s - 6) < 0.5);

    // the frame is an image
    const img = await fetch(`${s.base}${v.frames.items[0].url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.equal((await img.arrayBuffer()).byteLength > 200, true);
    assert.equal((await s.call("GET", `/api/links/${id}/frames/99`)).status, 404);

    // the item and the library search know the spoken words
    assert.equal((await s.call("GET", `/api/links/${id}`)).body.video.transcript, "done");
    const found = (await s.call("GET", "/api/links?state=all&q=bananas")).body;
    assert.deepEqual(found.items.map((l) => l.id), [id]);
    const hits = (await s.call("GET", "/api/video/search?q=orange")).body.hits;
    assert.equal(hits.length, 1);
    assert.deepEqual([hits[0].link_id, hits[0].time, hits[0].text], [id, "0:00", "hello orange world."]);
    assert.equal((await s.call("GET", "/api/video/search?q=zzzz")).body.hits.length, 0);

    // idempotent: same file, nothing redone
    const again = await s.call("POST", `/api/links/${id}/video/analyze`, { path: withSound });
    assert.equal(again.status, 200);
    await video.waitVideoIdle();
    assert.equal(calls.length, 1, "the engine was called once");
    // force redoes it
    await s.call("POST", `/api/links/${id}/video/analyze`, { path: withSound, force: true });
    await video.waitVideoIdle();
    assert.equal(calls.length, 2);
    assert.equal((await s.call("GET", `/api/links/${id}/video`)).body.status, "done");
  } finally { await s.stop(); }
});

test("MCP tools return the transcript, the frames and the search hits", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(goodStt([]));
    const id = await savedLink(s);
    const out = await s.agent("link_video_analyze", { id, path: withSound, timeout_s: 60 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const r = out.body.result ?? out.body;
    assert.equal(r.status, "done");
    const got = (await s.agent("link_video", { id })).body;
    const view = got.result ?? got;
    assert.equal(view.transcript.segments[0].text, "hello orange world.");
    assert.ok(path.isAbsolute(view.frames.items[0].path));
    const search = (await s.agent("link_video_search", { query: "bananas" })).body;
    assert.equal((search.result ?? search).hits.length, 1);
    const bad = await s.agent("link_video_analyze", { id, path: path.join(work, "nope.mp4") });
    assert.equal(bad.status >= 400 || bad.body.ok === false, true);
  } finally { await s.stop(); }
});

test("without a speech engine the frames are kept, the transcript is skipped, and a later pass completes it", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(async () => ({ ok: false, kind: "unavailable", error: "Funes is not running" }));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/video/analyze`, { path: withSound });
    await video.waitVideoIdle();
    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "partial");
    assert.equal(v.frames.status, "done");
    assert.equal(v.transcript.status, "skipped");
    assert.match(v.transcript.error, /Funes/);
    assert.ok(v.next_retry_at, "a retry is scheduled");
    const frameBefore = v.frames.items[0].path;
    const mtime = fs.statSync(frameBefore).mtimeMs;

    const calls = [];
    video.setSttProvider(goodStt(calls));
    const swept = await video.sweepVideo();
    assert.equal(swept.retried, 1);
    await video.waitVideoIdle();
    const done = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(done.status, "done");
    assert.equal(done.transcript.status, "done");
    assert.equal(fs.statSync(frameBefore).mtimeMs, mtime, "frames were not extracted again");
    assert.equal(calls.length, 1);
    assert.equal((await video.sweepVideo()).retried, 0);
  } finally { await s.stop(); }
});

test("a failing engine stops retrying after the attempt limit", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(async () => ({ ok: false, kind: "error", error: "boom" }));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/video/analyze`, { path: withSound });
    await video.waitVideoIdle();
    for (let i = 0; i < 5; i++) { await video.sweepVideo(); await video.waitVideoIdle(); }
    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "partial");
    assert.equal(v.transcript.status, "failed");
    assert.equal(v.attempts, video.MAX_ATTEMPTS);
    assert.equal(v.next_retry_at, null);
  } finally { await s.stop(); }
});

test("a video without sound has frames and no transcript call", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    const calls = [];
    video.setSttProvider(goodStt(calls));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/video/analyze`, { path: silent });
    await video.waitVideoIdle();
    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "done");
    assert.equal(v.transcript.status, "no_audio");
    assert.equal(calls.length, 0);
    assert.ok(v.frames.count >= 3);
  } finally { await s.stop(); }
});

test("a link with no file and no permission to download says so; a finished download of the link is picked up by itself", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(goodStt([]));
    const id = await savedLink(s);
    await s.call("POST", `/api/links/${id}/video/analyze`, {});
    await video.waitVideoIdle();
    const none = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(none.status, "no_source");
    assert.match(none.detail, /archivo de vídeo/);

    // a finished download row for this link (as the downloader writes it) becomes the source
    const { db } = await import("../server/db.js");
    const link = (await s.call("GET", `/api/links/${id}`)).body;
    db().prepare(`INSERT INTO media_downloads (id, url, status, format, dir, files, link_id, created_at, finished_at, asr) VALUES ('d1', ?, 'done', 'video', ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 0)`)
      .run(link.url, work, JSON.stringify([{ path: withSound, name: "clip.mp4", size: 1, kind: "video" }]), id);
    await s.call("POST", `/api/links/${id}/video/analyze`, {});
    await video.waitVideoIdle();
    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "done");
    assert.equal(v.source.kind, "download");
  } finally { await s.stop(); }
});

test("an uploaded file is stored with the link and deleting the link removes frames, rows and files", { skip: SKIP }, async () => {
  const s = await bootServer();
  try {
    video.setSttProvider(goodStt([]));
    const id = await savedLink(s);
    const bytes = fs.readFileSync(withSound);
    const bad = await fetch(`${s.base}/api/links/${id}/video/file?name=notes.txt`, { method: "PUT", body: bytes });
    assert.equal(bad.status, 400);
    const up = await fetch(`${s.base}/api/links/${id}/video/file?name=clip.mp4`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    assert.equal(up.status, 202, await up.text());
    await video.waitVideoIdle();
    const v = (await s.call("GET", `/api/links/${id}/video`)).body;
    assert.equal(v.status, "done");
    const dir = path.join(s.dataDir, "video", id);
    assert.ok(fs.existsSync(dir));
    await s.call("DELETE", `/api/links/${id}`);
    assert.equal(fs.existsSync(dir), false);
    assert.equal((await s.call("GET", "/api/video/search?q=bananas")).body.hits.length, 0);
    assert.equal((await s.call("GET", `/api/links/${id}/video`)).status, 404);
  } finally { await s.stop(); }
});

test("settings are validated and stored", async () => {
  const s = await bootServer();
  try {
    const before = (await s.call("GET", "/api/video/settings")).body;
    assert.equal(before.auto_download, false);
    const saved = await s.call("PUT", "/api/video/settings", { max_frames: 12, auto_download: true });
    assert.equal(saved.body.max_frames, 12);
    assert.equal(saved.body.auto_download, true);
    assert.equal((await s.call("PUT", "/api/video/settings", { max_frames: 999 })).status >= 400, true);
  } finally { await s.stop(); }
});
