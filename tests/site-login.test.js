// "Iniciar sesión con…" and downloads without an account: the pure parts of site-login.js, the login window driven through a fake
// browser (fake-browser.js), the REST routes and MCP tools, and the media attempts (YouTube fallback players, the saved session).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, tempDir } from "./helpers.js";
import { installFakes } from "./media-fakes.js";
import * as sessions from "../server/site-login.js";
import * as media from "../server/media.js";
import { resetToolsCache } from "../server/media.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_KEYS = ["LINKS_YTDLP", "LINKS_GALLERYDL", "LINKS_FFMPEG", "PYTHON", "FAKE_DIR", "FAKE_LOG", "LINKS_MEDIA_DIR", "LINKS_MEDIA_SIBLING_DIR",
  "LINKS_MEDIA_AUTO_UPDATE", "LINKS_COOKIES_FILE", "LINKS_COOKIES_BROWSERS", "LINKS_LOGIN_BROWSER", "LINKS_SESSIONS_POLL_MS", "LINKS_SESSIONS_SETTLE_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (patch) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetToolsCache(); };
let s, fakes, tmp;

const until = async (fn, timeoutMs = 10_000, step = 25) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, step));
  }
};
const run = async (body) => {
  const r = await s.call("POST", "/api/media", { save_link: false, ...body });
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
  return until(async () => { const g = (await s.call("GET", `/api/media/${r.body.id}`)).body; return ["done", "failed", "cancelled"].includes(g.status) ? g : null; });
};
const ytCalls = () => fakes.calls("yt-dlp").filter((c) => !c.argv.includes("--version") && !c.argv.includes("-U"));
const arg = (call, name) => call.argv[call.argv.indexOf(name) + 1];
const profile = () => sessions.profileDir();
const jar = () => path.join(profile(), "fake-cookies.json");
const launches = () => { try { return fs.readFileSync(path.join(profile(), "fake-launches.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const YT_LOGIN = [
  { name: "LOGIN_INFO", value: "secret-login", domain: ".youtube.com", path: "/", expires: Date.now() / 1000 + 86400, httpOnly: true, secure: true, session: false },
  { name: "SAPISID", value: "secret-sapisid", domain: ".google.com", path: "/", expires: Date.now() / 1000 + 86400, httpOnly: false, secure: true, session: false },
];

before(async () => {
  tmp = tempDir();
  fakes = installFakes(path.join(tmp, "fakes"));
  setEnv({ ...fakes.env, LINKS_MEDIA_DIR: path.join(tmp, "descargas"), LINKS_COOKIES_FILE: undefined, LINKS_COOKIES_BROWSERS: "firefox",
    LINKS_LOGIN_BROWSER: `node:${path.join(HERE, "fake-browser.js")}`, LINKS_SESSIONS_POLL_MS: "60", LINKS_SESSIONS_SETTLE_MS: "120" });
  s = await bootServer();
});

after(async () => {
  await sessions.shutdown();
  sessions._reset();
  await s?.stop();
  setEnv(savedEnv);
});

test("sites by URL, the login cookie and the Netscape file", () => {
  assert.equal(sessions.siteForUrl("https://youtu.be/abc").id, "youtube");
  assert.equal(sessions.siteForUrl("https://mobile.twitter.com/a/status/1").id, "x");
  assert.equal(sessions.siteForUrl("www.instagram.com/reel/x/").id, "instagram");
  assert.equal(sessions.siteForUrl("https://example.com/video"), null);
  const yt = sessions.siteById("YouTube");
  assert.equal(yt.id, "youtube");
  assert.equal(sessions.loggedIn([{ name: "VISITOR_INFO1_LIVE", value: "v", domain: ".youtube.com" }], yt), false);
  assert.equal(sessions.loggedIn(YT_LOGIN, yt), true);
  assert.equal(sessions.loggedIn([{ ...YT_LOGIN[0], expires: 1000 }], yt), false, "an expired login cookie is no session");
  assert.equal(sessions.loggedIn([{ name: "auth_token", value: "t", domain: ".x.com" }], yt), false, "another site's cookie does not count");
  const pin = sessions.siteById("pinterest");
  assert.equal(sessions.loggedIn([{ name: "_auth", value: "0", domain: ".pinterest.com" }], pin), false);
  assert.equal(sessions.loggedIn([{ name: "_auth", value: "1", domain: ".pinterest.com" }], pin), true);

  const text = sessions.toNetscape([...YT_LOGIN, { name: "s", value: "v", domain: "www.youtube.com", path: "/", expires: -1, session: true }]);
  const lines = text.split("\n");
  assert.equal(lines[0], "# Netscape HTTP Cookie File");
  assert.ok(lines.includes(`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${Math.floor(YT_LOGIN[0].expires)}\tLOGIN_INFO\tsecret-login`));
  assert.ok(lines.includes("www.youtube.com\tFALSE\t/\tFALSE\t0\ts\tv"), "a session cookie gets expiry 0 and a host-only domain FALSE");
});

test("browser discovery: the default browser first, then Chrome, Edge, Brave…; the choice in Ajustes wins", () => {
  const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\U\\AppData\\Local" };
  const names = sessions.browserCandidates({ env, platform: "win32" }).map((c) => c.name);
  assert.equal(names[0], "Chrome");
  assert.ok(names.indexOf("Edge") > names.lastIndexOf("Chrome") && names.indexOf("Brave") > names.lastIndexOf("Edge"));
  const all = () => true;
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: (p) => p.endsWith("msedge.exe"), choice: "auto", fallback: null }).name, "Edge");
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: () => false, choice: "auto", fallback: null }), null);
  assert.equal(sessions.findBrowser({ env: { LINKS_LOGIN_BROWSER: "node:/nope.js" }, platform: "linux", exists: () => false }), null);

  // the system default (Brave here) goes first; a Firefox default is skipped; a choice in Ajustes wins over both
  const brave = { name: "Brave", path: "C:\\PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", usable: true };
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: all, choice: "auto", fallback: brave }).name, "Brave");
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: all, choice: "auto", fallback: { name: "firefox", path: "C:\\ff\\firefox.exe", usable: false } }).name, "Chrome");
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: all, choice: "Edge", fallback: brave }).name, "Edge");
  assert.equal(sessions.findBrowser({ env, platform: "win32", exists: all, choice: "Opera", fallback: brave }).name, "Brave", "a choice that is not installed falls back");
  const list = sessions.installedBrowsers({ env, platform: "win32", exists: all, fallback: brave });
  assert.deepEqual(list.map((b) => [b.name, b.default]).slice(0, 3), [["Brave", true], ["Chrome", false], ["Edge", false]]);
  assert.equal(list.filter((b) => b.name === "Brave").length, 1);
});

test("the default browser is read from the registry (Windows) and xdg-settings (Linux)", () => {
  const reg = (cmd, args) => {
    if (args.includes("ProgId")) return "\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    BraveHTML\r\n";
    return "\r\nHKEY_CLASSES_ROOT\\BraveHTML\\shell\\open\\command\r\n    (Predeterminado)    REG_SZ    \"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\" --single-argument %1\r\n";
  };
  const win = sessions.defaultBrowser({ platform: "win32", run: reg, fresh: true });
  assert.deepEqual(win, { name: "Brave", path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", usable: true, prog_id: "BraveHTML" });
  const ff = sessions.defaultBrowser({ platform: "win32", fresh: true, run: (c, a) => (a.includes("ProgId") ? "    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB" : "    (Default)    REG_SZ    \"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -osint -url \"%1\"") });
  assert.equal(ff.usable, false);
  const lin = sessions.defaultBrowser({ platform: "linux", fresh: true, run: () => "brave-browser.desktop\n" });
  assert.deepEqual(lin, { name: "Brave", path: "brave-browser", usable: true, desktop: "brave-browser" });
  assert.equal(sessions.defaultBrowser({ platform: "win32", fresh: true, run: () => { throw new Error("no reg"); } }), null);
  sessions.defaultBrowser({ platform: process.platform, fresh: true });
});

test("the attempts: no cookies, YouTube's fallback players, the saved session, then the browsers", () => {
  const yt = media.attemptsFor("auto", "https://www.youtube.com/watch?v=a", { cookiesFile: "", browsers: ["firefox"], sessionFile: "/d/sessions/cookies.txt" });
  assert.deepEqual(yt.map((a) => (a.extra ? "fallback" : a.session ? "session" : a.type === "browser" ? a.name : a.type)), ["none", "fallback", "session", "firefox"]);
  assert.deepEqual(yt[1].extra, ["--extractor-args", "youtube:player_client=default,web_embedded,mweb"]);
  const ig = media.attemptsFor("auto", "https://www.instagram.com/p/x/", { cookiesFile: "", browsers: ["firefox"], sessionFile: "" });
  assert.deepEqual(ig.map((a) => a.type), ["none", "browser"]);
  const own = media.attemptsFor("auto", "https://youtu.be/a", { cookiesFile: "/mine.txt", browsers: ["firefox"], sessionFile: "/d/sessions/cookies.txt" });
  assert.deepEqual(own, [{ type: "file", path: "/mine.txt" }], "a cookies file set in Ajustes wins over everything");
  const none = media.attemptsFor("none", "https://youtu.be/a", { cookiesFile: "", browsers: ["firefox"], sessionFile: "/x" });
  assert.equal(none.length, 2);
  assert.ok(none.every((a) => a.type === "none"));
});

test("a new profile whose first window quits on its own is opened again once", async () => {
  // runs first: the profile does not exist yet
  process.env.FAKE_BROWSER_QUIT_FIRST = "1";
  try {
    const opened = await s.call("POST", "/api/sessions/vimeo/login");
    assert.equal(opened.status, 202, JSON.stringify(opened.body));
    await until(() => launches().length >= 2, 8000);
    const r = await until(async () => { const b = (await s.call("GET", "/api/sessions")).body; return b.active?.state === "waiting" && b.active.open ? b : null; });
    assert.equal(r.active.site, "vimeo");
    assert.ok(launches().every((a) => !a.includes("--headless=new")), "reopened as a window, not read headless");
    await s.call("POST", "/api/sessions/cancel");
  } finally { delete process.env.FAKE_BROWSER_QUIT_FIRST; }
});

test("a public YouTube video under the bot check downloads through the fallback players, without an account", async () => {
  const before = ytCalls().length;
  const done = await run({ url: "https://www.youtube.com/botcheck/b1" });
  assert.equal(done.status, "done", done.error);
  assert.equal(done.cookies_browser, "");
  const calls = ytCalls().slice(before);
  assert.ok(!calls[0].argv.includes("--extractor-args"));
  assert.ok(calls.some((c) => arg(c, "--extractor-args") === "youtube:player_client=default,web_embedded,mweb"));
  assert.ok(calls.every((c) => !c.argv.includes("--cookies")), "no cookies were needed");
});

test("content that needs an account fails with the login button, and the saved session makes it work", async () => {
  const failed = await run({ url: "https://www.youtube.com/agegate/a1" });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.login, { site: "youtube", label: "YouTube" });
  assert.match(failed.error, /reproductores alternativos de YouTube/);
  assert.match(failed.error, /Iniciar sesión con YouTube/);
  const mcp = await s.agent("media_status", { id: failed.id });
  assert.deepEqual(mcp.body.login, { site: "youtube", label: "YouTube" });

  // a probe says it too, with the site in details
  const probe = await s.call("POST", "/api/media/probe", { url: "https://www.youtube.com/agegate/a2" });
  assert.equal(probe.status, 400);
  assert.deepEqual(probe.body.details?.login, { site: "youtube", label: "YouTube" });
  assert.match(probe.body.hint, /Iniciar sesión con YouTube/);

  // the login window: open, "sign in" in the fake browser, Links notices, saves and closes the window
  const opened = await s.call("POST", "/api/sessions/youtube/login");
  assert.equal(opened.status, 202, JSON.stringify(opened.body));
  assert.equal(opened.body.active.site, "youtube");
  assert.equal(opened.body.active.state, "waiting");
  const first = launches().at(-1);
  assert.ok(first.includes("--remote-debugging-port=0") && !first.includes("--headless=new"));
  const tabs = await until(() => { try { const p = JSON.parse(fs.readFileSync(path.join(profile(), "fake-pages.json"), "utf8")); return p.length === 1 && p[0].url.startsWith("https://accounts.google.com/") ? p : null; } catch { return null; } });
  assert.equal(tabs.length, 1, "only the sign-in page is open");
  fs.writeFileSync(jar(), JSON.stringify([...YT_LOGIN, { name: "auth_token", value: "x-secret", domain: ".x.com", path: "/", expires: Date.now() / 1000 + 86400 }]));
  const saved = await until(async () => { const r = (await s.call("GET", "/api/sessions")).body; return r.active?.state === "saved" ? r : null; });
  assert.equal(saved.active.open, false, "the window closed itself");
  assert.equal(saved.sites.find((x) => x.id === "youtube").logged_in, true);
  assert.equal(saved.sites.find((x) => x.id === "x").logged_in, true, "every known site's session in the profile is kept");
  assert.equal(saved.sites.find((x) => x.id === "instagram").logged_in, false);
  assert.ok(!JSON.stringify(saved).includes("secret"), "no cookie value leaves the server");
  const file = fs.readFileSync(sessions.cookiesPath(), "utf8");
  assert.match(file, /LOGIN_INFO\tsecret-login/);
  assert.match(file, /SAPISID\tsecret-sapisid/);

  // retry: the session is used after the attempts without cookies, and the download works
  const before = ytCalls().length;
  const retried = await s.call("POST", `/api/media/${failed.id}/retry`);
  assert.equal(retried.status, 202);
  const ok = await until(async () => { const g = (await s.call("GET", `/api/media/${failed.id}`)).body; return ["done", "failed"].includes(g.status) ? g : null; });
  assert.equal(ok.status, "done", ok.error);
  assert.equal(ok.cookies_browser, "sesión de Links");
  assert.equal(ok.login, null);
  const calls = ytCalls().slice(before);
  assert.ok(calls.some((c) => arg(c, "--cookies") === sessions.cookiesPath()));
  assert.ok(!calls.some((c) => c.argv.includes("--cookies-from-browser")), "the browsers were not needed");
});

test("closing the window by hand still saves the session; log out deletes the site's cookies", async () => {
  fs.writeFileSync(jar(), "[]");
  await sessions.logout("youtube");
  await sessions.logout("x");
  assert.equal(sessions.cookiesFileFor("https://youtu.be/a"), "");
  const opened = await s.call("POST", "/api/sessions/instagram/login");
  assert.equal(opened.status, 202);
  fs.writeFileSync(jar(), JSON.stringify([{ name: "sessionid", value: "ig-secret", domain: ".instagram.com", path: "/", expires: Date.now() / 1000 + 86400 }]));
  // "Ya he terminado" reads it now and closes the window
  const finished = await s.call("POST", "/api/sessions/finish");
  assert.equal(finished.status, 200);
  assert.equal(finished.body.active.state, "saved");
  assert.equal(finished.body.sites.find((x) => x.id === "instagram").logged_in, true);
  assert.equal(sessions.cookiesFileFor("https://www.instagram.com/reel/x/"), sessions.cookiesPath());

  // log out runs a headless browser over the same profile and removes only that site's cookies
  const n = launches().length;
  const out = await s.call("DELETE", "/api/sessions/instagram");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.sites.find((x) => x.id === "instagram").logged_in, false);
  assert.ok(launches().slice(n).some((a) => a.includes("--headless=new")));
  assert.equal(JSON.parse(fs.readFileSync(jar(), "utf8")).length, 0);
  assert.ok(!fs.readFileSync(sessions.cookiesPath(), "utf8").includes("ig-secret"));

  const unknown = await s.call("POST", "/api/sessions/myspace/login");
  assert.equal(unknown.status, 404);
});

test("the MCP tools: site_sessions, site_login (start and finish) and site_logout", async () => {
  const list = await s.agent("site_sessions", {});
  assert.equal(list.status, 200);
  assert.ok(list.body.sites.some((x) => x.id === "tiktok"));
  assert.equal(list.body.browser.name, "custom");
  const started = await s.agent("site_login", { site: "tiktok" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.active.site, "tiktok");
  assert.match(started.body.message, /ordenador donde corre Links/);
  fs.writeFileSync(jar(), JSON.stringify([{ name: "sessionid", value: "tt", domain: ".tiktok.com", path: "/", expires: Date.now() / 1000 + 86400 }]));
  const done = await s.agent("site_login", { site: "tiktok", finish: true });
  assert.equal(done.body.sites.find((x) => x.id === "tiktok").logged_in, true);
  const gone = await s.agent("site_logout", { site: "tiktok" });
  assert.equal(gone.body.sites.find((x) => x.id === "tiktok").logged_in, false);
  const bad = await s.call("PUT", "/api/sessions/settings", { browser: "Netscape" });
  assert.equal(bad.status, 400);
  const auto = await s.call("PUT", "/api/sessions/settings", { browser: "auto" });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.choice, "auto");
  assert.ok(Array.isArray(auto.body.browsers));
  const tools = await s.call("GET", "/api/agent/tools");
  const names = tools.body.tools.map((t) => t.name);
  for (const n of ["site_sessions", "site_login", "site_logout"]) assert.ok(names.includes(n), n);
});
