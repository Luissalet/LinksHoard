// Watches: the read-later library that also *brings* things in.
//
// A watch is a URL checked on a schedule: an RSS/Atom feed, a GitHub
// repository (its releases or commits feed) or a plain page (a text diff).
// Each new feed entry, release or page change becomes a watch item, and —
// when the watch says so — a saved link (fetched like any other), plus an
// event on the family bus (`links.watch.new`, `links.watch.changed`) so a
// hub rule or the assistant can react. Nothing here needs a token: feeds
// and pages are public, and the assistant only sees what the tools return.
import crypto from "node:crypto";
import { z } from "zod";
import { db, uid, now, transaction } from "./db.js";
import { extractHtml } from "./extract.js";
import { createLink } from "./links.js";
import { enqueueFetch } from "./fetcher.js";
import { isValidUrl } from "./url.js";
import * as family from "./hoard-link.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LinksHoard/1.0";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS_PER_CHECK = 50;
const KINDS = ["feed", "github", "page"];
export const DEFAULT_EVERY_MIN = 60;


// ---------------------------------------------------------------------------
// parsing feeds (RSS 2.0 and Atom, the common shapes) without an XML library
// ---------------------------------------------------------------------------

const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const strip = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function attr(block, name, attrName) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "gi");
  let m; const out = [];
  while ((m = re.exec(block))) out.push({ value: m[1], tag: m[0] });
  return out;
}

/** Feed text → {title, items: [{guid, url, title, summary, published_at}]} or null when it is not a feed. */
export function parseFeed(text, baseUrl = "") {
  const xml = String(text || "");
  const head = xml.slice(0, 4000);
  const isAtom = /<feed[\s>]/i.test(head) && /xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(head) || (/<feed[\s>]/i.test(head) && /<entry[\s>]/i.test(xml));
  const isRss = /<rss[\s>]|<rdf:RDF[\s>]|<channel[\s>]/i.test(head);
  if (!isAtom && !isRss) return null;
  const items = [];
  if (isAtom) {
    const feedTitle = strip(tag(xml.split(/<entry[\s>]/i)[0], "title"));
    for (const block of xml.split(/<entry[\s>]/i).slice(1)) {
      const links = attr(block, "link", "href");
      const alt = links.find((l) => !/rel=["'](?!alternate)/i.test(l.tag)) || links[0];
      const url = resolveUrl(alt ? decode(alt.value) : "", baseUrl);
      const title = strip(tag(block, "title"));
      const guid = strip(tag(block, "id")) || url || title;
      const summary = strip(tag(block, "summary") || tag(block, "content")).slice(0, 500);
      const published = strip(tag(block, "published") || tag(block, "updated")) || null;
      if (guid) items.push({ guid, url, title, summary, published_at: published });
    }
    return { title: feedTitle, items: items.slice(0, MAX_ITEMS_PER_CHECK) };
  }
  const feedTitle = strip(tag(xml.split(/<item[\s>]/i)[0], "title"));
  for (const block of xml.split(/<item[\s>]/i).slice(1)) {
    const url = resolveUrl(strip(tag(block, "link")) || (attr(block, "link", "href")[0]?.value ?? ""), baseUrl);
    const title = strip(tag(block, "title"));
    const guid = strip(tag(block, "guid")) || url || title;
    const summary = strip(tag(block, "description") || tag(block, "content:encoded")).slice(0, 500);
    const published = strip(tag(block, "pubDate") || tag(block, "dc:date")) || null;
    if (guid) items.push({ guid, url, title, summary, published_at: toIso(published) });
  }
  return { title: feedTitle, items: items.slice(0, MAX_ITEMS_PER_CHECK) };
}

function toIso(text) {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}
function resolveUrl(href, base) {
  if (!href) return "";
  try { return new URL(href, base || undefined).toString(); } catch { return href; }
}

/** `<link rel="alternate" type="application/rss+xml" href=…>` in an HTML page. */
export function discoverFeed(html, baseUrl) {
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (/type=["']application\/(rss|atom)\+xml["']/i.test(t)) {
      const href = t.match(/href=["']([^"']+)["']/i);
      if (href) return resolveUrl(decode(href[1]), baseUrl);
    }
  }
  return null;
}

/** GitHub repository URL → the feed that tracks it. */
export function githubFeed(url, what = "releases") {
  const m = String(url).match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  const kind = /\/commits/i.test(url) || what === "commits" ? "commits" : (/\/tags/i.test(url) || what === "tags" ? "tags" : "releases");
  return { repo, url: `https://github.com/${repo}/${kind}.atom`, what: kind };
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader?.();
  if (!reader) return { text: await response.text(), url: response.url || url, contentType: response.headers.get("content-type") || "" };
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), url: response.url || url, contentType: response.headers.get("content-type") || "" };
}

const hashOf = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** A short, readable summary of what changed between two texts (line based). */
export function diffSummary(before, after, max = 6) {
  const a = new Set(String(before || "").split(/\n+/).map((l) => l.trim()).filter(Boolean));
  const b = String(after || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const added = []; const seen = new Set();
  for (const line of b) { if (!a.has(line) && !seen.has(line)) { added.push(line); seen.add(line); } }
  const bset = new Set(b);
  const removed = [...a].filter((l) => !bset.has(l));
  const parts = [];
  if (added.length) parts.push("+ " + added.slice(0, max).map((l) => l.slice(0, 160)).join(" | ") + (added.length > max ? ` (+${added.length - max})` : ""));
  if (removed.length) parts.push("− " + removed.slice(0, Math.max(1, max - added.length)).map((l) => l.slice(0, 120)).join(" | ") + (removed.length > max ? ` (+${removed.length - max})` : ""));
  return { added: added.length, removed: removed.length, summary: parts.join("  ") };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const rowToWatch = (r) => r && ({
  id: r.id, kind: r.kind, url: r.url, source_url: r.source_url, name: r.name, every_min: r.every_min,
  tags: JSON.parse(r.tags || "[]"), auto_save: !!r.auto_save, enabled: !!r.enabled, created_at: r.created_at,
  last_check_at: r.last_check_at, last_ok_at: r.last_ok_at, last_error: r.last_error, item_count: r.item_count,
});
const rowToItem = (r) => r && ({
  id: r.id, watch_id: r.watch_id, guid: r.guid, url: r.url, title: r.title, summary: r.summary, published_at: r.published_at,
  seen_at: r.seen_at, link_id: r.link_id, dismissed: !!r.dismissed,
});

const addInput = z.object({
  url: z.string().trim().min(1),
  kind: z.enum(["auto", ...KINDS]).default("auto"),
  name: z.string().trim().max(200).default(""),
  every_min: z.number().int().min(5).max(7 * 24 * 60).default(DEFAULT_EVERY_MIN),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  auto_save: z.boolean().default(true),
  github: z.enum(["releases", "tags", "commits"]).default("releases"),
});

export function listWatches() {
  return db().prepare("SELECT * FROM watches ORDER BY created_at DESC").all().map(rowToWatch);
}
export function getWatch(id) {
  return rowToWatch(db().prepare("SELECT * FROM watches WHERE id = ?").get(id));
}
export function findWatchByUrl(sourceUrl) {
  return rowToWatch(db().prepare("SELECT * FROM watches WHERE source_url = ? OR url = ?").get(sourceUrl, sourceUrl));
}

/** Decide what a URL is (feed, GitHub repo, page) — fetching it once when needed. */
export async function resolveKind(url, kind = "auto", github = "releases") {
  if (kind === "github" || (kind === "auto" && githubFeed(url))) {
    const gh = githubFeed(url, github);
    if (!gh) throw Object.assign(new Error("No es una URL de repositorio de GitHub."), { status: 400 });
    return { kind: "github", url: gh.url, name: `${gh.repo} ${gh.what}` };
  }
  if (kind === "feed") return { kind: "feed", url, name: "" };
  if (kind === "page") return { kind: "page", url, name: "" };
  // auto: fetch once and look
  const got = await fetchText(url);
  const feed = parseFeed(got.text, got.url);
  if (feed) return { kind: "feed", url: got.url, name: feed.title || "", prefetched: got };
  const discovered = discoverFeed(got.text, got.url);
  if (discovered) {
    const f = await fetchText(discovered).catch(() => null);
    const parsed = f && parseFeed(f.text, f.url);
    if (parsed) return { kind: "feed", url: f.url, name: parsed.title || "", prefetched: f };
  }
  return { kind: "page", url: got.url, name: extractHtml(got.text, got.url).title || "", prefetched: got };
}

export async function addWatch(input) {
  const data = addInput.parse(input);
  if (!isValidUrl(data.url)) throw Object.assign(new Error("URL no válida."), { status: 400 });
  const existing = findWatchByUrl(data.url);
  if (existing) return { watch: existing, existing: true };
  const resolved = await resolveKind(data.url, data.kind, data.github);
  const dup = findWatchByUrl(resolved.url);
  if (dup) return { watch: dup, existing: true };
  const id = uid();
  db().prepare(
    `INSERT INTO watches (id, kind, url, source_url, name, every_min, tags, auto_save, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, resolved.kind, resolved.url, data.url, data.name || resolved.name || "", data.every_min, JSON.stringify(data.tags), data.auto_save ? 1 : 0, now());
  // First check right away: the current entries are the baseline (not "new").
  const check = await checkWatch(id, { baseline: true, prefetched: resolved.prefetched });
  return { watch: getWatch(id), existing: false, first_check: check };
}

export function updateWatch(id, patch) {
  const w = getWatch(id);
  if (!w) throw Object.assign(new Error("No existe."), { status: 404 });
  const p = z.object({
    name: z.string().trim().max(200).optional(), every_min: z.number().int().min(5).max(7 * 24 * 60).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(), auto_save: z.boolean().optional(), enabled: z.boolean().optional(),
  }).parse(patch);
  db().prepare("UPDATE watches SET name = ?, every_min = ?, tags = ?, auto_save = ?, enabled = ? WHERE id = ?").run(
    p.name ?? w.name, p.every_min ?? w.every_min, JSON.stringify(p.tags ?? w.tags), (p.auto_save ?? w.auto_save) ? 1 : 0, (p.enabled ?? w.enabled) ? 1 : 0, id,
  );
  return getWatch(id);
}

export function removeWatch(id) {
  const w = getWatch(id);
  if (!w) throw Object.assign(new Error("No existe."), { status: 404 });
  db().prepare("DELETE FROM watches WHERE id = ?").run(id);
  return w;
}

export function listItems({ watch_id = null, since = null, unread = false, limit = 50 } = {}) {
  const where = ["1=1"]; const params = [];
  if (watch_id) { where.push("watch_id = ?"); params.push(watch_id); }
  if (since) { where.push("seen_at >= ?"); params.push(since); }
  if (unread) where.push("dismissed = 0");
  const rows = db().prepare(`SELECT * FROM watch_items WHERE ${where.join(" AND ")} ORDER BY seen_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(limit, 500)));
  return rows.map(rowToItem);
}
export function dismissItem(id, dismissed = true) {
  const r = db().prepare("UPDATE watch_items SET dismissed = ? WHERE id = ?").run(dismissed ? 1 : 0, id);
  if (!r.changes) throw Object.assign(new Error("No existe."), { status: 404 });
  return rowToItem(db().prepare("SELECT * FROM watch_items WHERE id = ?").get(id));
}

function recordItem(watch, item, { baseline, links }) {
  const id = uid();
  const ts = now();
  let linkId = null;
  if (!baseline && watch.auto_save && item.url && isValidUrl(item.url)) {
    try {
      const { link, existing } = createLink({ url: item.url, tags: watch.tags, note: watch.name ? `Vía ${watch.name}` : "", source: "watch" });
      linkId = link.id;
      if (!existing) enqueueFetch(link.id, link.url);
    } catch { linkId = null; }
  }
  db().prepare(
    "INSERT OR IGNORE INTO watch_items (id, watch_id, guid, url, title, summary, published_at, seen_at, link_id, dismissed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, watch.id, item.guid, item.url || "", item.title || "", item.summary || "", item.published_at || null, ts, linkId, baseline ? 1 : 0);
  if (!baseline) {
    links.push({ id, title: item.title, url: item.url, link_id: linkId });
    family.emit("links.watch.new", { watch: watch.id, name: watch.name, kind: watch.kind, item_id: id, title: (item.title || "").slice(0, 200), url: item.url || "", link_id: linkId, saved: !!linkId });
  }
  return id;
}

/** Check one watch now. Returns what was new. */
export async function checkWatch(id, { baseline = false, prefetched = null } = {}) {
  const watch = getWatch(id);
  if (!watch) throw Object.assign(new Error("No existe."), { status: 404 });
  const ts = now();
  let got;
  try {
    got = prefetched || await fetchText(watch.url);
  } catch (error) {
    db().prepare("UPDATE watches SET last_check_at = ?, last_error = ? WHERE id = ?").run(ts, error.message || String(error), id);
    return { watch: getWatch(id), ok: false, error: error.message || String(error), new_items: [] };
  }
  const newItems = [];
  try {
    transaction(() => {
      if (watch.kind === "page") {
        const text = extractHtml(got.text, got.url).contentText || "";
        const hash = hashOf(text);
        const prevRow = db().prepare("SELECT last_hash, last_text FROM watches WHERE id = ?").get(id) || {};
        if (prevRow.last_hash && hash !== prevRow.last_hash) {
          const prev = prevRow.last_text || "";
          const d = diffSummary(prev, text);
          recordItem(watch, { guid: `change:${hash}`, url: watch.url, title: `${watch.name || watch.url}: ${d.added} + / ${d.removed} −`, summary: d.summary, published_at: ts }, { baseline, links: newItems });
          if (!baseline) family.emit("links.watch.changed", { watch: watch.id, name: watch.name, url: watch.url, added: d.added, removed: d.removed });
        }
        db().prepare("UPDATE watches SET last_hash = ?, last_text = ? WHERE id = ?").run(hash, text.slice(0, 200_000), id);
      } else {
        const feed = parseFeed(got.text, got.url);
        if (!feed) throw new Error("No parece un feed RSS/Atom.");
        const known = new Set(db().prepare("SELECT guid FROM watch_items WHERE watch_id = ?").all(id).map((r) => r.guid));
        for (const item of feed.items.slice().reverse()) {
          if (known.has(item.guid)) continue;
          recordItem(watch, item, { baseline, links: newItems });
        }
        if (!watch.name && feed.title) db().prepare("UPDATE watches SET name = ? WHERE id = ?").run(feed.title, id);
      }
      db().prepare("UPDATE watches SET last_check_at = ?, last_ok_at = ?, last_error = '', item_count = (SELECT COUNT(*) FROM watch_items WHERE watch_id = ?) WHERE id = ?").run(ts, ts, id, id);
    });
  } catch (error) {
    db().prepare("UPDATE watches SET last_check_at = ?, last_error = ? WHERE id = ?").run(ts, error.message || String(error), id);
    return { watch: getWatch(id), ok: false, error: error.message || String(error), new_items: [] };
  }
  return { watch: getWatch(id), ok: true, new_items: newItems, baseline };
}

/** Every enabled watch whose interval has passed. */
export function dueWatches(nowMs = Date.now()) {
  return listWatches().filter((w) => w.enabled && (!w.last_check_at || nowMs - Date.parse(w.last_check_at) >= w.every_min * 60_000));
}

export async function checkDue() {
  const out = [];
  for (const w of dueWatches()) out.push(await checkWatch(w.id).catch((e) => ({ watch: w, ok: false, error: e.message, new_items: [] })));
  return out;
}

let timer = null;
export function startScheduler(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => { checkDue().catch(() => {}); }, intervalMs);
  timer.unref?.();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function stats() {
  const w = db().prepare("SELECT COUNT(*) AS n, SUM(enabled) AS enabled FROM watches").get();
  const i = db().prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN dismissed = 0 THEN 1 ELSE 0 END) AS unread FROM watch_items").get();
  return { watches: w?.n || 0, enabled: w?.enabled || 0, items: i?.n || 0, unread: i?.unread || 0 };
}
