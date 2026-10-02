// The family media service (Hoard Link services.md section 2) served by Links: media_download with sections, max_duration_s, max_height and
// dest_dir; media_info; media_subtitles; media_audio_for_asr; and the address check on media URLs. Fake yt-dlp / ffmpeg from media-fakes.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bootServer, tempDir } from "./helpers.js";
import { installFakes } from "./media-fakes.js";
import { createLink, getLink } from "../server/links.js";
import { resetToolsCache, normalizeMediaUrl, probeUrl, startDownload } from "../server/media.js";

const ENV_KEYS = ["LINKS_YTDLP", "LINKS_GALLERYDL", "LINKS_FFMPEG", "PYTHON", "FAKE_DIR", "FAKE_LOG", "LINKS_MEDIA_DIR", "LINKS_MEDIA_SIBLING_DIR", "LINKS_MEDIA_AUTO_UPDATE", "LINKS_ALLOW_PRIVATE_URLS", "LINKS_MEDIA_TRANSCODE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (patch) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetToolsCache(); };

let s, fakes, tmp, mediaDir;
const ytCalls = () => fakes.calls("yt-dlp").filter((c) => !c.argv.includes("--version") && !c.argv.includes("-U"));
const arg = (call, name) => call.argv[call.argv.indexOf(name) + 1];
const lastUrl = (call) => call.argv[call.argv.length - 1];
const callsFor = (suffix) => ytCalls().filter((c) => lastUrl(c).endsWith(suffix));

before(async () => {
  tmp = tempDir();
  fakes = installFakes(path.join(tmp, "fakes"));
  mediaDir = path.join(tmp, "Descargas");
  setEnv({ ...fakes.env, LINKS_MEDIA_DIR: mediaDir, LINKS_MEDIA_TRANSCODE: undefined });
  s = await bootServer();
});

after(async () => {
  await s.stop();
  setEnv(savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the family tools are exposed to the hub and the MCP bridge", async () => {
  const list = await fetch(`${s.base}/api/agent/tools`, { headers: { Authorization: `Bearer ${s.token}` } });
  const names = (await list.json()).tools.map((t) => t.name);
  for (const n of ["media_download", "media_info", "media_subtitles", "media_audio_for_asr", "media_probe", "media_status"]) assert.ok(names.includes(n), n);
});

test("media_download: one section is cut with --download-sections and named after its range", async () => {
  const r = await s.agent("media_download", { url: "https://example.com/video/cut1", save_link: false, sections: [[30, 75.5]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const call = callsFor("/video/cut1")[0];
  assert.equal(arg(call, "--download-sections"), "*30-75.5");
  assert.ok(call.argv.includes("--force-keyframes-at-cuts"));
  assert.match(r.body.files[0].name, /\[cut1\] \[30-75\.5\]\.mp4$/);
});

test("media_download: several sections give one file per part and run yt-dlp once each", async () => {
  const r = await s.agent("media_download", { url: "https://example.com/video/cut2", save_link: false, sections: [[0, 10], [20, 30], [40, 50]] });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.files.length, 3);
  assert.deepEqual(r.body.files.map((f) => f.name.match(/\[part (\d)\]/)[1]), ["1", "2", "3"]);
  const calls = callsFor("/video/cut2");
  assert.deepEqual(calls.map((c) => arg(c, "--download-sections")), ["*0-10", "*20-30", "*40-50"]);
});

test("media_download: bad sections are refused with a clear message", async () => {
  const backwards = await s.agent("media_download", { url: "https://example.com/video/cut3", sections: [[50, 10]] });
  assert.notEqual(backwards.status, 200);
  assert.match(JSON.stringify(backwards.body), /inicio < fin|sections|Cada secci/);
  const many = await s.agent("media_download", { url: "https://example.com/video/cut4", sections: Array.from({ length: 11 }, (_, i) => [i, i + 1]) });
  assert.notEqual(many.status, 200);
});

test("media_download: max_duration_s refuses a longer video before downloading anything", async () => {
  const r = await s.agent("media_download", { url: "https://example.com/long/l1", save_link: false, max_duration_s: 1200 });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.status, "failed");
  assert.match(r.body.error, /dura 2 h 10 min \(límite 20 min\)/);
  assert.equal(callsFor("/long/l1").filter((c) => c.argv.includes("-P")).length, 0, "no download was started");
  assert.deepEqual(r.body.files, []);
  // under the limit it goes through
  const ok = await s.agent("media_download", { url: "https://example.com/video/short1", save_link: false, max_duration_s: 1200 });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
});

test("media_download: max_height caps the resolution and the lower of it and quality wins", async () => {
  await s.agent("media_download", { url: "https://example.com/video/h1", save_link: false, max_height: 480 });
  assert.match(arg(callsFor("/video/h1").at(-1), "-f"), /height<=480/);
  await s.agent("media_download", { url: "https://example.com/video/h2", save_link: false, quality: "720", max_height: 1080 });
  assert.match(arg(callsFor("/video/h2").at(-1), "-f"), /height<=720/);
  await s.agent("media_download", { url: "https://example.com/video/h3", save_link: false, quality: "1080", max_height: 360 });
  assert.match(arg(callsFor("/video/h3").at(-1), "-f"), /height<=360/);
  // a request that differs only in max_height is a different download
  const a = await s.agent("media_download", { url: "https://example.com/slow/hh", save_link: false, wait: false, max_height: 360 });
  const b = await s.agent("media_download", { url: "https://example.com/slow/hh", save_link: false, wait: false, max_height: 720 });
  assert.notEqual(a.body.id, b.body.id);
  await s.agent("media_cancel", { id: a.body.id });
  await s.agent("media_cancel", { id: b.body.id });
});

test("media_download: dest_dir is an alias of dir", async () => {
  const dest = path.join(tmp, "elegida");
  const r = await s.agent("media_download", { url: "https://example.com/video/dd1", save_link: false, dest_dir: dest });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.dir, dest);
  assert.ok(fs.existsSync(r.body.files[0].path) && r.body.files[0].path.startsWith(dest));
});

test("yt-dlp starts with --ignore-config and the JS runtime options from the shared builder", async () => {
  const call = callsFor("/video/dd1").at(-1);
  assert.equal(call.argv[0], "--ignore-config");
  // the fake reports 2026.01.01, newer than the runtime floor, so the JS runtime flags are there too
  assert.equal(call.argv[call.argv.indexOf("--js-runtimes") + 1], `node:${process.execPath}`);
});

test("media_info: the probe plus thumbnail, caption languages, id, extractor and is_live", async () => {
  const r = await s.agent("media_info", { url: "https://www.youtube.com/video/inf1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const info = r.body;
  assert.equal(info.title, "Título de prueba");
  assert.equal(info.duration, 125.5);
  assert.equal(info.id, "inf1");
  assert.equal(info.extractor, "Fake");
  assert.equal(info.thumbnail, "https://img.example.com/inf1.jpg");
  assert.deepEqual(info.subtitle_langs, ["en", "es"], "manual first, deduplicated, live_chat left out");
  assert.equal(info.is_live, false);
  assert.deepEqual(info.heights, [1080, 720, 360]);
  assert.equal(info.photo_post, false);
  assert.equal(info.is_playlist, false);
  const long = await s.agent("media_info", { url: "https://example.com/bigdesc/b1" });
  assert.equal(long.body.description.length, 2000);
  const live = await s.agent("media_info", { url: "https://example.com/live/l1" });
  assert.equal(live.body.is_live, true);
  // photo posts and failures keep the probe's behaviour
  const photo = await s.agent("media_info", { url: "https://www.instagram.com/photos/pp1/" });
  assert.equal(photo.body.photo_post, true);
  const gone = await s.agent("media_info", { url: "https://www.youtube.com/gone/x" });
  assert.notEqual(gone.status, 200);
  // media_probe stays as an alias
  const probe = await s.agent("media_probe", { url: "https://www.youtube.com/video/inf1" });
  assert.equal(probe.body.title, info.title);
});

test("media_subtitles: first wanted language wins, manual before automatic, text and cues", async () => {
  const manual = await s.agent("media_subtitles", { url: "https://example.com/subs/s1", langs: ["es", "en"] });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.lang, "es");
  assert.equal(manual.body.source, "manual");
  assert.equal(manual.body.text, "Primera línea del vídeo.\nSegunda línea & fin.", "a newline after a sentence, like the commons");
  assert.deepEqual(manual.body.cues[0], { start_s: 0.5, end_s: 2, text: "Primera línea del vídeo." });
  const call = callsFor("/subs/s1").find((c) => c.argv.includes("--write-subs"));
  assert.ok(call.argv.includes("--skip-download"));
  assert.equal(arg(call, "--sub-langs"), "es");
  assert.equal(arg(call, "--sub-format"), "vtt");

  // only automatic captions (en and es-orig): the first wanted language is es, and es-orig is Spanish; the rolling repeats collapse
  const auto = await s.agent("media_subtitles", { url: "https://example.com/autosubs/s2" });
  assert.equal(auto.body.lang, "es-orig");
  assert.equal(auto.body.source, "auto");
  assert.equal(auto.body.text, "hola a todos bienvenidos al canal");
  assert.equal(auto.body.cues.length, 2);
  assert.ok(callsFor("/autosubs/s2").some((c) => c.argv.includes("--write-auto-subs")));

  // English only in the list: the English automatic track
  const english = await s.agent("media_subtitles", { url: "https://example.com/autosubs/s3", langs: ["en"] });
  assert.equal(english.body.lang, "en");

  // the default order is es, en: this video has automatic Spanish and manual English: the manual one is for en, but es comes first in the list
  const both = await s.agent("media_subtitles", { url: "https://example.com/video/s4" });
  assert.equal(both.body.lang, "es");
  assert.equal(both.body.source, "auto");
});

test("media_subtitles: no captions is a 404 that lists what exists, and nothing is left on disk", async () => {
  const before = fs.readdirSync(path.dirname(fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "x-")))).filter((n) => n.startsWith("links-subs-")).length;
  const none = await s.agent("media_subtitles", { url: "https://example.com/nosubs/n1", langs: ["es", "en"] });
  assert.equal(none.status, 404, JSON.stringify(none.body));
  assert.match(none.body.error, /No hay subtítulos en es, en/);
  const wrong = await s.agent("media_subtitles", { url: "https://example.com/subs/n2", langs: ["fr"] });
  assert.equal(wrong.status, 404);
  assert.match(wrong.body.error, /disponibles: es, en/);
  const after = fs.readdirSync(path.dirname(fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "x-")))).filter((n) => n.startsWith("links-subs-")).length;
  assert.equal(after, before, "the temporary folder is removed");
});

test("media_audio_for_asr: a mono 16 kHz WAV under asr/, never saved as a link", async () => {
  const r = await s.agent("media_audio_for_asr", { url: "https://example.com/video/asr1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.format, "audio");
  assert.equal(r.body.kind, "audio");
  const file = r.body.files[0];
  assert.ok(file.path.endsWith(".wav"), file.path);
  assert.ok(file.path.startsWith(path.join(mediaDir, "asr")), file.path);
  assert.equal(fs.readFileSync(file.path).subarray(0, 4).toString(), "RIFF");
  assert.equal(r.body.files.length, 1, "the intermediate MP3 is gone");
  assert.equal(fs.readdirSync(path.join(mediaDir, "asr")).filter((n) => n.includes("[asr1]")).length, 1);
  assert.equal(r.body.link_id, undefined, "never a library link");
  const ff = fakes.calls("ffmpeg").find((c) => c.argv.includes("-ar"));
  assert.deepEqual([arg(ff, "-ac"), arg(ff, "-ar"), arg(ff, "-c:a")], ["1", "16000", "pcm_s16le"]);
  assert.ok(ff.argv.includes("-vn"));
});

test("media_audio_for_asr: sections and max_duration_s are honoured", async () => {
  const r = await s.agent("media_audio_for_asr", { url: "https://example.com/video/asr2", sections: [[5, 15]] });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(r.body.files[0].name, /\[asr2\] \[5-15\]\.wav$/);
  const long = await s.agent("media_audio_for_asr", { url: "https://example.com/long/asr3", max_duration_s: 600 });
  assert.equal(long.body.ok, false);
  assert.match(long.body.error, /límite 10 min/);
  const nowait = await s.agent("media_audio_for_asr", { url: "https://example.com/slow/asr4", wait: false });
  assert.ok(nowait.body.id);
  assert.equal(nowait.body.format, "audio");
  await s.agent("media_cancel", { id: nowait.body.id });
});

test("the sections, limits and asr flag survive a retry", async () => {
  const first = await s.agent("media_download", { url: "https://example.com/long/rt1", save_link: false, max_duration_s: 600, sections: [[1, 2]] });
  assert.equal(first.body.status, "failed");
  const again = await s.agent("media_retry", { id: first.body.id });
  assert.equal(again.body.status, "failed");
  assert.match(again.body.error, /límite 10 min/);
});

test("media URLs: private and local addresses are refused unless the person opted in", async () => {
  setEnv({ LINKS_ALLOW_PRIVATE_URLS: undefined });
  try {
    for (const url of ["http://127.0.0.1/video/x", "http://localhost/video/x", "http://192.168.1.5/v.mp4", "http://169.254.169.254/latest/meta-data", "http://[::1]/x", "http://nas.local/v.mp4", "ftp://example.com/x", "file:///etc/passwd"]) {
      assert.throws(() => normalizeMediaUrl(url), /apunta a este equipo|no es una URL|http\(s\)/, url);
    }
    assert.throws(() => startDownload({ url: "http://10.0.0.8/video/x" }), /red privada/);
    await assert.rejects(probeUrl({ url: "http://127.0.0.1/video/x" }), /red privada|este equipo/);
    const viaTool = await s.agent("media_download", { url: "http://127.0.0.1:9/video/x", wait: false });
    assert.equal(viaTool.status, 400);
    assert.match(viaTool.body.error, /este equipo o a una red privada/);
    assert.equal(normalizeMediaUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  } finally {
    setEnv({ LINKS_ALLOW_PRIVATE_URLS: "1" });
  }
  // opted in: the address rule is lifted, the scheme rule stays
  assert.equal(normalizeMediaUrl("http://192.168.1.5/v.mp4"), "http://192.168.1.5/v.mp4");
  assert.throws(() => normalizeMediaUrl("file:///etc/passwd"), /http\(s\)/);
});

test("import_video_transcript uses the same caption path as media_subtitles", async () => {
  const { link } = createLink({ url: "https://www.youtube.com/subs/yt1", source: "manual" });
  const r = await s.agent("import_video_transcript", { id: link.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.language, "es");
  assert.match(getLink(link.id).content_text, /Primera línea del vídeo\./);
  const none = createLink({ url: "https://www.youtube.com/nosubs/yt2", source: "manual" }).link;
  const failed = await s.agent("import_video_transcript", { id: none.id });
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /no ofrece subtítulos/);
});
