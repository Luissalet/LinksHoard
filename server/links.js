// Links store: CRUD, state filters, tags/sites facets, digest and search
// (FTS5 when available, LIKE fallback otherwise — see db.js ftsEnabled()).
import { z } from "zod";
import { db, uid, now, transaction, ftsEnabled, isOpen } from "./db.js";
import { normalizeUrl, siteOf } from "./url.js";

export const KINDS = ["article", "video", "pdf", "image", "other"];
export const SOURCES = ["manual", "agent", "share", "bookmarklet", "import", "watch"];

const tagsField = z.array(z.string().trim().min(1).max(40)).max(50);

export const createInput = z.object({
  url: z.string().trim().min(1),
  tags: tagsField.default([]),
  note: z.string().trim().max(5000).default(""),
  source: z.enum(SOURCES).default("manual"),
});

export const patchInput = z.object({
  title: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(20000).optional(),
  tags: tagsField.optional(),
  archived: z.boolean().optional(),
  favorite: z.boolean().optional(),
}).strict();

const row = (r) => (r ? { ...r, archived: !!r.archived, favorite: !!r.favorite, tags: JSON.parse(r.tags || "[]") } : null);

export function getLink(id) {
  return row(db().prepare("SELECT * FROM links WHERE id = ?").get(id));
}

export function getLinkByUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  return row(db().prepare("SELECT * FROM links WHERE url = ?").get(normalized));
}

function syncFts(link) {
  if (!ftsEnabled()) return;
  db().prepare("DELETE FROM links_fts WHERE link_id = ?").run(link.id);
  db().prepare(
    "INSERT INTO links_fts (title, description, content_text, notes, tags, link_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(link.title, link.description, link.content_text, link.notes, (link.tags || []).join(" "), link.id);
}

/** Save a URL immediately (fetch_status pending); idempotent on the normalized URL. */
export function createLink(input) {
  const data = createInput.parse(input);
  const normalized = normalizeUrl(data.url);
  if (!normalized) throw Object.assign(new Error("URL no válida."), { status: 400 });
  const existing = db().prepare("SELECT id FROM links WHERE url = ?").get(normalized);
  if (existing) return { link: getLink(existing.id), existing: true };
  const id = uid();
  const ts = now();
  db().prepare(
    `INSERT INTO links (id, url, url_original, title, site, description, content_text, excerpt, byline, lang,
       word_count, kind, saved_at, read_at, archived, favorite, tags, notes, source, fetch_status, fetch_error, fetched_at)
     VALUES (?, ?, ?, '', ?, '', '', '', '', '', 0, 'other', ?, NULL, 0, 0, ?, ?, ?, 'pending', '', NULL)`,
  ).run(id, normalized, data.url, siteOf(normalized), ts, JSON.stringify(data.tags), data.note, data.source);
  const link = getLink(id);
  syncFts(link);
  return { link, existing: false };
}

/** Write the outcome of a background fetch (see fetcher.js). Silently no-ops
 * if the link was deleted meanwhile, or if the app is shutting down and the
 * database has already been closed (a fetch can still be in flight then). */
export function applyFetchResult(id, patch) {
  if (!isOpen()) return null;
  const current = getLink(id);
  if (!current) return null;
  const next = { ...current, ...patch, fetched_at: now() };
  db().prepare(
    `UPDATE links SET title = ?, description = ?, content_text = ?, excerpt = ?, byline = ?, lang = ?,
       word_count = ?, kind = ?, fetch_status = ?, fetch_error = ?, fetched_at = ? WHERE id = ?`,
  ).run(next.title, next.description, next.content_text, next.excerpt, next.byline, next.lang,
    next.word_count, next.kind, next.fetch_status, next.fetch_error, next.fetched_at, id);
  const updated = getLink(id);
  syncFts(updated);
  return updated;
}

export function updateLink(id, patch) {
  const current = getLink(id);
  if (!current) return null;
  const data = patchInput.parse(patch);
  const next = { ...current, ...data };
  db().prepare(
    "UPDATE links SET title = ?, notes = ?, tags = ?, archived = ?, favorite = ? WHERE id = ?",
  ).run(next.title, next.notes, JSON.stringify(next.tags), next.archived ? 1 : 0, next.favorite ? 1 : 0, id);
  const updated = getLink(id);
  syncFts(updated);
  return updated;
}

export function deleteLink(id) {
  const existed = !!db().prepare("SELECT 1 FROM links WHERE id = ?").get(id);
  if (!existed) return false;
  transaction(() => {
    db().prepare("DELETE FROM highlights WHERE link_id = ?").run(id);
    db().prepare("DELETE FROM links WHERE id = ?").run(id);
    if (ftsEnabled()) db().prepare("DELETE FROM links_fts WHERE link_id = ?").run(id);
  });
  return true;
}

export function markRead(id, read) {
  const current = getLink(id);
  if (!current) return null;
  db().prepare("UPDATE links SET read_at = ? WHERE id = ?").run(read ? now() : null, id);
  return getLink(id);
}

export function setArchived(id, archived) {
  const current = getLink(id);
  if (!current) return null;
  db().prepare("UPDATE links SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
  return getLink(id);
}

export function setFavorite(id, favorite) {
  const current = getLink(id);
  if (!current) return null;
  db().prepare("UPDATE links SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id);
  return getLink(id);
}

export function markFetchPending(id) {
  db().prepare("UPDATE links SET fetch_status = 'pending', fetch_error = '' WHERE id = ?").run(id);
  return getLink(id);
}

export const listFilter = z.object({
  state: z.enum(["unread", "read", "archived", "all"]).default("unread"),
  tag: z.string().trim().max(40).optional(),
  site: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().min(0).default(0),
});

function stateClause(state) {
  if (state === "unread") return "archived = 0 AND read_at IS NULL";
  if (state === "read") return "archived = 0 AND read_at IS NOT NULL";
  if (state === "archived") return "archived = 1";
  return "1 = 1";
}

/** FTS5 MATCH when available; otherwise LIKE across the same fields. */
function searchIds(q) {
  if (!ftsEnabled()) {
    const like = `%${q}%`;
    return db().prepare(
      "SELECT id FROM links WHERE title LIKE ? OR description LIKE ? OR content_text LIKE ? OR notes LIKE ? OR tags LIKE ?",
    ).all(like, like, like, like, like).map((r) => r.id);
  }
  const escaped = q.replace(/"/g, '""');
  return db().prepare(`SELECT link_id AS id FROM links_fts WHERE links_fts MATCH ? ORDER BY rank`)
    .all(`"${escaped}"`).map((r) => r.id);
}

export function listLinks(query = {}) {
  const f = listFilter.parse(query);
  const clauses = [stateClause(f.state)];
  const params = [];
  if (f.tag) { clauses.push("tags LIKE ?"); params.push(`%"${f.tag}"%`); }
  if (f.site) { clauses.push("site = ?"); params.push(f.site); }
  let idFilter = null;
  if (f.q) idFilter = new Set(searchIds(f.q));
  if (idFilter) {
    if (idFilter.size === 0) return { total: 0, items: [], nextCursor: null, ftsEnabled: ftsEnabled() };
    clauses.push(`id IN (${[...idFilter].map(() => "?").join(",")})`);
    params.push(...idFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db().prepare(`SELECT COUNT(*) AS n FROM links ${where}`).get(...params).n;
  const items = db()
    .prepare(`SELECT * FROM links ${where} ORDER BY saved_at DESC LIMIT ? OFFSET ?`)
    .all(...params, f.limit, f.cursor)
    .map(row);
  return { total, items, nextCursor: f.cursor + f.limit < total ? f.cursor + f.limit : null, ftsEnabled: ftsEnabled() };
}

export function listTags() {
  const rows = db().prepare("SELECT tags FROM links WHERE archived = 0").all();
  const counts = new Map();
  for (const r of rows) {
    for (const tag of JSON.parse(r.tags || "[]")) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

export function listSites() {
  return db().prepare("SELECT site, COUNT(*) AS count FROM links WHERE site != '' GROUP BY site ORDER BY count DESC").all();
}

/** Links saved since a date (inclusive), with excerpts, grouped by site — used by the digest endpoint/tool. */
export function digestSince(since) {
  const items = db().prepare("SELECT * FROM links WHERE saved_at >= ? ORDER BY saved_at DESC").all(since).map(row);
  const bySite = new Map();
  for (const link of items) {
    const list = bySite.get(link.site) || [];
    list.push(link);
    bySite.set(link.site, list);
  }
  return {
    since,
    total: items.length,
    sites: [...bySite.entries()].map(([site, links]) => ({ site, count: links.length, links })),
  };
}

export function stats() {
  const r = db().prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN archived = 0 AND read_at IS NULL THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read, SUM(archived) AS archived, SUM(favorite) AS favorite FROM links",
  ).get();
  return { total: r.total, unread: r.unread || 0, read: r.read || 0, archived: r.archived || 0, favorite: r.favorite || 0 };
}
