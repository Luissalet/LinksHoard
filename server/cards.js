// Highlights to flashcards. Hypatia keeps the cards; this app only says which highlights already went
// (highlights.card_sent_at), so a second pass sends what is new and never the same card twice.
import { db, now } from "./db.js";
import { resolveSince } from "./since.js";
import * as links from "./links.js";
import * as family from "./hoard-link.js";

export const DEFAULT_DECK = "Lecturas";
export const highlightRef = (id) => `hoard://links/highlight/${id}`;
const CHUNK = 50;

/** The card a highlight makes: the quote on the front; the note and the article title on the back. */
export function cardOf(h, link) {
  const title = (link.title || link.url || "").trim();
  const note = (h.note || "").trim();
  const tags = ["lectura", ...(link.site ? [link.site] : [])].slice(0, 5);
  return {
    front: h.text,
    back: [note, title && `— ${title}`].filter(Boolean).join("\n\n") || link.url,
    source: link.url,
    tags,
    source_ref: highlightRef(h.id),
  };
}

function pick({ link_id, highlight_id, since, resend }) {
  const clauses = [];
  const params = [];
  if (highlight_id) { clauses.push("h.id = ?"); params.push(highlight_id); }
  if (link_id) { clauses.push("h.link_id = ?"); params.push(link_id); }
  const from = since ? resolveSince(since) : null;
  if (from) { clauses.push("h.created_at >= ?"); params.push(from); }
  const rows = db().prepare(
    `SELECT h.* FROM highlights h JOIN links l ON l.id = h.link_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY h.created_at, h.rowid`,
  ).all(...params);
  const fresh = resend || highlight_id ? rows : rows.filter((h) => !h.card_sent_at);
  return { rows: fresh, skipped: rows.length - fresh.length };
}

function failure(res) {
  if (res.status === null || res.status === undefined) return { status: "hub_down", error: res.error || "hub not reachable" };
  if (res.status === 404) return { status: "hypatia_unavailable", error: res.error || "the hub does not know Hypatia, or Hypatia has no cards_add" };
  if (res.status === 401) return { status: "hub_refused", error: res.error || "the hub refused this app's token" };
  return { status: "hypatia_error", error: String(res.error || (res.result && res.result.error) || `HTTP ${res.status}`).slice(0, 300) };
}

/**
 * Send highlights (of one link, or every one saved since a date; default: all that have not gone yet) to Hypatia's cards_add.
 * Resolves {ok, status, deck, sent, skipped, cards?, error?}. Never throws on a missing hub: `status` says why nothing went.
 */
export async function highlightsToCards({ link_id, highlight_id, url, since, deck = DEFAULT_DECK, resend = false } = {}) {
  let linkId = link_id || null;
  if (!linkId && url) {
    const l = links.getLinkByUrl(url);
    if (!l) return { ok: false, status: "unknown_link", deck, sent: 0, skipped: 0, error: "That URL is not saved." };
    linkId = l.id;
  }
  if (linkId && !links.getLink(linkId)) return { ok: false, status: "unknown_link", deck, sent: 0, skipped: 0, error: `No link ${linkId}.` };
  if (highlight_id && !db().prepare("SELECT 1 FROM highlights WHERE id = ?").get(highlight_id)) return { ok: false, status: "unknown_highlight", deck, sent: 0, skipped: 0, error: `No highlight ${highlight_id}.` };
  const { rows, skipped } = pick({ link_id: linkId, highlight_id, since, resend });
  if (!rows.length) return { ok: true, status: "nothing_new", deck, sent: 0, skipped, cards: [] };
  const byLink = new Map();
  const cards = rows.map((h) => {
    if (!byLink.has(h.link_id)) byLink.set(h.link_id, links.getLink(h.link_id));
    return { id: h.id, card: cardOf(h, byLink.get(h.link_id)) };
  });
  let sent = 0;
  const out = [];
  for (let i = 0; i < cards.length; i += CHUNK) {
    const part = cards.slice(i, i + CHUNK);
    let res = await family.call("hypatia", "cards_add", { deck, cards: part.map((c) => c.card) });
    // An older Hypatia that rejects the new per-card field still gets the cards, just without the reference.
    if (!res.ok && [400, 422].includes(res.status) && /source_ref/i.test(String(res.error || ""))) {
      res = await family.call("hypatia", "cards_add", { deck, cards: part.map(({ card: { source_ref, ...rest } }) => rest) });
    }
    const result = res.result && typeof res.result === "object" ? res.result : {};
    if (!res.ok || result.error) {
      return { ok: false, ...failure(result.error ? { ...res, error: result.error } : res), deck, sent, skipped, cards: out };
    }
    const stamp = now();
    const mark = db().prepare("UPDATE highlights SET card_sent_at = ?, card_deck = ? WHERE id = ?");
    for (const c of part) mark.run(stamp, deck, c.id);
    sent += part.length;
    out.push(...part.map((c) => ({ highlight_id: c.id, source_ref: c.card.source_ref })));
  }
  return { ok: true, status: "ok", deck, sent, skipped, cards: out };
}
