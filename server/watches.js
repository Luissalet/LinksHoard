// Watches: the read-later library that also *brings* things in.
//
// A watch is a URL checked on a schedule: an RSS/Atom feed, a GitHub
// repository (its releases or commits feed) or a plain page (a text diff).
// Each new feed entry, release or page change becomes a watch item, and —
// when the watch says so — a saved link (fetched like any other), plus an
// event on the family bus (`links.watch.new`, `links.watch.changed`) so a
// hub rule or the assistant can react. Nothing here needs a token: feeds
// and pages are public, and the assistant only sees what the tools return.
import { z } from "zod";
import { db, uid, now, transaction } from "./db.js";
import { extractHtml } from "./extract.js";
import { createLink } from "./links.js";
import { enqueueFetch } from "./fetcher.js";
import { isValidUrl } from "./url.js";
import { fetchForWatch } from "./net-policy.js";
import { parseFeed, discoverFeeds, githubFeed, checkPage, checkFeed, htmlToText } from "./hoard-commons/web.js";
import * as family from "./hoard-link.js";

const KINDS = ["feed", "github", "page"];
export const DEFAULT_EVERY_MIN = 60;

// Feeds (RSS 2.0, RSS 1.0 and Atom), GitHub repository feeds, feed discovery, the page comparison (volatile lines such as clocks and
// "5 minutes ago" ignored, Cloudflare/login/CAPTCHA pages never counted as a change) and the fetching itself are the shared ones in
// ./hoard-commons/web.js; what stays here is Links' own: the watches table, the items, the saved links and the events.

/** A feed item of the shared parser in the shape the watch_items table keeps. */
const toItem = (it) => ({ guid: it.key || it.id, url: it.link || "", title: it.title || "", summary: (it.summary || "").slice(0, 500), published_at: it.date || null });

/** Feed text -> { title, items: [{guid, url, title, summary, published_at}] } or null when it is not a feed. */
function readFeed(text, baseUrl) {
  const feed = parseFeed(text, baseUrl);
  return feed ? { title: feed.title || "", items: feed.items.map(toItem) } : null;
}

/** The first RSS/Atom feed a page advertises (JSON Feed is not read). */
const discoverFeed = (html, baseUrl) => discoverFeeds(html, baseUrl).find((f) => f.kind !== "json")?.url || null;

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

/** A fetch result that did not work, as the error the person reads. */
const fetchFailure = (r) => new Error(r.error || (r.status ? `HTTP ${r.status}` : "No hay respuesta."));

/** Fetch a URL for a watch; resolves the answer or throws the reason. */
async function fetchOrThrow(url, options) {
  const got = await fetchForWatch(url, options);
  if (!got.ok) throw fetchFailure(got);
  return { ...got, url: got.final_url || url };
}

/** Decide what a URL is (feed, GitHub repo, page) — fetching it once when needed. */
export async function resolveKind(url, kind = "auto", github = "releases") {
  if (kind === "github" || (kind === "auto" && githubFeed(url))) {
    const gh = githubFeed(url, github);
    if (!gh) throw Object.assign(new Error("No es una URL de repositorio de GitHub."), { status: 400 });
    return { kind: "github", url: gh.url, name: gh.name };
  }
  if (kind === "feed") return { kind: "feed", url, name: "" };
  if (kind === "page") return { kind: "page", url, name: "" };
  // auto: fetch once and look
  const got = await fetchOrThrow(url);
  const feed = readFeed(got.text, got.url);
  if (feed) return { kind: "feed", url: got.url, name: feed.title || "", prefetched: got };
  const discovered = discoverFeed(got.text, got.url);
  if (discovered) {
    const f = await fetchOrThrow(discovered).catch(() => null);
    const parsed = f && readFeed(f.text, f.url);
    if (parsed) return { kind: "feed", url: f.url, name: parsed.title || "", prefetched: f };
  }
  return { kind: "page", url: got.url, name: htmlToText(got.text).title || extractHtml(got.text, got.url).title || "", prefetched: got };
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

const STATE_COLUMNS = "last_hash, last_text, last_etag, last_modified, check_engine";

/** Check one watch now. Returns what was new. */
export async function checkWatch(id, { baseline = false, prefetched = null } = {}) {
  const watch = getWatch(id);
  if (!watch) throw Object.assign(new Error("No existe."), { status: 404 });
  const ts = now();
  const state = db().prepare(`SELECT ${STATE_COLUMNS} FROM watches WHERE id = ?`).get(id) || {};
  const fail = (message) => {
    db().prepare("UPDATE watches SET last_check_at = ?, last_error = ? WHERE id = ?").run(ts, message, id);
    return { watch: getWatch(id), ok: false, error: message, new_items: [] };
  };
  // a watch whose last comparison was made by the previous text extractor starts over silently (its first check is a new baseline)
  const legacy = state.check_engine !== 1 && !!state.last_hash;
  const sameEngine = !legacy;
  const got = prefetched || await fetchForWatch(watch.url, sameEngine && !baseline ? { etag: state.last_etag || "", lastModified: state.last_modified || "" } : {})
    .catch((error) => ({ ok: false, error: error.message || String(error) }));
  const newItems = [];
  let outcome = null;
  try {
    transaction(() => {
      if (watch.kind === "page") {
        const prev = sameEngine ? { hash: state.last_hash, text: state.last_text, etag: state.last_etag, lastModified: state.last_modified } : null;
        const [finding, next] = checkPage(got, prev);
        if (next.error) { outcome = fail(next.error); return; }
        if (!got.not_modified) {
          if (finding && !baseline) {
            recordItem(watch, {
              guid: `change:${next.hash}`, url: watch.url, title: `${watch.name || watch.url}: ${finding.added.length} + / ${finding.removed.length} −`,
              summary: finding.summary, published_at: ts,
            }, { baseline, links: newItems });
            family.emit("links.watch.changed", { watch: watch.id, name: watch.name, url: watch.url, added: finding.added.length, removed: finding.removed.length });
          }
          db().prepare("UPDATE watches SET last_hash = ?, last_text = ?, last_etag = ?, last_modified = ?, check_engine = 1 WHERE id = ?")
            .run(next.hash, next.text, next.etag || "", next.lastModified || "", id);
        }
      } else {
        if (!got.ok) { outcome = fail(got.error || (got.status ? `HTTP ${got.status}` : "No hay respuesta.")); return; }
        if (!got.not_modified) {
          const feed = readFeed(got.text, got.final_url || got.url || watch.url);
          if (!feed) { outcome = fail("No parece un feed RSS/Atom."); return; }
          const known = db().prepare("SELECT guid FROM watch_items WHERE watch_id = ?").all(id).map((r) => r.guid);
          // the first check records what is there as already seen; later checks report what is new (at most 20 per check: the rest is
          // still unknown and arrives on the next one)
          const seen = new Set(known);
          const fresh = baseline ? feed.items.filter((it) => !seen.has(it.guid))
            : checkFeed(feed.items.map((it) => ({ ...it, id: it.guid })), known)[0];
          for (const item of fresh.slice().reverse()) recordItem(watch, item, { baseline, links: newItems });
          if (!watch.name && feed.title) db().prepare("UPDATE watches SET name = ? WHERE id = ?").run(feed.title, id);
        }
        db().prepare("UPDATE watches SET last_etag = ?, last_modified = ?, check_engine = 1 WHERE id = ?")
          .run(got.not_modified ? state.last_etag || "" : got.etag || "", got.not_modified ? state.last_modified || "" : got.last_modified || "", id);
      }
      db().prepare("UPDATE watches SET last_check_at = ?, last_ok_at = ?, last_error = '', item_count = (SELECT COUNT(*) FROM watch_items WHERE watch_id = ?) WHERE id = ?").run(ts, ts, id, id);
    });
  } catch (error) {
    return fail(error.message || String(error));
  }
  return outcome || { watch: getWatch(id), ok: true, new_items: newItems, baseline };
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
