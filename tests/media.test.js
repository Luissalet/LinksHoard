// Media downloads, pure parts: platform detection, argument building,
// progress parsing, error wording, command specs, tool lookup and the queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectPlatform, isKnownPlatform, OTHER_PLATFORM, safeName, revealCommand, fileKind, mimeOf, normalizeMediaUrl, resolveTool, resetToolsCache, defaultSiblingDir } from "../server/media.js";
import {
  videoSelector, buildYtdlpArgs, buildGalleryArgs, buildProbeArgs, cookieAttempts, cookieArgs, parseYtdlpLine, ProgressTracker, formatSpeed, formatEta,
  explainFailure, parseCodecs, needsTranscode, OUTPUT_TEMPLATE, MediaQueue, parseCommandSpec, which, installHint, INSTALL_COMMAND, setLanguage,
} from "../server/hoard-commons/media.js";
import { installFakes } from "./media-fakes.js";
import { tempDir } from "./helpers.js";

test("platform detection labels the known sites and keeps trying the rest", () => {
  const cases = {
    "https://www.youtube.com/watch?v=abc": "YouTube",
    "https://youtu.be/abc": "YouTube",
    "https://music.youtube.com/watch?v=x": "YouTube",
    "https://x.com/user/status/1": "X (Twitter)",
    "https://mobile.twitter.com/user/status/1": "X (Twitter)",
    "https://t.co/abc": "X (Twitter)",
    "https://www.instagram.com/reel/abc/": "Instagram",
    "https://www.tiktok.com/@u/video/1": "TikTok",
    "https://audiomack.com/artist/song/x": "Audiomack",
    "https://soundcloud.com/a/b": "SoundCloud",
    "https://vimeo.com/123": "Vimeo",
    "https://www.twitch.tv/videos/1": "Twitch",
    "https://www.reddit.com/r/x/comments/1": "Reddit",
    "https://fb.watch/abc": "Facebook",
    "https://www.bilibili.com/video/BV1": "Bilibili",
    "https://example.org/clip.mp4": OTHER_PLATFORM,
    "https://notyoutube.com/x": OTHER_PLATFORM,
    "https://youtube.com.evil.example/x": OTHER_PLATFORM,
    "youtube.com/watch?v=abc": "YouTube", // scheme optional
    "not a url at all": OTHER_PLATFORM,
  };
  for (const [url, label] of Object.entries(cases)) assert.equal(detectPlatform(url), label, url);
  assert.equal(OTHER_PLATFORM, "Otro (yt-dlp)");
  assert.equal(isKnownPlatform("https://youtu.be/x"), true);
  assert.equal(isKnownPlatform("https://example.org/"), false);
});

test("URLs are normalised and refused when they are not http(s)", () => {
  assert.equal(normalizeMediaUrl("youtube.com/watch?v=abc"), "https://youtube.com/watch?v=abc");
  assert.equal(normalizeMediaUrl("  https://youtu.be/abc  "), "https://youtu.be/abc");
  assert.throws(() => normalizeMediaUrl(""), /Falta la URL/);
  assert.throws(() => normalizeMediaUrl("ftp://example.com/x"), /http\(s\)/);
  assert.throws(() => normalizeMediaUrl("file:///etc/passwd"), /http\(s\)/);
  assert.throws(() => normalizeMediaUrl("hola"), /http\(s\)|válida|apunta/);
});

test("video format selector prefers H.264 + AAC and honours the height cap", () => {
  assert.equal(videoSelector("best", true), "bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b/b");
  assert.match(videoSelector("720", true), /^bv\*\[vcodec\^=avc1\]\[height<=720\]\+ba\[ext=m4a\]\/b\[ext=mp4\]\[height<=720\]\/bv\*\[height<=720\]\+ba\/b\[height<=720\]\/b$/);
  // no ffmpeg: only single-file formats, nothing to merge
  assert.equal(videoSelector("1080", false), "b[ext=mp4][height<=1080]/b[height<=1080]/b");
  assert.ok(!videoSelector("best", false).includes("+"));
});

test("yt-dlp arguments per format and quality", () => {
  const base = { url: "https://youtu.be/abc", dir: "C:\\Users\\Luis Salet\\Downloads\\Links Hoard" };
  const video = buildYtdlpArgs({ ...base, format: "video", quality: "720", hasFfmpeg: true, ffmpegPath: "C:\\ffmpeg\\ffmpeg.exe" });
  assert.deepEqual(video.slice(-2), ["--", "https://youtu.be/abc"]);
  assert.ok(video.includes("--no-playlist") && !video.includes("--yes-playlist"));
  assert.equal(video[video.indexOf("-P") + 1], base.dir, "the folder goes as one argument, spaces and backslashes intact");
  assert.equal(video[video.indexOf("-o") + 1], OUTPUT_TEMPLATE);
  assert.equal(OUTPUT_TEMPLATE, "%(title).120s [%(id)s].%(ext)s");
  assert.ok(video.includes("--windows-filenames") && video.includes("--no-mtime"));
  assert.equal(video[video.indexOf("--merge-output-format") + 1], "mp4");
  assert.equal(video[video.indexOf("--ffmpeg-location") + 1], "C:\\ffmpeg\\ffmpeg.exe");
  assert.match(video[video.indexOf("-f") + 1], /height<=720/);
  assert.ok(!video.includes("--write-info-json") && !video.includes("--write-thumbnail"), "no sidecar files");
  assert.ok(video.includes("--progress-template") && video.includes("--print"));

  const audio = buildYtdlpArgs({ ...base, format: "audio", hasFfmpeg: true });
  assert.deepEqual(audio.slice(audio.indexOf("-f"), audio.indexOf("-f") + 7), ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0"]);
  assert.ok(!audio.includes("--merge-output-format"));

  const noFfmpeg = buildYtdlpArgs({ ...base, format: "video", hasFfmpeg: false });
  assert.ok(!noFfmpeg.includes("--merge-output-format") && !noFfmpeg.includes("--ffmpeg-location"));

  const list = buildYtdlpArgs({ ...base, format: "video", playlist: true, maxItems: 12 });
  assert.deepEqual(list.slice(list.indexOf("--yes-playlist"), list.indexOf("--yes-playlist") + 3), ["--yes-playlist", "--playlist-end", "12"]);
  assert.ok(!list.includes("--no-playlist"));
});

test("cookie attempts: none first, then the browsers; or exactly what was asked", () => {
  assert.deepEqual(cookieAttempts("auto").map((a) => a.type === "none" ? "none" : a.name), ["none", "firefox", "chrome", "edge", "brave", "chromium", "vivaldi", "opera"]);
  assert.deepEqual(cookieAttempts("chrome"), [{ type: "browser", name: "chrome" }]);
  assert.deepEqual(cookieAttempts("none"), [{ type: "none" }]);
  assert.deepEqual(cookieAttempts("auto", { cookiesFile: "/c/cookies.txt" }), [{ type: "file", path: "/c/cookies.txt" }]);
  assert.deepEqual(cookieAttempts("firefox", { cookiesFile: "/c/cookies.txt" }), [{ type: "browser", name: "firefox" }]);
  assert.deepEqual(cookieArgs({ type: "browser", name: "edge" }), ["--cookies-from-browser", "edge"]);
  assert.deepEqual(cookieArgs({ type: "file", path: "/c/cookies.txt" }), ["--cookies", "/c/cookies.txt"]);
  assert.deepEqual(cookieArgs({ type: "none" }), []);
  const args = buildYtdlpArgs({ url: "https://x.com/a/status/1", dir: "/d", cookie: { type: "browser", name: "firefox" } });
  assert.deepEqual(args.slice(args.indexOf("--cookies-from-browser"), args.indexOf("--cookies-from-browser") + 2), ["--cookies-from-browser", "firefox"]);
});

test("gallery-dl and probe arguments", () => {
  const g = buildGalleryArgs({ url: "https://www.instagram.com/p/abc/", dir: "/d/Fotos", cookie: { type: "browser", name: "chrome" }, maxItems: 20 });
  assert.deepEqual(g, ["--cookies-from-browser", "chrome", "--write-metadata", "--no-mtime", "--range", "1-20", "-D", "/d/Fotos", "--", "https://www.instagram.com/p/abc/"]);
  const p = buildProbeArgs({ url: "https://youtu.be/a" });
  assert.ok(p.includes("--dump-single-json") && p.includes("--skip-download") && p.includes("--no-playlist"));
  assert.ok(buildProbeArgs({ url: "https://youtu.be/a", playlist: true }).includes("--flat-playlist"));
});

test("progress lines from yt-dlp are parsed and folded into one bar", () => {
  assert.deepEqual(parseYtdlpLine("LHP|1024|10240|NA|2048.5|7|downloading"),
    { type: "progress", downloaded: 1024, total: 10240, estimate: null, speed: 2048.5, eta: 7, status: "downloading" });
  assert.deepEqual(parseYtdlpLine("LHP|NA|43153|NA|NA|NA|downloading"), { type: "progress", downloaded: null, total: 43153, estimate: null, speed: null, eta: null, status: "downloading" });
  assert.deepEqual(parseYtdlpLine("LHPP|Merger|started"), { type: "pp", name: "Merger", status: "started" });
  assert.deepEqual(parseYtdlpLine("LHSEL|137+140|2|5|/d/a|b.mp4"), { type: "sel", formatId: "137+140", index: 2, count: 5, filename: "/d/a|b.mp4" });
  assert.equal(parseYtdlpLine('LHMETA|{"id":"a","title":"T","filepath":"C:\\\\d\\\\T [a].mp4"}').data.filepath, "C:\\d\\T [a].mp4");
  assert.equal(parseYtdlpLine("LHMETA|{not json"), null);
  assert.deepEqual(parseYtdlpLine("[download] /d/T [a].mp4 has already been downloaded"), { type: "already", path: "/d/T [a].mp4" });
  assert.equal(parseYtdlpLine("[youtube] Extracting URL"), null);

  assert.equal(formatSpeed(1536), "1.5 KB/s");
  assert.equal(formatSpeed(5 * 1024 * 1024), "5.0 MB/s");
  assert.equal(formatSpeed(null), "");
  assert.equal(formatEta(9), "00:09");
  assert.equal(formatEta(3725), "1:02:05");
  assert.equal(formatEta(null), "");

  // two streams (video + audio): the bar goes 0..50 for the first, 50..100 (capped at 99) for the second
  const t = new ProgressTracker();
  t.select({ formatId: "137+140", index: null, count: null });
  const at = (downloaded, status = "downloading") => t.update({ type: "progress", downloaded, total: 100, estimate: null, speed: 1024, eta: 3, status });
  assert.equal(at(50).progress, 25);
  assert.equal(at(100, "finished").progress, 50);
  assert.equal(at(50).progress, 75);
  assert.equal(at(100, "finished").progress, 99);
  const pp = t.update({ type: "pp", name: "Merger", status: "started" });
  assert.equal(pp.status, "processing");
  assert.match(pp.detail, /Uniendo/);
  // a playlist of 4 single-stream items
  const pl = new ProgressTracker();
  pl.select({ formatId: "18", index: 3, count: 4 });
  assert.equal(pl.update({ type: "progress", downloaded: 50, total: 100, status: "downloading" }).progress, 62.5);
  assert.match(pl.update({ type: "progress", downloaded: 60, total: 100, status: "downloading" }).detail, /Elemento 3 de 4/);
  // never goes backwards
  const mono = new ProgressTracker();
  mono.select({ formatId: "18" });
  mono.update({ type: "progress", downloaded: 80, total: 100, status: "downloading" });
  assert.equal(mono.update({ type: "progress", downloaded: 10, total: 100, status: "downloading" }).progress, 80);
});

test("failures are explained in plain Spanish with the hint the user needs", () => {
  const login = explainFailure("yt-dlp", "ERROR: [Instagram] abc: Login required. Use --cookies-from-browser or --cookies for the authentication");
  assert.equal(login.authLike, true);
  assert.match(login.message, /iniciar sesión/);
  assert.match(login.message, /cookies/);
  const novideo = explainFailure("yt-dlp", "ERROR: [Instagram] abc: There is no video in this post");
  assert.equal(novideo.noVideo, true);
  assert.match(novideo.message, /no contiene vídeo/);
  assert.equal(explainFailure("yt-dlp", "ERROR: No video could be found in this tweet").noVideo, true);
  const unsupported = explainFailure("yt-dlp", "ERROR: Unsupported URL: https://example.com/x");
  assert.equal(unsupported.unsupported, true);
  assert.match(unsupported.message, /no es compatible/);
  const ffmpeg = explainFailure("yt-dlp", "ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path");
  assert.equal(ffmpeg.fatal, true);
  assert.equal(ffmpeg.code, "NO_FFMPEG");
  assert.match(ffmpeg.message, /Falta ffmpeg/);
  assert.match(ffmpeg.message, /winget install Gyan\.FFmpeg|brew install ffmpeg|apt install ffmpeg/);
  assert.match(explainFailure("yt-dlp", "ERROR: [youtube] x: Video unavailable").message, /no está disponible/);
  assert.match(explainFailure("yt-dlp", "yt-dlp: error: no such option: --foo").message, /desactualizado/);
  assert.match(explainFailure("yt-dlp", "ERROR: [youtube] x: nsig extraction failed: You may experience throttling").message, /desactualizado/);
  assert.match(explainFailure("yt-dlp", "ERROR: Unable to download webpage: <urlopen error Temporary failure in name resolution>").message, /conectar/);
  const other = explainFailure("yt-dlp", "boom\nERROR: algo raro pasó", { code: 1 });
  assert.match(other.message, /yt-dlp falló: algo raro pasó/);
  assert.equal(explainFailure("gallery-dl", "[instagram][error] something", { code: 16 }).authLike, true);
  assert.match(installHint("ytdlp"), /python -m pip install -U yt-dlp gallery-dl/);
  assert.equal(INSTALL_COMMAND, "python -m pip install -U yt-dlp gallery-dl");
});

test("file names are safe for Windows and kinds/mime types are guessed from the extension", () => {
  assert.equal(safeName('a<b>c:d"e/f\\g|h?i*j'), "a b c d e f g h i j");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(safeName("  fin con puntos... "), "fin con puntos");
  assert.equal(safeName(""), "descarga");
  assert.ok(safeName("x".repeat(300)).length <= 80);
  assert.equal(fileKind("a.MP4"), "video");
  assert.equal(fileKind("a.mp3"), "audio");
  assert.equal(fileKind("a.jpeg"), "image");
  assert.equal(fileKind("a.txt"), "other");
  assert.equal(mimeOf("/x/a.mp4"), "video/mp4");
  assert.equal(mimeOf("/x/a.m4a"), "audio/mp4");
  assert.equal(mimeOf("/x/a.bin"), "application/octet-stream");
});

test("codec probe decides when an MP4 must be re-encoded", () => {
  const h264 = parseCodecs("  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706d), 44100 Hz");
  assert.equal(h264.video.codec, "h264");
  assert.equal(h264.audio, "aac");
  assert.equal(needsTranscode(h264), false);
  assert.equal(needsTranscode(parseCodecs("Stream #0:0: Video: vp9 (Profile 0), yuv420p\nStream #0:1: Audio: opus")), true);
  assert.equal(needsTranscode(parseCodecs("Stream #0:0: Video: av1 (libdav1d), yuv420p\nStream #0:1: Audio: aac")), true);
  assert.equal(needsTranscode(parseCodecs("Stream #0:0: Video: h264 (High 10), yuv420p10le\nStream #0:1: Audio: aac")), true);
  assert.equal(needsTranscode(parseCodecs("Stream #0:0: Video: h264 (High), yuv420p\nStream #0:1: Audio: opus")), true);
  // cover art is not the video stream
  const cover = parseCodecs("Stream #0:0: Audio: mp3\nStream #0:1: Video: mjpeg, yuvj420p (attached pic)");
  assert.equal(cover.video, null);
  assert.equal(needsTranscode(cover), false);
});

test("show-in-folder commands per OS", () => {
  assert.deepEqual(revealCommand("C:\\Users\\Luis Salet\\Downloads\\Links Hoard\\a [x].mp4", "win32"),
    { cmd: "explorer.exe", args: ['/select,"C:\\Users\\Luis Salet\\Downloads\\Links Hoard\\a [x].mp4"'], verbatim: true });
  assert.deepEqual(revealCommand("/Users/l/a.mp4", "darwin"), { cmd: "open", args: ["-R", "/Users/l/a.mp4"], verbatim: false });
  assert.deepEqual(revealCommand("/home/l/dl/a.mp4", "linux"), { cmd: "xdg-open", args: ["/home/l/dl"], verbatim: false });
});

test("command specs: a path, node:script, a .js file or python -m module", () => {
  assert.deepEqual(parseCommandSpec("/usr/bin/yt-dlp"), { cmd: "/usr/bin/yt-dlp", args: [] });
  assert.deepEqual(parseCommandSpec("node:/tmp/fake.cjs"), { cmd: process.execPath, args: ["/tmp/fake.cjs"] });
  assert.deepEqual(parseCommandSpec("node:C:\\tmp\\fake.js"), { cmd: process.execPath, args: ["C:\\tmp\\fake.js"] });
  assert.deepEqual(parseCommandSpec("C:\\tmp\\fake.mjs"), { cmd: process.execPath, args: ["C:\\tmp\\fake.mjs"] });
  assert.deepEqual(parseCommandSpec('"C:\\Program Files\\yt-dlp\\yt-dlp.exe"'), { cmd: "C:\\Program Files\\yt-dlp\\yt-dlp.exe", args: [] });
  assert.deepEqual(parseCommandSpec("python -m yt_dlp"), { cmd: "python", args: ["-m", "yt_dlp"] });
  assert.equal(parseCommandSpec("   "), null);
});

test("tool lookup order: env, PATH, sibling app folder, python module", async () => {
  const dir = tempDir();
  const fakes = installFakes(path.join(dir, "fakes"));
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  const noEnv = { PATH: empty, FAKE_DIR: fakes.dir, FAKE_LOG: fakes.log };
  try {
    // 1. nothing anywhere
    resetToolsCache();
    const none = await resolveTool("ytdlp", { env: noEnv, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(none.found, false);
    assert.match(none.error, /python -m pip install -U yt-dlp gallery-dl/);

    // 2. env wins and reports how it was found
    const viaEnv = await resolveTool("ytdlp", { env: { ...noEnv, LINKS_YTDLP: fakes.env.LINKS_YTDLP }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(viaEnv.found, true);
    assert.equal(viaEnv.how, "env");
    assert.equal(viaEnv.version, "2026.01.01");

    // 3. a broken override is reported and the lookup goes on
    const broken = await resolveTool("ytdlp", { env: { ...noEnv, LINKS_YTDLP: path.join(dir, "no-such-binary") }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(broken.found, false);
    assert.equal(broken.tried[0].how, "env");

    // 4. PATH
    const onPath = path.join(dir, "bin");
    fs.mkdirSync(onPath);
    const script = path.join(onPath, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    fs.writeFileSync(script, `#!${process.execPath}\nconsole.log("2025.05.05");\n`, { mode: 0o755 });
    assert.equal(which("yt-dlp", { pathDirs: [onPath] }), script);
    assert.equal(which("yt-dlp", { pathDirs: [empty] }), null);
    if (process.platform !== "win32") {
      const viaPath = await resolveTool("ytdlp", { env: { ...noEnv, PATH: onPath }, siblingDir: path.join(dir, "nope"), refresh: true });
      assert.equal(viaPath.how, "path");
      assert.equal(viaPath.version, "2025.05.05");
    }

    // 5. the sibling app folder (Writers hoard desktop/resources/bin)
    if (process.platform !== "win32") {
      const sibling = path.join(dir, "Writers hoard desktop", "resources", "bin");
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, "yt-dlp"), `#!${process.execPath}\nconsole.log("2024.04.04");\n`, { mode: 0o755 });
      const viaSibling = await resolveTool("ytdlp", { env: noEnv, siblingDir: sibling, refresh: true });
      assert.equal(viaSibling.how, "sibling");
      assert.equal(viaSibling.version, "2024.04.04");
    }

    // 6. python -m yt_dlp
    const viaPython = await resolveTool("ytdlp", { env: { ...noEnv, PYTHON: fakes.env.PYTHON }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(viaPython.how, "python-module");
    assert.equal(viaPython.version, "2026.01.01");
    const gallery = await resolveTool("gallerydl", { env: { ...noEnv, PYTHON: fakes.env.PYTHON }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(gallery.how, "python-module");

    // ffmpeg: env, then missing with the install hint
    const ff = await resolveTool("ffmpeg", { env: { ...noEnv, LINKS_FFMPEG: fakes.env.LINKS_FFMPEG }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(ff.found, true);
    assert.equal(ff.version, "6.1-fake");
    const noFf = await resolveTool("ffmpeg", { env: noEnv, siblingDir: path.join(dir, "nope"), refresh: true });
    if (noFf.found) {
      // the shared lookup also tries the usual folders (/usr/bin, /usr/local/bin, Homebrew) after PATH
      assert.equal(noFf.how, "system");
    } else {
      assert.match(noFf.error, /LINKS_FFMPEG|HOARD_FFMPEG/);
    }
    // a Links-specific override beats everything, a family one too
    const viaFamily = await resolveTool("ffmpeg", { env: { ...noEnv, HOARD_FFMPEG: fakes.env.LINKS_FFMPEG }, siblingDir: path.join(dir, "nope"), refresh: true });
    assert.equal(viaFamily.how, "env");
    assert.equal(viaFamily.version, "6.1-fake");
  } finally {
    resetToolsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("$HOARD_HOME/bin is searched before PATH and the sibling app folder is only one more candidate", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  try {
    const home = path.join(dir, "hoard-home");
    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, "bin", "yt-dlp"), `#!${process.execPath}\nconsole.log("2026.05.05");\n`, { mode: 0o755 });
    const sibling = path.join(dir, "Writers hoard desktop", "resources", "bin");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "yt-dlp"), `#!${process.execPath}\nconsole.log("2024.04.04");\n`, { mode: 0o755 });
    const env = { PATH: path.join(dir, "empty"), HOARD_HOME: home };
    const viaHome = await resolveTool("ytdlp", { env, siblingDir: sibling, refresh: true });
    assert.equal(viaHome.how, "hoard-bin");
    assert.equal(viaHome.version, "2026.05.05");
    // without it the sibling folder still works
    const viaSibling = await resolveTool("ytdlp", { env: { PATH: env.PATH, HOARD_HOME: path.join(dir, "nowhere") }, siblingDir: sibling, refresh: true });
    assert.equal(viaSibling.how, "sibling");
    // the default sibling path is one candidate, "off" turns it off, an override replaces it
    assert.match(defaultSiblingDir({}), /Writers hoard desktop[\\/]resources[\\/]bin$/);
    assert.equal(defaultSiblingDir({ LINKS_MEDIA_SIBLING_DIR: "off" }), null);
    assert.equal(defaultSiblingDir({ LINKS_MEDIA_SIBLING_DIR: sibling }), sibling);
  } finally {
    resetToolsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the queue runs one job at a time, in order, and cancels waiting jobs without running them", async () => {
  const q = new MediaQueue();
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  q.enqueue("a", async () => { order.push("a:start"); await gate; order.push("a:end"); });
  q.enqueue("b", async () => { order.push("b"); });
  q.enqueue("c", async () => { order.push("c"); });
  assert.equal(q.enqueue("b", async () => {}), false, "the same id is not queued twice");
  assert.deepEqual(q.pendingIds, ["b", "c"]);
  assert.equal(q.activeId, "a");
  assert.equal(q.cancel("b"), "pending");
  assert.equal(q.cancel("zzz"), false);
  release();
  await q.idle();
  assert.deepEqual(order, ["a:start", "a:end", "c"]);
  assert.equal(q.size, 0);
});

test("cancelling the running job aborts its signal and keeps the lane until it settles", async () => {
  const q = new MediaQueue();
  const events = [];
  q.enqueue("a", (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => setTimeout(() => { events.push("a:killed"); resolve(); }, 30));
  }));
  q.enqueue("b", async () => { events.push("b:start"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.cancel("a"), "active");
  await q.idle();
  assert.deepEqual(events, ["a:killed", "b:start"], "b starts only after a is really gone");
  const waiting = new MediaQueue();
  waiting.enqueue("x", (signal) => new Promise((r) => (signal.aborted ? r() : signal.addEventListener("abort", r))));
  waiting.enqueue("y", async () => {});
  assert.deepEqual(waiting.cancelAll(), ["y"]);
  await waiting.idle();
});
