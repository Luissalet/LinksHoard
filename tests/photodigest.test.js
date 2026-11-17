// Digest of a post of photos (a carousel): how a link is told from a video, how its pictures are collected, the layers built over them,
// the photo the link opened, and the questions asked afterwards. Plus the Hub start of the app that owns the speech service.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, tempDir, serveText, waitFetched, FIXTURE_ARTICLE } from "./helpers.js";
import { installFakes } from "./media-fakes.js";
import { startFakeHub } from "./fake-hub.js";
import * as media from "../server/media.js";
import * as photos from "../server/photos.js";
import * as core from "../server/digest-core.js";
import * as digest from "../server/videodigest.js";
import * as video from "../server/videoinsight.js";
import * as family from "../server/hoard-link.js";
import { ensureService, ownerOf } from "../server/fam-start.js";
import { forgetAvailability } from "../server/hoard-commons/fam-services.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const SKIP = hasFfmpeg ? false : "ffmpeg is not installed";

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------

test("imageIndexOf reads the slide a link opened", () => {
  assert.equal(photos.imageIndexOf("https://www.instagram.com/p/DfxdhxUEaDD/?img_index=7"), 7);
  assert.equal(photos.imageIndexOf(null, "https://www.instagram.com/p/x/?utm_source=a&img_index=2"), 2);
  assert.equal(photos.imageIndexOf("https://www.instagram.com/p/x/"), null);
  assert.equal(photos.imageIndexOf("https://www.instagram.com/p/x/?img_index=0"), null);
  assert.equal(photos.imageIndexOf("not a url", "https://x.com/a/status/1?img_index=abc"), null);
});

const CAROUSEL = {
  _type: "playlist", id: "DfxdhxUEaDD", title: "Post by autor", description: "Pie del carrusel", uploader: "Autor", timestamp: 1790000000,
  http_headers: { Referer: "https://www.instagram.com/" },
  entries: [
    { id: "a", title: "Video by autor", formats: [{ format_id: "v", vcodec: "h264", url: "https://cdn/v.mp4" }], thumbnails: [{ url: "https://cdn/v.jpg", width: 720, height: 1280 }] },
    { id: "b", title: "Video by autor", formats: [], thumbnails: [{ url: "https://cdn/b-small.jpg", width: 320, height: 320 }, { url: "https://cdn/b.jpg", width: 1080, height: 1080 }, { url: "https://cdn/b-mid.jpg", width: 640, height: 640 }] },
    { id: "c", title: "Video by autor", formats: [], thumbnails: [{ url: "https://cdn/c.jpg" }] },
    { id: "d", title: "Video by autor", formats: [], thumbnail: "https://cdn/d.jpg" },
    { id: "e", title: "Video by autor", formats: [] },
  ],
};

test("describePost: a carousel is photos, one slide per entry, the largest picture of each; a video stays a video", () => {
  const post = media.describePost(CAROUSEL, { platform: "Instagram" });
  assert.equal(post.kind, "photos");
  assert.equal(post.photos, 3, "the video slide and the slide without a picture are not photos");
  assert.deepEqual(post.slides.map((x) => [x.n, x.has_video, x.image_url]), [
    [1, true, "https://cdn/v.jpg"], [2, false, "https://cdn/b.jpg"], [3, false, "https://cdn/c.jpg"], [4, false, "https://cdn/d.jpg"], [5, false, ""],
  ]);
  assert.equal(post.slides[1].width, 1080);
  assert.equal(post.meta.uploader, "Autor");
  assert.equal(post.meta.description, "Pie del carrusel");
  assert.equal(post.meta.upload_date, "20260921", "the date comes from the timestamp when there is no upload_date");
  assert.equal(post.headers.Referer, "https://www.instagram.com/");

  const clip = media.describePost({ id: "x", title: "Un vídeo", uploader: "Canal", upload_date: "20260930", duration: 61, formats: [{ format_id: "v", vcodec: "h264", url: "u" }] });
  assert.equal(clip.kind, "video");
  assert.equal(clip.meta.title, "Un vídeo");
  assert.equal(clip.meta.duration, 61);
  // a post of only videos is not a post of photos
  const reels = media.describePost({ _type: "playlist", entries: [CAROUSEL.entries[0], CAROUSEL.entries[0]] });
  assert.equal(reels.kind, "video");
  // a single photo: no formats, a picture
  assert.equal(media.describePost({ id: "p", title: "Foto", thumbnails: [{ url: "https://cdn/p.jpg", width: 900, height: 900 }] }).kind, "photos");
});

const model = (extra = {}) => ({
  media: "photos", photos: 3, focus_photo: 2, title: "Post by autor", url: "https://www.instagram.com/p/x/?img_index=2", platform: "Instagram", uploader: "Autor",
  post_text: "Pie del carrusel", generated_at: "2026-11-17 10:00", duration: 0, summary: { tldr: "Tres fotos de ejemplo.", key_points: ["Una"], model: "m" },
  visual: [
    { idx: 1, start: 0, end: 1, t: 0, file: "frames/v001.jpg", same_as: null, kind: "slide", caption: "Portada.", important: false, ocr: "PORTADA", ocr_same_as: null, slide: 1, slide_video: true, opened: false },
    { idx: 2, start: 1, end: 2, t: 1, file: "frames/v002.jpg", same_as: null, kind: "chart", caption: "Un gráfico.", important: true, ocr: "VENTAS 4", ocr_same_as: null, slide: 2, slide_video: false, opened: true },
    { idx: 3, start: 2, end: 3, t: 2, file: "frames/v003.jpg", same_as: null, kind: "", caption: "", important: false, ocr: "", ocr_same_as: null, slide: 3, slide_video: false, opened: false },
  ],
  chapters: [{ id: 1, start: 0, end: 1, title: "Portada", summary: "La portada.", focus: false }, { id: 2, start: 1, end: 2, title: "Ventas", summary: "El gráfico.", focus: false, opened: true },
    { id: 3, start: 2, end: 3, title: "", summary: "", focus: false }],
  transcript: { status: "no_speech", segments: [] }, sound: null, notes: [], ...extra,
});

test("a post of photos is rendered photo by photo and says which one the link opened", () => {
  const m = model();
  const card = core.renderCard(m, { full: 900, index: 100, visual: 300, overview_image: 800, photos_image: 3000 });
  assert.match(card, /Digest de una publicación de fotos/);
  assert.match(card, /\*\*Fotos:\*\* 3/);
  assert.doesNotMatch(card, /Duración/);
  assert.match(card, /Foto abierta:\*\* 2 de 3/);
  assert.match(card, /mirar las 3 fotos costaría ~3000/);
  assert.match(card, /video_frame \(una foto por su número\)/);
  const index = core.renderIndex(m);
  assert.match(index, /### 2 · foto 2 de 3 Ventas .*★ la que traía el enlace/);
  assert.match(index, /foto 1 \(vídeo: primer fotograma\)/);
  const visual = core.renderVisual(m);
  assert.match(visual, /\*\*foto 2\*\* de 3 · ★ la que traía el enlace · conviene verlo · frames\/v002\.jpg/);
  assert.match(visual, /diapositiva de vídeo/);
  assert.match(visual, /VENTAS 4/);
  assert.match(core.renderTranscript(m), /no tiene voz/);
  // only the photos asked for (photo numbers, 0-based start): the second one
  const part = core.renderVisual(m, { from: 1, to: 2 });
  assert.match(part, /foto 2/);
  assert.doesNotMatch(part, /foto 1|foto 3/);
});

// ---------------------------------------------------------------------------
// the whole job: a carousel with fake yt-dlp / gallery-dl and real pictures
// ---------------------------------------------------------------------------

const ENV_KEYS = ["LINKS_YTDLP", "LINKS_GALLERYDL", "LINKS_FFMPEG", "PYTHON", "FAKE_DIR", "FAKE_LOG", "LINKS_MEDIA_SIBLING_DIR", "LINKS_MEDIA_AUTO_UPDATE", "LINKS_MEDIA_DIR",
  "LINKS_ALLOW_PRIVATE_URLS", "FAKE_IMG_BASE", "FAKE_PHOTO_SRC", "FAKE_SLIDES", "LINKS_VIDEO_RETRY_S"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (patch) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } media.resetToolsCache(); };

let work, fakes, imgServer, imgBase;
const COLORS = ["red", "green", "blue", "yellow"];

before(async () => {
  work = tempDir();
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  if (hasFfmpeg) {
    COLORS.forEach((c, i) => {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=1080x1080`, "-frames:v", "1", path.join(work, "src", `${i + 1}.jpg`)], { windowsHide: true });
      assert.equal(r.status, 0, String(r.stderr));
      // the same picture as a preview, for the listings that offer only small ones
      const small = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=320x320`, "-frames:v", "1", path.join(work, "src", `small-${i + 1}.jpg`)], { windowsHide: true });
      assert.equal(small.status, 0, String(small.stderr));
    });
  }
  imgServer = http.createServer((req, res) => {
    const m = req.url.match(/^\/img\/(small-)?(\d+)\.jpg$/);
    const file = m && path.join(work, "src", `${m[1] || ""}${m[2]}.jpg`);
    if (file && fs.existsSync(file)) { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(fs.readFileSync(file)); } else { res.writeHead(404); res.end("no"); }
  });
  await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
  imgBase = `http://127.0.0.1:${imgServer.address().port}`;
  fakes = installFakes(path.join(work, "fakes"));
});
after(async () => {
  await new Promise((r) => imgServer.close(r));
  setEnv(savedEnv);
  fs.rmSync(work, { recursive: true, force: true });
});
afterEach(() => { digest.setOcrProvider(null); digest.setChatProvider(null); setEnv(savedEnv); });

// the real ffmpeg is used (the pictures are real); yt-dlp and gallery-dl are the fakes
const useFakes = (extra = {}) => setEnv({ ...fakes.env, LINKS_FFMPEG: undefined, LINKS_ALLOW_PRIVATE_URLS: "1", FAKE_IMG_BASE: imgBase, LINKS_MEDIA_DIR: path.join(work, "dl"), LINKS_VIDEO_RETRY_S: "0,0,0", ...extra });

function mockChat(calls) {
  return async (args) => {
    calls.push(args);
    const props = args.json?.properties || {};
    if (args.capability === "vision") return { ok: true, model: "mock-vl", json: { kind: "slide", caption: "Una diapositiva de color liso.", important: false } };
    if (props.chapters) {
      const input = JSON.parse(args.messages[1].content);
      return { ok: true, model: "mock-llm", json: { chapters: input.chapters.map((c) => ({ id: c.id, title: `Foto ${c.id}`, summary: `Resumen de la foto ${c.id}.` })) } };
    }
    if (props.tldr) return { ok: true, model: "mock-llm", json: { tldr: "Un carrusel de colores.", key_points: ["Colores"], focus_answer: "", focus_chapters: [] } };
    if (props.sentences) {
      return { ok: true, model: "mock-llm", json: { sentences: [
        { text: "El autor dice que es un ejemplo.", citations: [{ ref: "p0", quote: "Pie de la publicación" }] },
        { text: "En la foto 3 pone TEXTO3.", citations: [{ ref: "v3", quote: "TEXTO3" }] },
        { text: "Algo inventado.", citations: [{ ref: "p0", quote: "esto no lo escribió nadie" }] },
      ] } };
    }
    return { ok: false, error: "no_model" };
  };
}

const ocrByPhoto = async (file) => ({ ok: true, backend: "mock-ocr", text: `TEXTO${path.basename(file).match(/v0*(\d+)\.jpg/)?.[1] || "?"}` });

test("a carousel: the pictures are collected, each is read, the opened photo is marked, and it can be asked, searched and looked at", { skip: SKIP, timeout: 180_000 }, async () => {
  useFakes();
  const s = await bootServer();
  try {
    const calls = [];
    digest.setOcrProvider(ocrByPhoto);
    digest.setChatProvider(mockChat(calls));
    const url = `${imgBase}/carousel/abc123/?img_index=3`;
    const view = (await s.agent("video_digest", { url, timeout_s: 120, level: "brief" })).body;
    assert.equal(view.status, "done", `${view.status}: ${view.error} ${view.detail}`);
    assert.match(view.text, /Digest de una publicación de fotos/);
    assert.match(view.text, /\*\*Fotos:\*\* 4/);
    assert.match(view.text, /Foto abierta:\*\* 3 de 4/);
    assert.match(view.text, /Pie de la publicación de prueba/, "the caption of the post is the post text");
    assert.match(view.text, /Un carrusel de colores\./);
    assert.match(view.text, /### 3 · foto 3 de 4 .*★ la que traía el enlace/);
    const st = view.stats;
    assert.equal(st.media, "photos");
    assert.equal(st.photos, 4);
    assert.equal(st.distinct_frames, 4);
    assert.equal(st.engines.ocr, "mock-ocr");
    assert.equal(st.engines.vision, "mock-vl");
    assert.equal(st.engines.photos, "yt-dlp");
    assert.ok(st.tokens.photos_image > st.tokens.index, "reading the digest is cheaper than looking at the photos");
    assert.ok(st.tokens.overview_image > 0, "the contact sheet has a size");
    for (const k of ["card", "index", "visual", "transcript", "full", "overview"]) assert.ok(view.files[k] && fs.existsSync(view.files[k]), `file ${k}`);
    // the pictures were taken with yt-dlp's listing, not with a login: gallery-dl was not needed for large pictures
    assert.equal(fakes.calls("gallery-dl").filter((c) => !c.argv.includes("--version")).length, 0);
    assert.ok(fs.existsSync(path.join(digest.digestDir(view.link_id), "frames", "v004.jpg")));

    const visual = (await s.agent("video_digest_read", { id: view.link_id, level: "visual" })).body.text;
    assert.match(visual, /TEXTO1[\s\S]*TEXTO2[\s\S]*TEXTO3[\s\S]*TEXTO4/);
    assert.match(visual, /\*\*foto 3\*\* de 4 · ★ la que traía el enlace/);
    assert.match(visual, /diapositiva de vídeo/, "the first slide is a video: its first frame is what is read");
    const some = (await s.agent("video_digest_read", { id: view.link_id, level: "visual", from: 2, to: 3 })).body.text;
    assert.match(some, /fotos 2–3/);
    assert.match(some, /TEXTO2/);
    assert.match(some, /TEXTO3/);
    assert.doesNotMatch(some, /TEXTO1|TEXTO4/);
    assert.match((await s.agent("video_digest_read", { id: view.link_id, level: "transcript" })).body.text, /no tiene voz/);

    // asking: the caption is a passage of its own; an invented quote is dropped
    const ask = (await s.agent("video_ask", { id: view.link_id, question: "¿Qué pone?" })).body;
    assert.equal(ask.status, "partial_answer");
    assert.equal(ask.sentences.length, 2);
    assert.equal(ask.sentences[0].citations[0].kind, "post");
    assert.equal(ask.sentences[1].citations[0].time, "foto 3");

    // searching names the photo
    const find = (await s.agent("video_find", { query: "TEXTO2", id: view.link_id })).body;
    assert.equal(find.hits.length, 1);
    assert.equal(find.hits[0].time, "foto 2");
    assert.equal(find.hits[0].photo, 2);

    // a photo by its number, or the one the link opened
    const two = (await s.agent("video_frame", { id: view.link_id, t: 2, width: 320 })).body;
    assert.equal(two.photo, 2);
    assert.equal(two.width, 320);
    assert.ok(fs.existsSync(two.path));
    const opened = (await s.agent("video_frame", { id: view.link_id, width: 320 })).body;
    assert.equal(opened.photo, 3);
    assert.equal((await s.agent("video_frame", { id: view.link_id, t: 9 })).status, 400);

    // asking again does not read the post again
    const before = fakes.calls("yt-dlp").length;
    const again = (await s.agent("video_digest", { url, timeout_s: 30 })).body;
    assert.equal(again.status, "done");
    assert.equal(fakes.calls("yt-dlp").length, before);
    assert.equal(photos.imageIndexOf(url), 3);
  } finally { await s.stop(); }
});

test("a carousel whose listed pictures are small is asked of gallery-dl first, and falls back to the listed pictures with a note", { skip: SKIP, timeout: 180_000 }, async () => {
  useFakes({ FAKE_SLIDES: "3" });
  const s = await bootServer();
  try {
    digest.setOcrProvider(ocrByPhoto);
    digest.setChatProvider(mockChat([]));
    const view = (await s.agent("video_digest", { url: `${imgBase}/carouselsmall/zzz/`, timeout_s: 120 })).body;
    assert.equal(view.status, "done", `${view.status}: ${view.error} ${view.detail}`);
    assert.ok(fakes.calls("gallery-dl").some((c) => c.argv.includes("-D")), "gallery-dl was tried for the originals");
    assert.match(view.text, /\*\*Fotos:\*\* 3/);
    assert.doesNotMatch(view.text, /Foto abierta/, "the link did not say which slide");
    assert.match(view.detail || "", /tamaño de vista previa/);
  } finally { await s.stop(); }
});

test("a single photo post that yt-dlp cannot read is taken with gallery-dl, with its text", { skip: SKIP, timeout: 180_000 }, async () => {
  useFakes({ FAKE_PHOTO_SRC: path.join(work, "src") });
  const s = await bootServer();
  try {
    digest.setOcrProvider(ocrByPhoto);
    digest.setChatProvider(mockChat([]));
    const view = (await s.agent("video_digest", { url: `${imgBase}/photos/tuit1/`, timeout_s: 120 })).body;
    assert.equal(view.status, "done", `${view.status}: ${view.error} ${view.detail}`);
    assert.equal(view.stats.engines.photos, "gallery-dl");
    assert.equal(view.stats.photos, 2);
    assert.match(view.text, /Pie de foto de prueba/);
    assert.match(view.text, /autor_test/);
    assert.match(digest.readLayer(view.link_id, "visual"), /TEXTO1[\s\S]*TEXTO2/);
  } finally { await s.stop(); }
});

test("when no picture can be had the digest fails saying so, instead of claiming there is no video", { skip: SKIP, timeout: 120_000 }, async () => {
  useFakes({ FAKE_IMG_BASE: "http://127.0.0.1:1" });
  const s = await bootServer();
  try {
    digest.setOcrProvider(ocrByPhoto);
    digest.setChatProvider(mockChat([]));
    const view = (await s.agent("video_digest", { url: `${imgBase}/carousel/muro/`, timeout_s: 90 })).body;
    assert.equal(view.status, "failed");
    assert.match(view.error, /No se pudieron descargar las fotos de la publicación/);
    assert.doesNotMatch(view.error, /no contiene vídeo/);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------------------
// the app that owns the speech service is started through the Hub
// ---------------------------------------------------------------------------

async function hubWithTalos({ manuallyStopped = false } = {}) {
  const hub = await startFakeHub();
  hub.state.apps.talos = { state: "stopped", manually_stopped: manuallyStopped };
  // Funes is an identity absorbed by Talos: it cannot be launched, and its state is whatever Talos's is
  hub.state.apps.funes = { get state() { return hub.state.apps.talos.state === "running" ? "foreign" : "stopped"; }, launchable: false, family: { absorbed_by: { id: "talos" } } };
  family.configure({ app: "links", dataDir: tempDir(), hub: hub.url });
  forgetAvailability();
  return hub;
}

test("ensureService starts Talos (which holds Funes) through the Hub and waits for the speech service", async () => {
  const hub = await hubWithTalos();
  try {
    assert.deepEqual(await ownerOf("funes"), { id: "talos", absorbed: "talos", launchable: false, stopped_by_hand: false, error: "" });
    const up = await ensureService("stt", "funes", { waitS: 10, pollMs: 20 });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.started, "talos");
    assert.deepEqual(hub.state.started, ["talos"], "the owner is started, never the absorbed identity");
    // already there: nothing is started again
    hub.state.started.length = 0;
    assert.equal((await ensureService("stt", "funes", { waitS: 10, pollMs: 20 })).ok, true);
    assert.deepEqual(hub.state.started, []);
  } finally { await hub.stop(); family.configure({ app: "links" }); forgetAvailability(); }
});

test("ensureService does not start an app that was stopped by hand, and says why", async () => {
  const hub = await hubWithTalos({ manuallyStopped: true });
  try {
    const up = await ensureService("stt", "funes", { waitS: 10, pollMs: 20 });
    assert.equal(up.ok, false);
    assert.match(up.error, /talos está parado a mano en el Hub/);
    assert.deepEqual(hub.state.started, []);
  } finally { await hub.stop(); family.configure({ app: "links" }); forgetAvailability(); }
});

test("ensureService gives up at once when the Hub is not there, and explains a service that never answers", async () => {
  family.configure({ app: "links", dataDir: tempDir(), hub: "http://127.0.0.1:1" });
  forgetAvailability();
  const t0 = Date.now();
  const down = await ensureService("stt", "funes", { waitS: 30, pollMs: 20 });
  assert.equal(down.ok, false);
  assert.ok(Date.now() - t0 < 3000, "no waiting for a Hub that is not there");
  assert.match(down.error, /hub unreachable/);

  const hub = await startFakeHub();
  hub.state.apps.talos = { state: "stopped" };
  hub.state.apps.funes = { state: "stopped", launchable: false, family: { absorbed_by: { id: "talos" } } }; // Talos starts but Funes never comes up
  family.configure({ app: "links", dataDir: tempDir(), hub: hub.url });
  forgetAvailability();
  try {
    const slow = await ensureService("stt", "funes", { waitS: 0.1, pollMs: 20 });
    assert.equal(slow.ok, false);
    assert.match(slow.error, /se pidió arrancar talos al Hub y no respondió/);
  } finally { await hub.stop(); family.configure({ app: "links" }); forgetAvailability(); }
});

test("a transcription finds Talos stopped, has the Hub start it, and then transcribes through Funes", { skip: SKIP, timeout: 120_000 }, async () => {
  setEnv({ LINKS_FFMPEG: undefined });
  const s = await bootServer();
  const hub = await hubWithTalos();
  const clip = path.join(work, "voz.mp4");
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=5:d=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
    "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest", clip], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr));
  const page = await serveText(FIXTURE_ARTICLE);
  try {
    hub.state.tools["funes.transcribe_file"] = () => ({ status: "done", text: "Hola desde Talos.", language: "es", model: "fake", segments: [{ start_s: 0.2, end_s: 2, text: "Hola desde Talos." }] });
    const created = await s.call("POST", "/api/links", { url: page.url });
    await waitFetched(s, created.body.id);
    video.requestAnalysis(created.body.id, { path: clip });
    await video.waitVideoIdle(90_000);
    const view = video.videoView(created.body.id, { transcript: true, segments: true });
    assert.equal(view.transcript.status, "done", JSON.stringify(view.transcript));
    assert.equal(view.transcript.via, "funes");
    assert.match(view.transcript.text, /Hola desde Talos/);
    assert.deepEqual(hub.state.started, ["talos"], "the Hub was asked to start Talos, not the absorbed Funes");
    assert.equal(hub.state.calls.filter((c) => c.tool === "transcribe_file").length, 1);
  } finally { await page.close(); await hub.stop(); family.configure({ app: "links" }); forgetAvailability(); await s.stop(); }
});

test("a photograph with no text in it is read once and does not keep the digest partial", { skip: SKIP, timeout: 180_000 }, async () => {
  useFakes({ FAKE_SLIDES: "3" });
  const s = await bootServer();
  try {
    let reads = 0;
    digest.setOcrProvider(async (file) => { reads++; return { ok: true, backend: "mock-ocr", text: path.basename(file) === "v002.jpg" ? "" : "ALGO" }; });
    digest.setChatProvider(mockChat([]));
    const url = `${imgBase}/carousel/sintexto/`;
    const view = (await s.agent("video_digest", { url, timeout_s: 120 })).body;
    assert.equal(view.status, "done", `${view.status}: ${view.error} ${view.detail}`);
    const first = reads;
    // asking again with another focus redoes the summary but not the OCR of the pictures already read, empty ones included
    const again = (await s.agent("video_digest", { url, focus: "los colores", timeout_s: 120 })).body;
    assert.equal(again.status, "done");
    assert.equal(reads, first, "no picture was read twice");
  } finally { await s.stop(); }
});
