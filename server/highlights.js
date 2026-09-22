// Highlights: short quotes clipped from a link's extracted text, with an
// optional note. Always scoped to an existing link.
import { z } from "zod";
import { db, uid, now } from "./db.js";
import { getLink } from "./links.js";

export const highlightInput = z.object({
  text: z.string().trim().min(1).max(5000),
  note: z.string().trim().max(2000).default(""),
});

const row = (r) => r || null;

export function listHighlights(linkId) {
  return db().prepare("SELECT * FROM highlights WHERE link_id = ? ORDER BY created_at").all(linkId);
}

export function getHighlight(id) {
  return row(db().prepare("SELECT * FROM highlights WHERE id = ?").get(id));
}

export function addHighlight(linkId, input) {
  if (!getLink(linkId)) throw Object.assign(new Error("El enlace no existe."), { status: 404 });
  const data = highlightInput.parse(input);
  const id = uid();
  db().prepare("INSERT INTO highlights (id, link_id, text, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, linkId, data.text, data.note, now());
  return getHighlight(id);
}

export function updateHighlight(id, patch) {
  const current = getHighlight(id);
  if (!current) return null;
  const data = highlightInput.partial().parse(patch);
  const next = { ...current, ...data };
  db().prepare("UPDATE highlights SET text = ?, note = ? WHERE id = ?").run(next.text, next.note, id);
  return getHighlight(id);
}

export function deleteHighlight(id) {
  return db().prepare("DELETE FROM highlights WHERE id = ?").run(id).changes > 0;
}
