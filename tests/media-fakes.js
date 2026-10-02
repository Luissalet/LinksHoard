// Fake yt-dlp, gallery-dl and ffmpeg for the media tests: tiny Node scripts
// written to a temp dir and selected with LINKS_YTDLP="node:<script>" (the
// same form works on Windows, where a .cmd wrapper would be needed otherwise).
// What they do depends on the URL path, so one set of fakes covers every case:
//
//   /video/<id>      downloads <title> [<id>].mp4 (or .mp3 with -x), with progress lines
//   /vp9/<id>        like /video but the file is marked as VP9 (ffmpeg then transcodes it)
//   /photos/<id>     yt-dlp: "There is no video in this post"; gallery-dl: two jpg + metadata
//   /nometa/<id>     gallery-dl without any metadata sidecar
//   /private/<id>    needs login: only succeeds with --cookies-from-browser chrome
//   /gone/<id>       "Video unavailable"
//   /slow/<id>       prints progress and then hangs, with a grandchild process (cancel tests)
//   /exists/<id>     the file is already on disk ("has already been downloaded")
//   /nofiles/<id>    exits 0 and creates nothing
//   /flaky/<id>      fails with a network error until $FAKE_DIR/flaky-ok exists
//   /blocked/<id>    HTTP 403 on the video data while the version is the old 2026.01.01 (an update fixes it)
//
// Every call appends its argv as a JSON line to $FAKE_LOG.
import fs from "node:fs";
import path from "node:path";

const COMMON = `
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const log = (extra) => { try { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: TOOL, argv, ...(extra || {}) }) + "\\n"); } catch {} };
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const url = argv[argv.length - 1];
const pathname = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
const kind = pathname.split("/")[1] || "";
const id = pathname.split("/")[2] || "x";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

export const FAKE_YTDLP = `const TOOL = "yt-dlp";
${COMMON}
const versionFile = path.join(dir, "ytdlp-version");
const version = () => { try { return fs.readFileSync(versionFile, "utf8").trim(); } catch { return "2026.01.01"; } };
(async () => {
  if (has("--version")) { log(); console.log(version()); return; }
  if (has("-U")) { log(); fs.writeFileSync(versionFile, "2026.02.02"); console.log("Updated yt-dlp to 2026.02.02"); return; }
  log();
  const cookie = arg("--cookies-from-browser");
  if (has("--dump-single-json")) {
    if (kind === "photos") { console.error("ERROR: [Instagram] " + id + ": There is no video in this post"); process.exit(1); }
    if (kind === "gone") { console.error("ERROR: [youtube] " + id + ": Video unavailable"); process.exit(1); }
    if (kind === "list") {
      console.log(JSON.stringify({ _type: "playlist", title: "Lista de prueba", entries: [{ id: "a", title: "Uno" }, { id: "b", title: "Dos" }] }));
      return;
    }
    console.log(JSON.stringify({ id, title: "Título de prueba", uploader: "Canal de prueba", upload_date: "20260930", duration: 125.5,
      description: "Descripción de prueba", formats: [{ format_id: "a", acodec: "aac", vcodec: "none" }, { format_id: "v1", height: 360, acodec: "none" }, { format_id: "v2", height: 1080, acodec: "none" }, { format_id: "v3", height: 720, acodec: "none" }] }));
    return;
  }
  if (kind === "photos") { console.error("ERROR: [Instagram] " + id + ": There is no video in this post"); process.exit(1); }
  if (kind === "gone") { console.error("ERROR: [youtube] " + id + ": Video unavailable. This video has been removed by the uploader"); process.exit(1); }
  if (kind === "blocked" && version() === "2026.01.01") { console.error("ERROR: unable to download video data: HTTP Error 403: Forbidden"); process.exit(1); }
  if (kind === "flaky" && !fs.existsSync(path.join(dir, "flaky-ok"))) { console.error("ERROR: [generic] Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>"); process.exit(1); }
  if (kind === "private") {
    if (cookie === "chrome") { /* works */ }
    else if (cookie) { console.error("ERROR: could not find " + cookie + " cookies database in /fake"); process.exit(1); }
    else { console.error("ERROR: [Instagram] " + id + ": Login required. Use --cookies-from-browser or --cookies for the authentication"); process.exit(1); }
  }
  const out = arg("-P");
  fs.mkdirSync(out, { recursive: true });
  const audio = has("-x");
  const ext = audio ? "mp3" : "mp4";
  const title = "Título " + id;
  const file = path.join(out, title + " [" + id + "]." + ext);
  const kb = (n) => n * 1024;
  console.log("LHSEL|" + (audio ? "251" : "137+140") + "|NA|NA|" + file);
  if (kind === "slow") {
    fs.writeFileSync(path.join(dir, "slow.pid"), String(process.pid));
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "grandchild.pid"), String(child.pid));
    fs.writeFileSync(file + ".part", "partial");
    console.log("LHP|1024|10240|NA|1024|9|downloading");
    setInterval(() => {}, 1000);
    return;
  }
  if (kind === "nofiles") { return; }
  if (kind === "exists") {
    // like the real thing: an existing file is kept, never rewritten
    if (fs.existsSync(file)) { console.log("[download] " + file + " has already been downloaded"); return; }
    fs.writeFileSync(file, Buffer.alloc(kb(3), 1));
    console.log("LHMETA|" + JSON.stringify({ id, title, filepath: file }));
    return;
  }
  const marker = kind === "vp9" ? "VP9" : "H264";
  const streams = audio ? 1 : 2;
  for (let s = 0; s < streams; s++) {
    for (const pct of [25, 50, 100]) {
      const total = kb(8);
      console.log("LHP|" + Math.round(total * pct / 100) + "|" + total + "|NA|" + (524288 * (s + 1)) + "|" + (pct === 100 ? "0" : "2") + "|" + (pct === 100 ? "finished" : "downloading"));
      await sleep(15);
    }
  }
  if (audio) console.log("LHPP|ExtractAudio|started");
  else console.log("LHPP|Merger|started");
  fs.writeFileSync(file, Buffer.concat([Buffer.from(marker), Buffer.alloc(kb(8), 7)]));
  console.log("LHPP|MoveFiles|started");
  console.log("LHMETA|" + JSON.stringify({ id, title, uploader: "Canal de prueba", upload_date: "20260930", description: "Descripción de prueba del vídeo " + id, duration: 12.5, filepath: file }));
})();
`;

export const FAKE_GALLERYDL = `const TOOL = "gallery-dl";
${COMMON}
const versionFile = path.join(dir, "gallerydl-version");
(async () => {
  if (has("--version")) { log(); console.log(fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "1.30.0"); return; }
  if (has("-U")) { log(); fs.writeFileSync(versionFile, "1.31.0"); console.log("updated"); return; }
  log();
  const cookie = arg("--cookies-from-browser");
  if (has("-j")) {
    console.log(JSON.stringify([[2, { category: "instagram" }], [3, "http://x/1.jpg", { description: "Pie de foto de prueba", username: "autor_test" }], [3, "http://x/2.jpg", { description: "Pie de foto de prueba", username: "autor_test" }]]));
    return;
  }
  if (kind === "gone") { console.error("[instagram][error] NotFoundError: post not found"); process.exit(8); }
  if (kind === "weird") { console.error("[gallery-dl][error] Unsupported URL '" + url + "'"); process.exit(64); }
  if (kind === "private" && cookie !== "chrome") { console.error("[instagram][error] AuthRequired: 'login required'"); process.exit(16); }
  if (kind === "empty") { return; }
  const out = arg("-D");
  fs.mkdirSync(out, { recursive: true });
  for (const n of [1, 2]) {
    const file = path.join(out, "photo_" + n + ".jpg");
    fs.writeFileSync(file, Buffer.alloc(2048, n));
    if (kind !== "nometa") fs.writeFileSync(file + ".json", JSON.stringify({ description: "Pie de foto de prueba\\nsegunda línea", username: "autor_test", date: "2026-09-30 10:00:00", post_shortcode: id }));
    console.log(file);
    await sleep(10);
  }
})();
`;

export const FAKE_FFMPEG = `const TOOL = "ffmpeg";
${COMMON}
(async () => {
  if (has("-version")) { console.log("ffmpeg version 6.1-fake Copyright (c) test"); return; }
  log();
  const input = arg("-i");
  const last = argv[argv.length - 1];
  if (input && last === input) {
    // probing: describe the streams on stderr and exit 1, like the real thing
    const head = fs.readFileSync(input).subarray(0, 4).toString();
    const video = head === "VP9" || head.startsWith("VP9") ? "vp9 (Profile 0), yuv420p" : "h264 (High) (avc1 / 0x31637661), yuv420p(progressive)";
    const audio = head.startsWith("VP9") ? "opus" : "aac (LC)";
    console.error("Input #0, mov,mp4, from '" + input + "':");
    console.error("  Stream #0:0[0x1](und): Video: " + video + ", 320x240, 15 fps");
    console.error("  Stream #0:1[0x2](und): Audio: " + audio + ", 44100 Hz, stereo");
    process.exit(1);
  }
  fs.writeFileSync(last, Buffer.concat([Buffer.from("H264"), Buffer.alloc(4096, 9)]));
})();
`;

// A fake interpreter: "python -m yt_dlp --version" and "python -m pip install -U yt-dlp".
export const FAKE_PYTHON = `const TOOL = "python";
${COMMON}
const versionFile = path.join(dir, "ytdlp-version");
const version = () => { try { return fs.readFileSync(versionFile, "utf8").trim(); } catch { return "2026.01.01"; } };
log();
if (argv[0] === "--version") { console.log("Python 3.99.0"); process.exit(0); }
if (argv[0] === "-m" && argv[1] === "yt_dlp" && argv[2] === "--version") { console.log(version()); process.exit(0); }
if (argv[0] === "-m" && argv[1] === "gallery_dl" && argv[2] === "--version") { console.log("1.30.0"); process.exit(0); }
if (argv[0] === "-m" && argv[1] === "pip") { if (argv.includes("yt-dlp")) fs.writeFileSync(versionFile, "2026.03.03"); console.log("Successfully installed " + argv[argv.length - 1]); process.exit(0); }
console.error("No module named " + argv[1]); process.exit(1);
`;

/** Write the three fakes to `dir`; returns the env values that select them and the log file. */
export function installFakes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { ytdlp: "fake-yt-dlp.cjs", gallerydl: "fake-gallery-dl.cjs", ffmpeg: "fake-ffmpeg.cjs", python: "fake-python.cjs" };
  fs.writeFileSync(path.join(dir, files.ytdlp), FAKE_YTDLP);
  fs.writeFileSync(path.join(dir, files.gallerydl), FAKE_GALLERYDL);
  fs.writeFileSync(path.join(dir, files.ffmpeg), FAKE_FFMPEG);
  fs.writeFileSync(path.join(dir, files.python), FAKE_PYTHON);
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  return {
    dir,
    log,
    paths: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.join(dir, v)])),
    env: {
      LINKS_YTDLP: `node:${path.join(dir, files.ytdlp)}`,
      LINKS_GALLERYDL: `node:${path.join(dir, files.gallerydl)}`,
      LINKS_FFMPEG: `node:${path.join(dir, files.ffmpeg)}`,
      PYTHON: `node:${path.join(dir, files.python)}`,
      FAKE_DIR: dir,
      FAKE_LOG: log,
      // the real sibling app's yt-dlp/gallery-dl must not be found while the fakes are in use
      LINKS_MEDIA_SIBLING_DIR: "off",
      // the fakes report an old version: no automatic yt-dlp update unless a test turns it on
      LINKS_MEDIA_AUTO_UPDATE: "0",
    },
    calls: (tool) => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !tool || c.tool === tool),
  };
}
