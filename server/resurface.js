// "Para leer hoy": saved links worth putting back in front of the user, plus the daily digest line.
//
// A candidate is a link that is not archived, was fetched and is not a download record:
//   - unread and at least 2 days old, or
//   - read at least 14 days ago and carrying highlights (something to re-read).
// Score: age (unread: days since saved, up to 120; read: half the days since reading, up to 60), favourites, highlights, and tags the
// user actually reads (how many read links share a tag). Never the same link twice in 14 days (30 for a re-read). The day's picks are
// stored, so the list is the same all day and tomorrow brings others.
import crypto from "node:crypto";
import { db, getSetting, setSetting } from "./db.js";
import * as family from "./hoard-link.js";
import { appLink } from "./public-url.js";

const DAY = 86_400_000;
export const MIN_UNREAD_AGE_DAYS = 2;
export const MIN_READ_AGE_DAYS = 14;
export const COOLDOWN_DAYS = 14;
export const COOLDOWN_REREAD_DAYS = 30;
export const DIGEST_HOUR = 8;
export const DEFAULT_COUNT = 3;

const TODAY_KEY = "resurface_today";
const DIGEST_DAY_KEY = "resurface_digest_day";

export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function resurfaceSettings() {
  const count = Number(getSetting("resurface_count", DEFAULT_COUNT));
  return { digest: getSetting("resurface_digest", true) !== false, count: Number.isInteger(count) && count >= 1 && count <= 10 ? count : DEFAULT_COUNT };
}

export function setResurfaceSettings(patch = {}) {
  if (patch.digest !== undefined) setSetting("resurface_digest", patch.digest !== false);
  if (patch.count !== undefined) {
    const n = Number(patch.count);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error("count debe ser un entero entre 1 y 10."), { status: 400 });
    setSetting("resurface_count", n);
  }
  return resurfaceSettings();
}

const days = (from, to) => Math.max(0, Math.floor((to - Date.parse(from)) / DAY));
const tiebreak = (day, id) => crypto.createHash("sha1").update(`${day}:${id}`).digest().readUInt16BE(0) / 65535;

/** Weight of a link's tags: how many read, non-archived links share them (capped). */
function tagAffinity(tags, readTags) {
  let n = 0;
  for (const t of tags) n += readTags.get(t) || 0;
  return Math.min(20, 4 * n);
}

export function candidates(at = new Date()) {
  const t = at.getTime();
  const day = localDay(at);
  const rows = db().prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM highlights h WHERE h.link_id = l.id) AS n_highlights
       FROM links l WHERE l.archived = 0 AND l.fetch_status = 'ok' AND l.source != 'download'`,
  ).all();
  const readTags = new Map();
  for (const r of rows) {
    if (!r.read_at) continue;
    for (const tag of JSON.parse(r.tags || "[]")) readTags.set(tag, (readTags.get(tag) || 0) + 1);
  }
  const out = [];
  for (const r of rows) {
    const tags = JSON.parse(r.tags || "[]");
    const sinceShown = r.resurfaced_at ? days(r.resurfaced_at, t) : Infinity;
    let score;
    let reason;
    if (!r.read_at) {
      const age = days(r.saved_at, t);
      if (age < MIN_UNREAD_AGE_DAYS || sinceShown < COOLDOWN_DAYS) continue;
      score = Math.min(age, 120) + (r.favorite ? 40 : 0) + r.n_highlights * 10 + tagAffinity(tags, readTags);
      reason = r.favorite ? `Favorito sin leer desde hace ${age} días` : age >= 1 ? `Sin leer desde hace ${age} días` : "Sin leer";
      if (r.n_highlights) reason += ` · ${r.n_highlights} subrayado${r.n_highlights === 1 ? "" : "s"}`;
    } else {
      const readAge = days(r.read_at, t);
      if (!r.n_highlights || readAge < MIN_READ_AGE_DAYS || sinceShown < COOLDOWN_REREAD_DAYS) continue;
      score = Math.min(readAge, 120) / 2 + (r.favorite ? 40 : 0) + r.n_highlights * 10 + tagAffinity(tags, readTags);
      reason = `Para releer: ${r.n_highlights} subrayado${r.n_highlights === 1 ? "" : "s"}, leído hace ${readAge} días`;
    }
    out.push({ link: r, score, reason, tie: tiebreak(day, r.id) });
  }
  return out.sort((a, b) => b.score - a.score || b.tie - a.tie || (a.link.id < b.link.id ? -1 : 1));
}

const present = (r, reason) => ({
  id: r.id, url: r.url, title: r.title, site: r.site, excerpt: r.excerpt, saved_at: r.saved_at, read_at: r.read_at,
  favorite: !!r.favorite, tags: JSON.parse(r.tags || "[]"), word_count: r.word_count, reason,
});

/**
 * Today's picks: `count` links, stable for the whole day. Ones read or archived since they were picked drop out; a bigger `count` than
 * before tops the list up. Returns {day, count, items, picked_now}.
 */
export function resurface(count = DEFAULT_COUNT, at = new Date()) {
  const want = Math.max(1, Math.min(10, Number(count) || DEFAULT_COUNT));
  const day = localDay(at);
  let stored = getSetting(TODAY_KEY, null);
  if (!stored || stored.day !== day) stored = { day, count: 0, ids: [], reasons: {} };
  const still = [];
  for (const id of stored.ids) {
    const r = db().prepare("SELECT * FROM links WHERE id = ?").get(id);
    if (!r || r.archived) continue;
    // an unread pick that has been read since is done for today; a re-read pick has read_at set from the start
    if (r.read_at && !stored.reread?.includes(id)) continue;
    still.push(r);
  }
  let picked = 0;
  if (want > stored.count) {
    const have = new Set(stored.ids);
    const need = want - stored.ids.length;
    const fresh = candidates(at).filter((c) => !have.has(c.link.id)).slice(0, Math.max(0, need));
    const stamp = at.toISOString();
    for (const c of fresh) {
      db().prepare("UPDATE links SET resurfaced_at = ? WHERE id = ?").run(stamp, c.link.id);
      stored.ids.push(c.link.id);
      stored.reasons[c.link.id] = c.reason;
      if (c.link.read_at) (stored.reread ||= []).push(c.link.id);
      still.push(c.link);
      picked++;
    }
    stored.count = want;
  }
  setSetting(TODAY_KEY, stored);
  const items = still.slice(0, want).map((r) => present(r, stored.reasons[r.id] || ""));
  return { day, count: want, total: items.length, items, picked_now: picked };
}

/**
 * The daily "Para leer hoy" line for the family digest: once per local day, from 08:00, only when there is something to read and the
 * hub took the event. Resolves the number of links announced (0 when it did nothing).
 */
export async function resurfaceDigest({ at = new Date(), force = false } = {}) {
  const settings = resurfaceSettings();
  if (!settings.digest && !force) return 0;
  const day = localDay(at);
  if (!force && (at.getHours() < DIGEST_HOUR || getSetting(DIGEST_DAY_KEY, "") === day)) return 0;
  const { items } = resurface(settings.count, at);
  if (!items.length) { setSetting(DIGEST_DAY_KEY, day); return 0; }
  const title = `Para leer hoy (${items.length}): ${items.map((i) => i.title || i.url).join(" · ")}`.slice(0, 280);
  const ok = await family.emit("digest.item", {
    title, url: appLink("bandeja"), watch: "links", kind: "resurface",
    items: items.map((i) => ({ link_id: i.id, title: i.title || i.url, url: i.url, reason: i.reason })),
  }, { block: true });
  if (!ok) return 0;
  setSetting(DIGEST_DAY_KEY, day);
  return items.length;
}
