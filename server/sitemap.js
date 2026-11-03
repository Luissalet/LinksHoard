// Site mapping: discover the URLs of a site (or a section of it) from robots.txt, sitemap.xml / sitemap indexes (gzip too) and the
// same-host links of the start page. Pure discovery, nothing is saved here; sitecrawl.js saves pages. Network goes through the shared
// webGet of hoard-commons (address policy on every hop, body cap), robots rules through its RobotsRules.
import zlib from "node:zlib";
import { parseHTML } from "linkedom";
import { webGet, RobotsRules } from "./hoard-commons/web.js";
import { fetchProfile, USER_AGENT } from "./net-policy.js";
import { normalizeUrl } from "./url.js";
import { getLinkByUrl } from "./links.js";

export const ROBOTS_AGENT = "LinksHoard";
const MAX_SITEMAPS = 25;
const MAX_SITEMAP_DEPTH = 3;
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|zip|gz|tgz|tar|7z|rar|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|eot|exe|dmg|msi|iso|apk)$/i;

const hostKey = (host) => String(host || "").toLowerCase().replace(/^www\./, "");
export const sameHost = (a, b) => { try { return hostKey(new URL(a).host) === hostKey(new URL(b).host); } catch { return false; } };

/** A glob over the path (and query) of a URL: ** crosses "/", * stays inside a segment, ? is one character. A pattern with "://" matches the whole URL; one that does not start with "/" or "*" may match anywhere in the path. */
export function globToRegex(glob) {
  let g = String(glob).trim();
  if (!g.includes("://") && !g.startsWith("/") && !g.startsWith("**")) g = "**/" + g;
  let rx = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") { rx += ".*"; i++; } else rx += "[^/]*";
    } else if (ch === "?") rx += "[^/]";
    else rx += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { whole: g.includes("://"), re: new RegExp("^" + rx + "$", "i") };
}

/** Build the URL filter: include / exclude globs and a path prefix. Returns (url) => boolean. */
export function makeFilter({ include = [], exclude = [], path_prefix = "" } = {}) {
  const inc = include.filter(Boolean).map(globToRegex);
  const exc = exclude.filter(Boolean).map(globToRegex);
  const prefix = path_prefix ? (path_prefix.startsWith("/") ? path_prefix : "/" + path_prefix) : "";
  const hit = (list, u) => list.some((g) => g.re.test(g.whole ? u.href : u.pathname + u.search));
  return (url) => {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (prefix && !u.pathname.startsWith(prefix)) return false;
    if (inc.length && !hit(inc, u)) return false;
    if (exc.length && hit(exc, u)) return false;
    return true;
  };
}

/** The section a start URL points at: its directory ("/3/howto/" stays, "/docs/intro.html" becomes "/docs/"); "" for a site root. */
export function defaultPrefix(startUrl) {
  const p = new URL(startUrl).pathname;
  if (p === "/" || p === "") return "";
  return p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
}

const decodeXml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** { index: bool, locs: [url] } from sitemap XML text. */
export function parseSitemapXml(xml) {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (let m; (m = re.exec(xml));) locs.push(decodeXml(m[1].trim()));
  return { index, locs };
}

async function getBytes(url, { maxBytes = 5 * 1024 * 1024, timeoutMs = 12_000 } = {}) {
  return webGet(url, { profile: fetchProfile(), accept: "any", timeoutMs, maxBytes, userAgent: USER_AGENT, retries: 0 });
}

/** Text of a sitemap body, gunzipping it when it is a .gz file (served with or without Content-Encoding). */
export function sitemapText(r, url) {
  const body = r.body;
  if (body && body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try { return zlib.gunzipSync(body, { maxOutputLength: 50 * 1024 * 1024 }).toString("utf8"); } catch { return ""; }
  }
  return r.text || (body ? body.toString("utf8") : "");
}

/** robots.txt of an origin: { found, rules, text, sitemaps, crawlDelay }. Never throws. */
export async function loadRobots(origin) {
  const r = await getBytes(`${origin}/robots.txt`, { maxBytes: 512 * 1024, timeoutMs: 8000 }).catch(() => null);
  if (!r || r.status !== 200 || !r.text) return { found: false, rules: null, sitemaps: [], crawlDelay: null };
  const rules = new RobotsRules(r.text);
  return { found: true, rules, sitemaps: rules.sitemaps, crawlDelay: rules.crawlDelay(ROBOTS_AGENT) };
}

export const robotsAllows = (robots, url) => {
  if (!robots?.rules) return true;
  try { const u = new URL(url); return robots.rules.allowed(ROBOTS_AGENT, u.pathname + u.search); } catch { return false; }
};

/** Same-host page links of an HTML document: [{ url, title }] (normalized, de-duplicated, without obvious assets). */
export function pageLinks(html, baseUrl) {
  const out = new Map();
  let document;
  try { ({ document } = parseHTML(html)); } catch { return []; }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    const url = normalizeUrl(abs);
    if (!url || !sameHost(url, baseUrl) || SKIP_EXT.test(new URL(url).pathname)) continue;
    const title = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!out.has(url) || (!out.get(url).title && title)) out.set(url, { url, title });
  }
  return [...out.values()];
}

/** Collect URLs from sitemaps (index files followed up to a depth, at most MAX_SITEMAPS fetched). */
async function readSitemaps(seeds, { host, wanted }) {
  const urls = [];
  const used = [];
  const seen = new Set();
  const queue = seeds.map((u) => ({ url: u, depth: 0 }));
  while (queue.length && used.length < MAX_SITEMAPS && urls.length < wanted * 4) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await getBytes(url, { maxBytes: 10 * 1024 * 1024 }).catch(() => null);
    if (!r || !(r.status >= 200 && r.status < 300)) continue;
    const text = sitemapText(r, url);
    if (!/<(?:urlset|sitemapindex)[\s>]/i.test(text)) continue;
    const parsed = parseSitemapXml(text);
    used.push({ url, kind: parsed.index ? "index" : "urlset", entries: parsed.locs.length });
    if (parsed.index) {
      if (depth < MAX_SITEMAP_DEPTH) for (const loc of parsed.locs) queue.push({ url: loc, depth: depth + 1 });
    } else {
      for (const loc of parsed.locs) if (sameHost(loc, host)) urls.push(loc);
    }
  }
  return { urls, used };
}

/**
 * Discover the URLs of a site or section. Options: url (start page), include / exclude (globs), path_prefix ("" = the section of the
 * start URL, "/" = the whole site), limit (default 200, max 5000), sitemaps (default true), links (follow the start page's links, default true).
 * Returns { start_url, host, path_prefix, robots, sitemaps, sources, total, truncated, blocked_by_robots, urls: [{ url, title, source, saved }] }.
 */
export async function mapSite(opts = {}) {
  const start = normalizeUrl(opts.url);
  if (!start) throw Object.assign(new Error("URL no válida."), { status: 400 });
  const startUrl = new URL(start);
  const origin = startUrl.origin;
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 5000);
  // the section is the folder of the URL as typed ("…/howto/" keeps its slash; the normalized form drops it)
  let typed = start;
  try { typed = new URL(String(opts.url).trim()).href; } catch { /* keep normalized */ }
  const prefix = opts.path_prefix === undefined || opts.path_prefix === null ? defaultPrefix(typed) : (opts.path_prefix === "/" ? "" : opts.path_prefix);
  const filter = makeFilter({ include: opts.include || [], exclude: opts.exclude || [], path_prefix: prefix });

  const robots = await loadRobots(origin);
  const found = new Map(); // url -> { url, title, source }
  const add = (url, source, title = "") => {
    const n = normalizeUrl(url);
    if (!n || !sameHost(n, start) || SKIP_EXT.test(new URL(n).pathname)) return;
    const prev = found.get(n);
    if (prev) { if (!prev.title && title) prev.title = title; return; }
    found.set(n, { url: n, title, source });
  };

  let sitemapsUsed = [];
  if (opts.sitemaps !== false) {
    const seeds = [...new Set([...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])];
    const read = await readSitemaps(seeds, { host: start, wanted: limit });
    sitemapsUsed = read.used;
    for (const u of read.urls) add(u, "sitemap");
  }
  if (opts.links !== false) {
    const page = await getBytes(start, { maxBytes: 3 * 1024 * 1024, timeoutMs: 15_000 }).catch(() => null);
    if (page?.ok && page.text && /html|xml|^$/i.test(page.contentType || "")) {
      for (const l of pageLinks(page.text, page.finalUrl || start)) add(l.url, "link", l.title);
    }
  }
  add(start, "start");

  let blocked = 0;
  const urls = [];
  for (const entry of found.values()) {
    if (entry.url !== start && !filter(entry.url)) continue; // the page the person pointed at is always part of the map
    if (!robotsAllows(robots, entry.url)) { blocked++; continue; }
    const saved = !!getLinkByUrl(entry.url);
    urls.push({ ...entry, saved });
  }
  urls.sort((a, b) => (a.source === "start" ? -1 : b.source === "start" ? 1 : a.url.localeCompare(b.url)));
  const sources = { sitemap: 0, link: 0, start: 0 };
  for (const u of urls) sources[u.source]++;
  return {
    start_url: start,
    host: hostKey(startUrl.host),
    path_prefix: prefix || "/",
    robots: { found: robots.found, crawl_delay: robots.crawlDelay, sitemaps: robots.sitemaps },
    sitemaps: sitemapsUsed,
    sources,
    total: urls.length,
    truncated: urls.length > limit,
    blocked_by_robots: blocked,
    urls: urls.slice(0, limit),
  };
}
