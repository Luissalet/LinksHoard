// Site sessions: "Iniciar sesión con YouTube / X / Instagram…" for the downloads that need an account.
//
// Reading a browser's cookies from outside no longer works on Windows (Chrome and Edge encrypt them with a key only the browser can
// use), and exporting a cookies.txt by hand is a chore. So Links opens a window of an installed Chromium browser (Chrome, Edge, Brave,
// Chromium) with a profile of its own (<data>/sessions/browser-profile) and the DevTools port on 127.0.0.1, the person signs in there
// as usual, and Links asks that browser for its cookies (Storage.getCookies) and writes the ones of the known sites to
// <data>/sessions/cookies.txt (Netscape format, what yt-dlp and gallery-dl read). The window closes itself a few seconds after the
// site's login cookie appears; if the person closes it first, the cookies are read from the same profile in a headless run.
// The profile keeps the sessions, so signing in again later is usually one click, and "Cerrar sesión" deletes that site's cookies
// from the profile and the file.
//
// Downloads use the file on their own (media.js): no cookies first, then (YouTube) the fallback clients, then this session, then the
// browsers. Nothing here ever returns cookie values through the API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { dataDir, now, getSetting, setSetting } from "./db.js";

/** The sites with a login button: where to sign in, which cookie domains belong to them and which cookie says "signed in". */
export const SITES = [
  { id: "youtube", label: "YouTube", url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"], domains: ["youtube.com", "google.com"], auth: ["LOGIN_INFO", "SAPISID", "__Secure-3PSID"] },
  { id: "x", label: "X (Twitter)", url: "https://x.com/i/flow/login", hosts: ["x.com", "twitter.com", "t.co", "fxtwitter.com", "vxtwitter.com", "fixupx.com"],
    domains: ["x.com", "twitter.com"], auth: ["auth_token"] },
  { id: "instagram", label: "Instagram", url: "https://www.instagram.com/accounts/login/", hosts: ["instagram.com", "instagr.am"],
    domains: ["instagram.com"], auth: ["sessionid"] },
  { id: "threads", label: "Threads", url: "https://www.threads.net/login", hosts: ["threads.net", "threads.com"], domains: ["threads.net", "threads.com"], auth: ["sessionid"] },
  { id: "tiktok", label: "TikTok", url: "https://www.tiktok.com/login", hosts: ["tiktok.com"], domains: ["tiktok.com"], auth: ["sessionid", "sid_tt"] },
  { id: "facebook", label: "Facebook", url: "https://www.facebook.com/login", hosts: ["facebook.com", "fb.watch", "fb.com"], domains: ["facebook.com"], auth: ["c_user"] },
  { id: "reddit", label: "Reddit", url: "https://www.reddit.com/login/", hosts: ["reddit.com", "redd.it"], domains: ["reddit.com"], auth: ["reddit_session"] },
  { id: "twitch", label: "Twitch", url: "https://www.twitch.tv/login", hosts: ["twitch.tv"], domains: ["twitch.tv"], auth: ["auth-token"] },
  { id: "vimeo", label: "Vimeo", url: "https://vimeo.com/log_in", hosts: ["vimeo.com"], domains: ["vimeo.com"], auth: ["vimeo"] },
  { id: "pinterest", label: "Pinterest", url: "https://www.pinterest.com/login/", hosts: ["pinterest.com", "pin.it"], domains: ["pinterest.com"], auth: ["_pinterest_sess"], authValue: { _auth: "1" } },
  { id: "soundcloud", label: "SoundCloud", url: "https://soundcloud.com/signin", hosts: ["soundcloud.com", "snd.sc"], domains: ["soundcloud.com"], auth: ["oauth_token"] },
  { id: "bilibili", label: "Bilibili", url: "https://passport.bilibili.com/login", hosts: ["bilibili.com", "b23.tv"], domains: ["bilibili.com"], auth: ["SESSDATA"] },
  { id: "patreon", label: "Patreon", url: "https://www.patreon.com/login", hosts: ["patreon.com"], domains: ["patreon.com"], auth: ["session_id"] },
];

const LOGIN_TIMEOUT_MS = 15 * 60_000;
// after the login cookie appears, wait for the site's last redirects before reading and closing (the tests shorten both)
const SETTLE_MS = () => Number(process.env.LINKS_SESSIONS_SETTLE_MS) || 3000;
const POLL_MS = () => Number(process.env.LINKS_SESSIONS_POLL_MS) || 2000;

export class SessionError extends Error {
  constructor(message, { status = 400, code = "SESSION" } = {}) { super(message); this.status = status; this.code = code; this.expose = true; }
}

const hostOf = (url) => {
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`).hostname.toLowerCase(); } catch { return ""; }
};
const underDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export const siteById = (id) => SITES.find((s) => s.id === String(id || "").trim().toLowerCase()) || null;

/** The site a URL belongs to (by host), or null. */
export function siteForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  return SITES.find((s) => s.hosts.some((d) => underDomain(host, d))) || null;
}

const cookieHost = (c) => String(c.domain || "").replace(/^\./, "").toLowerCase();
/** True when the cookie belongs to one of the site's domains. */
export const cookieOfSite = (cookie, site) => site.domains.some((d) => underDomain(cookieHost(cookie), d));
const known = (cookie) => SITES.some((s) => cookieOfSite(cookie, s));

/** True when the cookies show a signed-in session on the site (its login cookie is there with a value, and not expired). */
export function loggedIn(cookies, site, nowMs = Date.now()) {
  return cookies.some((c) => {
    if (!cookieOfSite(c, site) || !c.value) return false;
    if (Number(c.expires) > 0 && Number(c.expires) * 1000 < nowMs) return false;
    if (site.auth.includes(c.name)) return true;
    return site.authValue ? site.authValue[c.name] === c.value : false;
  });
}

/** Cookies in the Netscape format yt-dlp and gallery-dl read (HttpOnly ones with the #HttpOnly_ prefix, session cookies with expiry 0). */
export function toNetscape(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# Written by Links Hoard from its sign-in window. Do not share this file.", ""];
  for (const c of cookies) {
    const domain = String(c.domain || "");
    if (!domain || /[\t\n\r]/.test(`${c.name}${c.value}${c.path}`)) continue;
    const expires = Number(c.expires) > 0 && !c.session ? Math.floor(Number(c.expires)) : 0;
    lines.push([`${c.httpOnly ? "#HttpOnly_" : ""}${domain}`, domain.startsWith(".") ? "TRUE" : "FALSE", c.path || "/", c.secure ? "TRUE" : "FALSE", String(expires), c.name, c.value ?? ""].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// paths and the saved status
// ---------------------------------------------------------------------------

const baseDir = () => path.join(process.env.LINKS_SESSIONS_DIR || path.join(dataDir() || path.join(os.homedir(), ".links-hoard"), "sessions"));
const slug = (name) => String(name || "browser").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "browser";
/** The profile of the browser in use (one per browser: their cookie stores cannot be shared). */
export const profileDir = (browser = findBrowser()) => path.join(baseDir(), `browser-profile-${slug(browser?.name)}`);
export const cookiesPath = () => path.join(baseDir(), "cookies.txt");
const statusPath = () => path.join(baseDir(), "status.json");

function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusPath(), "utf8")) || {}; } catch { return {}; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Writes the known sites' cookies to cookies.txt and records, per site, whether it is signed in. Returns the new status. */
export function saveCookies(cookies, { nowMs = Date.now() } = {}) {
  const mine = cookies.filter(known);
  writeAtomic(cookiesPath(), toNetscape(mine));
  const previous = readStatus().sites || {};
  const sites = {};
  for (const s of SITES) {
    const count = mine.filter((c) => cookieOfSite(c, s)).length;
    const signed = loggedIn(mine, s, nowMs);
    sites[s.id] = { logged_in: signed, cookies: count, captured_at: new Date(nowMs).toISOString(), since: signed ? (previous[s.id]?.logged_in ? previous[s.id].since || null : new Date(nowMs).toISOString()) : null };
  }
  const status = { captured_at: new Date(nowMs).toISOString(), sites };
  writeAtomic(statusPath(), JSON.stringify(status, null, 2));
  return status;
}

/** The cookies file for a URL when Links holds a signed-in session for its site, else "". */
export function cookiesFileFor(url) {
  const site = siteForUrl(url);
  if (!site) return "";
  const st = readStatus().sites?.[site.id];
  if (!st?.logged_in) return "";
  return fs.existsSync(cookiesPath()) ? cookiesPath() : "";
}

// ---------------------------------------------------------------------------
// finding a browser
// ---------------------------------------------------------------------------

/** Where Chromium browsers live on this system, in order of preference (Chrome, Edge, Brave, Chromium). */
export function browserCandidates({ env = process.env, platform = process.platform } = {}) {
  const out = [];
  const add = (name, p) => { if (p) out.push({ name, path: p }); };
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    for (const root of [pf, pf86, local]) add("Chrome", path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    for (const root of [pf86, pf]) add("Edge", path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    for (const root of [pf, pf86, local]) add("Brave", path.win32.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
    add("Vivaldi", path.win32.join(local, "Vivaldi", "Application", "vivaldi.exe"));
    add("Chromium", path.win32.join(local, "Chromium", "Application", "chrome.exe"));
  } else if (platform === "darwin") {
    add("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    add("Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    add("Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    add("Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi");
    add("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const [name, bin] of LINUX_BINS) {
      for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) add(name, path.join(dir, bin));
    }
  }
  return out;
}

const LINUX_BINS = [["Chrome", "google-chrome"], ["Chrome", "google-chrome-stable"], ["Edge", "microsoft-edge"], ["Brave", "brave-browser"], ["Brave", "brave"],
  ["Vivaldi", "vivaldi"], ["Chromium", "chromium"], ["Chromium", "chromium-browser"]];

/** Chromium browsers by executable (the only ones with the DevTools port this needs); anything else (Firefox, Safari) is not usable. */
const CHROMIUM_EXES = { "brave.exe": "Brave", "chrome.exe": "Chrome", "msedge.exe": "Edge", "vivaldi.exe": "Vivaldi", "opera.exe": "Opera", "chromium.exe": "Chromium",
  "brave-browser": "Brave", brave: "Brave", "google-chrome": "Chrome", "google-chrome-stable": "Chrome", "microsoft-edge": "Edge", vivaldi: "Vivaldi", chromium: "Chromium", "chromium-browser": "Chromium" };

/** The executable at the start of a shell open command ("C:\\…\\brave.exe" --single-argument %1 → C:\\…\\brave.exe). */
export function exeFromCommand(command) {
  const m = String(command || "").trim().match(/^"([^"]+)"|^(\S+)/);
  return m ? (m[1] || m[2]) : "";
}

/** "Brave", "Chrome", … for a Chromium browser's executable, or null (Firefox and other engines). */
export function browserNameOf(exe) {
  const base = String(exe || "").split(/[\\/]/).pop().toLowerCase();
  return CHROMIUM_EXES[base] || null;
}

/** The value of one entry in `reg query` output (`name` "" = the first value, which is the default one with /ve). */
export function regValue(stdout, name = "") {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
    if (m && (!name || m[1].toLowerCase() === name.toLowerCase())) return m[2].trim();
  }
  return "";
}

const runQuiet = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
let defaultCache = { at: 0, value: undefined };

/**
 * The system's default browser as { name, path, usable }: on Windows the https handler of the current user (UserChoice ProgId and its
 * open command), on Linux xdg-settings. usable is false for a browser without the DevTools port (Firefox…). null when unknown.
 */
export function defaultBrowser({ platform = process.platform, run = runQuiet, fresh = false } = {}) {
  if (!fresh && defaultCache.platform === platform && defaultCache.value !== undefined && Date.now() - defaultCache.at < 5 * 60_000) return defaultCache.value;
  let value = null;
  try {
    if (platform === "win32") {
      const progId = regValue(run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"]), "ProgId");
      if (progId) {
        const exe = exeFromCommand(regValue(run("reg", ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"])));
        const name = browserNameOf(exe);
        value = exe ? { name: name || path.win32.basename(exe, ".exe"), path: exe, usable: !!name, prog_id: progId } : null;
      }
    } else if (platform === "linux") {
      const desktop = String(run("xdg-settings", ["get", "default-web-browser"]) || "").trim().replace(/\.desktop$/, "");
      const name = browserNameOf(desktop);
      const bin = LINUX_BINS.find(([n]) => n === name)?.[1];
      value = desktop ? { name: name || desktop, path: bin || desktop, usable: !!name, desktop } : null;
    }
  } catch { value = null; }
  defaultCache = { at: Date.now(), value, platform };
  return value;
}

const choiceSetting = () => { try { return String(getSetting("sessions.browser", "auto") || "auto"); } catch { return "auto"; } };

/** The Chromium browsers installed here, one per name, the default one marked (and first). */
export function installedBrowsers({ env = process.env, platform = process.platform, exists = fs.existsSync, fallback } = {}) {
  const def = fallback !== undefined ? fallback : defaultBrowser({ platform });
  const seen = new Map();
  if (def?.usable && exists(def.path)) seen.set(def.name, { name: def.name, path: def.path, default: true });
  for (const c of browserCandidates({ env, platform })) if (!seen.has(c.name) && exists(c.path)) seen.set(c.name, { ...c, default: false });
  return [...seen.values()];
}

/**
 * The browser for the sign-in window: LINKS_LOGIN_BROWSER (a path, or "node:<script>" which the tests use), else the one chosen in
 * Ajustes (sessions.browser), else the system's default browser when it is a Chromium one, else Chrome, Edge, Brave, Vivaldi, Chromium.
 */
export function findBrowser({ env = process.env, platform = process.platform, exists = fs.existsSync, choice = choiceSetting(), fallback } = {}) {
  const custom = String(env.LINKS_LOGIN_BROWSER || "");
  if (custom.startsWith("node:")) return exists(custom.slice(5)) ? { name: "custom", path: custom } : null;
  if (custom) return exists(custom) ? { name: browserNameOf(custom) || "custom", path: custom } : null;
  const all = installedBrowsers({ env, platform, exists, fallback });
  const wanted = choice && choice !== "auto" ? all.find((b) => b.name.toLowerCase() === choice.toLowerCase()) : null;
  const pick = wanted || all[0];
  return pick ? { name: pick.name, path: pick.path } : null;
}

/** Ajustes: which browser the sign-in window uses ("auto" = the default one). */
export function setBrowserChoice(choice) {
  const value = String(choice || "auto").trim();
  if (value !== "auto" && !installedBrowsers().some((b) => b.name.toLowerCase() === value.toLowerCase())) {
    throw new SessionError(`«${value}» no está instalado o no sirve para iniciar sesión (hace falta un navegador Chromium: Chrome, Edge, Brave, Vivaldi…).`, { status: 400 });
  }
  setSetting("sessions.browser", value);
  return list();
}

const command = (browser) => (browser.path.startsWith("node:") ? { cmd: process.execPath, pre: [browser.path.slice(5)] } : { cmd: browser.path, pre: [] });

// ---------------------------------------------------------------------------
// talking to the browser (Chrome DevTools Protocol over the WebSocket Node has built in)
// ---------------------------------------------------------------------------

function cdpConnect(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (error) { reject(error); return; }
    const pending = new Map();
    let seq = 0;
    const failAll = (why) => { for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closed */ } reject(new Error("El navegador no responde.")); }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const t = setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method}: sin respuesta del navegador.`)); }, 15000);
            pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close() { try { ws.close(); } catch { /* closed */ } },
      });
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); } catch { return; }
      const p = msg.id ? pending.get(msg.id) : null;
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "Error del navegador")); else p.resolve(msg.result || {});
    };
    ws.onerror = () => { clearTimeout(timer); failAll("Conexión con el navegador perdida."); reject(new Error("No se pudo conectar con el navegador.")); };
    ws.onclose = () => failAll("Conexión con el navegador cerrada.");
  });
}

async function withCdp(wsUrl, fn) {
  const c = await cdpConnect(wsUrl);
  try { return await fn(c); } finally { c.close(); }
}

const readCookies = (wsUrl) => withCdp(wsUrl, async (c) => (await c.send("Storage.getCookies")).cookies || []);

async function deleteSiteCookies(wsUrl, site) {
  return withCdp(wsUrl, async (c) => {
    const cookies = ((await c.send("Storage.getCookies")).cookies || []).filter((k) => cookieOfSite(k, site));
    if (!cookies.length) return 0;
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
    try {
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      for (const k of cookies) await c.send("Network.deleteCookies", { name: k.name, domain: k.domain, path: k.path }, sessionId);
    } finally {
      await c.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    return cookies.length;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (proc) => proc && proc.exitCode === null && proc.signalCode === null;

/** Starts the browser on Links' profile with the DevTools port on 127.0.0.1 and waits for its WebSocket address. */
async function launch(browser, extraArgs, { timeoutMs = 25000 } = {}) {
  const profile = profileDir(browser);
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  try { fs.rmSync(portFile, { force: true }); } catch { /* in use: a stale browser still holds it */ }
  const { cmd, pre } = command(browser);
  const proc = spawn(cmd, [...pre,
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", ...extraArgs,
  ], { stdio: "ignore", windowsHide: false });
  proc.on("error", () => { /* reported through waitPort */ });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const [port, wsPath] = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && wsPath) return { proc, ws: `ws://127.0.0.1:${port.trim()}${wsPath.trim()}` };
    } catch { /* not yet */ }
    if (!alive(proc) && proc.exitCode !== null) {
      throw new SessionError(`${browser.name} se cerró nada más abrirse. Si ya hay una ventana de inicio de sesión de Links abierta, ciérrala y vuelve a pulsar.`, { status: 409 });
    }
    await sleep(200);
  }
  try { proc.kill(); } catch { /* gone */ }
  throw new SessionError(`${browser.name} no abrió su puerto de control a tiempo.`, { status: 504 });
}

async function closeBrowser(handle) {
  if (!handle) return;
  try { await withCdp(handle.ws, (c) => c.send("Browser.close")); } catch { /* already closing */ }
  const end = Date.now() + 8000;
  while (alive(handle.proc) && Date.now() < end) await sleep(150);
  if (alive(handle.proc)) { try { handle.proc.kill(); } catch { /* gone */ } }
}

let headlessQueue = Promise.resolve();
/** Runs fn(ws) on a headless browser over the same profile (no window), one at a time. */
function withHeadless(fn) {
  const run = headlessQueue.then(async () => {
    const browser = findBrowser();
    if (!browser) throw noBrowser();
    const handle = await launch(browser, ["--headless=new", "about:blank"]);
    try { return await fn(handle.ws); } finally { await closeBrowser(handle); }
  });
  headlessQueue = run.catch(() => {});
  return run;
}

const noBrowser = () => new SessionError("No encontré Chrome, Edge, Brave ni Chromium en este equipo. Instala uno (o indica su ruta en LINKS_LOGIN_BROWSER) para iniciar sesión desde Links.", { status: 424, code: "NO_BROWSER" });

// ---------------------------------------------------------------------------
// the login window
// ---------------------------------------------------------------------------

/** The one login window that can be open: { site, browser, handle, state, started_at, detail, ... }. */
let current = null;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => { for (const fn of listeners) { try { fn(view()); } catch { /* a listener never breaks the flow */ } } };

function setState(state, detail = "") {
  if (!current) return;
  current.state = state;
  current.detail = detail;
  current.updated_at = now();
  changed();
}

function stopTimer() { if (current?.timer) { clearInterval(current.timer); current.timer = null; } }

async function capture(liveWs) {
  const cookies = liveWs ? await readCookies(liveWs) : await withHeadless(readCookies);
  return saveCookies(cookies);
}

async function tick() {
  const c = current;
  if (!c || c.busy || !c.handle || !alive(c.handle.proc)) return;
  c.busy = true;
  try {
    const site = siteById(c.site);
    const cookies = await readCookies(c.handle.ws);
    if (loggedIn(cookies, site)) {
      c.seenAt ||= Date.now();
      if (Date.now() - c.seenAt >= SETTLE_MS()) {
        stopTimer();
        saveCookies(await readCookies(c.handle.ws).catch(() => cookies));
        c.closing = true;
        await closeBrowser(c.handle);
        setState("saved", `Sesión de ${site.label} guardada.`);
      } else if (c.state !== "signing") setState("signing", "Sesión detectada; guardándola…");
    } else if (Date.now() - c.startedMs > LOGIN_TIMEOUT_MS) {
      stopTimer();
      saveCookies(cookies);
      c.closing = true;
      setState("expired", "Pasaron 15 minutos sin iniciar sesión; cerré la ventana.");
      await closeBrowser(c.handle);
    }
  } catch { /* the window is closing or between pages: next tick */ } finally { c.busy = false; }
}

async function onExit(c) {
  stopTimer();
  if (current !== c || c.closing) return;
  // a brand-new profile: the browser may finish setting it up and quit on its own a few seconds after the first start; open it again once
  if (c.fresh && !c.relaunched && Date.now() - c.launchedMs < 20_000) {
    c.relaunched = true;
    await sleep(1000);
    try { await openWindow(c); return; } catch (error) { setState("failed", error.message); return; }
  }
  // the person closed the window: read what the profile kept, without a window
  setState("capturing", "Ventana cerrada; leyendo la sesión…");
  await sleep(1200);
  try {
    const status = await capture(null);
    const ok = status.sites?.[c.site]?.logged_in;
    setState(ok ? "saved" : "closed", ok ? `Sesión de ${siteById(c.site).label} guardada.` : "Cerraste la ventana sin iniciar sesión.");
  } catch (error) {
    setState("failed", `No pude leer la sesión: ${error.message}`);
  }
}

/** Opens (or reuses) the login window on the site's sign-in page. */
export async function startLogin(id) {
  const site = siteById(id);
  if (!site) throw new SessionError(`No conozco el sitio «${id}». Sitios: ${SITES.map((s) => s.id).join(", ")}.`, { status: 404, code: "UNKNOWN_SITE" });
  if (current?.handle && alive(current.handle.proc) && !current.closing) {
    // one window at a time: the same browser opens the new site in a tab
    await withCdp(current.handle.ws, (c) => c.send("Target.createTarget", { url: site.url, newWindow: false })).catch(() => {});
    Object.assign(current, { site: site.id, startedMs: Date.now(), started_at: now(), seenAt: 0 });
    setState("waiting", `Inicia sesión en ${site.label} en la ventana abierta.`);
    return view();
  }
  const browser = findBrowser();
  if (!browser) throw noBrowser();
  await headlessQueue;
  current = { site: site.id, browser: browser.name, handle: null, state: "opening", detail: `Abriendo ${browser.name}…`, started_at: now(), startedMs: Date.now(), seenAt: 0, timer: null };
  const c = current;
  changed();
  c.fresh = !fs.existsSync(path.join(profileDir(browser), "Local State"));
  try {
    await openWindow(c);
  } catch (error) {
    setState("failed", error.message);
    throw error;
  }
  return view();
}

/** Starts the window for c's site, follows its exit and polls its cookies. */
async function openWindow(c) {
  const site = siteById(c.site);
  const browser = findBrowser();
  if (!browser) throw noBrowser();
  c.launchedMs = Date.now();
  noSessionRestore(browser);
  c.handle = await launch(browser, ["--new-window", "about:blank"]);
  c.handle.proc.on("exit", () => { onExit(c).catch(() => {}); });
  const handle = c.handle;
  await onlyTab(handle.ws, site.url).catch(() => {});
  // closed or replaced while the tab was being opened (cancel, or a relaunch that took over): nothing more to follow here
  if (c.closing || current !== c || c.handle !== handle || !alive(handle.proc)) return;
  setState("waiting", `Inicia sesión en ${site.label} en la ventana de ${browser.name} que se ha abierto en este equipo. Se guardará y se cerrará sola.`);
  stopTimer();
  c.timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS());
}

/**
 * One tab, the site's sign-in page, in front: a browser may restore the tabs of the last window or open its start page, so the page is
 * opened through DevTools and every other tab is closed.
 */
async function onlyTab(ws, url) {
  await sleep(600);
  return withCdp(ws, async (c) => {
    const before = ((await c.send("Target.getTargets")).targetInfos || []).filter((t) => t.type === "page");
    const { targetId } = await c.send("Target.createTarget", { url });
    for (const t of before) await c.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    await c.send("Target.activateTarget", { targetId }).catch(() => {});
  });
}

/** Links' profile starts on a new tab instead of restoring the last session (session.restore_on_startup = 5). */
function noSessionRestore(browser) {
  const file = path.join(profileDir(browser), "Default", "Preferences");
  try {
    const prefs = JSON.parse(fs.readFileSync(file, "utf8"));
    if (prefs?.session?.restore_on_startup === 5) return;
    prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch { /* a new profile has no preferences yet */ }
}

/** "Ya he terminado": reads the session now and closes the window. */
export async function finishLogin() {
  const c = current;
  if (!c?.handle || !alive(c.handle.proc)) {
    if (c && ["capturing"].includes(c.state)) return view();
    const status = await capture(null);
    return { ...view(), sites: sitesView(status) };
  }
  stopTimer();
  c.closing = true;
  const status = await capture(c.handle.ws);
  const ok = status.sites?.[c.site]?.logged_in;
  await closeBrowser(c.handle);
  setState(ok ? "saved" : "closed", ok ? `Sesión de ${siteById(c.site).label} guardada.` : `No veo una sesión iniciada en ${siteById(c.site).label}; cerré la ventana.`);
  return view();
}

/** Closes the window without waiting (what it has is still read and kept). */
export async function cancelLogin() {
  const c = current;
  if (!c?.handle || !alive(c.handle.proc)) { stopTimer(); if (c) c.closing = true; current = null; changed(); return view(); }
  stopTimer();
  c.closing = true;
  try { saveCookies(await readCookies(c.handle.ws)); } catch { /* closing anyway */ }
  await closeBrowser(c.handle);
  setState("closed", "Ventana cerrada.");
  return view();
}

/** Signs Links out of a site: deletes its cookies from the profile and the file. */
export async function logout(id) {
  const site = siteById(id);
  if (!site) throw new SessionError(`No conozco el sitio «${id}».`, { status: 404, code: "UNKNOWN_SITE" });
  const live = current?.handle && alive(current.handle.proc) ? current.handle.ws : null;
  if (live) {
    await deleteSiteCookies(live, site);
    saveCookies(await readCookies(live));
  } else {
    await withHeadless(async (ws) => { await deleteSiteCookies(ws, site); saveCookies(await readCookies(ws)); });
  }
  return list();
}

function sitesView(status = readStatus()) {
  return SITES.map((s) => {
    const st = status.sites?.[s.id] || {};
    return { id: s.id, label: s.label, logged_in: !!st.logged_in, since: st.since || null, captured_at: st.captured_at || null, cookies: st.cookies || 0 };
  });
}

/** The login window, if any: { site, label, state, detail, browser, started_at }. */
export function view() {
  if (!current) return { active: null };
  const site = siteById(current.site);
  const open = !!(current.handle && alive(current.handle.proc));
  return { active: { site: current.site, label: site?.label || current.site, state: current.state, detail: current.detail, browser: current.browser, open, started_at: current.started_at, updated_at: current.updated_at || current.started_at } };
}

/** Everything the settings page and the tools show: the browser found, each site's state and the open window. */
export function list() {
  const browser = findBrowser();
  const def = defaultBrowser();
  return {
    browser: browser ? { name: browser.name, path: browser.path } : null,
    choice: choiceSetting(),
    browsers: installedBrowsers().map((b) => ({ name: b.name, default: b.default })),
    default_browser: def ? { name: def.name, usable: def.usable } : null,
    sites: sitesView(), ...view(), cookies_file: fs.existsSync(cookiesPath()) ? cookiesPath() : null,
  };
}

/** Closes the login window when the app stops. */
export async function shutdown() {
  stopTimer();
  if (current?.handle && alive(current.handle.proc)) { current.closing = true; await closeBrowser(current.handle); }
}

/** For tests: forget the window. */
export function _reset() { stopTimer(); current = null; listeners.clear(); }
