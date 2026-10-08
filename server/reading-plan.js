// A time-budgeted selection of complete saved texts. No fetches or state changes.
import { z } from "zod";
import { db } from "./db.js";

export const readingPlanInput = z.object({
  minutes: z.number().int().min(1).max(240).describe("Available reading time in whole minutes."),
  words_per_minute: z.number().int().min(50).max(1000).default(200).describe("Your assumed reading speed; default 200 words/minute."),
  max_items: z.number().int().min(1).max(20).default(5),
  tag: z.string().trim().min(1).max(40).optional(),
  site: z.string().trim().min(1).max(200).optional(),
}).strict();

function earlier(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Knapsack with a cardinality limit; ties favour favourites, fewer texts,
 * then older saved entries. Every item is charged its rounded-up minutes. */
export function selectReadingPlan(rows, input) {
  const options = readingPlanInput.parse(input);
  const { minutes, words_per_minute: speed, max_items } = options;
  const matching = rows.filter((row) => !row.archived && !row.read_at
    && (!options.tag || row.tags?.includes(options.tag))
    && (!options.site || row.site?.toLowerCase() === options.site.toLowerCase()));
  matching.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)
    || String(a.saved_at).localeCompare(String(b.saved_at)) || String(a.id).localeCompare(String(b.id)));
  const excluded = { unsupported_kind: 0, unavailable_text: 0, unknown_word_count: 0, over_budget: 0 };
  const candidates = [];
  for (const row of matching) {
    if (!["article", "pdf", "other"].includes(row.kind)) { excluded.unsupported_kind++; continue; }
    if (row.fetch_status !== "ok" || !row.has_text) { excluded.unavailable_text++; continue; }
    if (!Number.isSafeInteger(row.word_count) || row.word_count <= 0) { excluded.unknown_word_count++; continue; }
    const estimated_minutes = Math.ceil(row.word_count / speed);
    if (estimated_minutes > minutes) { excluded.over_budget++; continue; }
    candidates.push({ id: row.id, url: row.url, title: row.title, site: row.site,
      word_count: row.word_count, estimated_minutes, favorite: !!row.favorite,
      tags: row.tags || [], saved_at: row.saved_at });
  }
  const countLimit = Math.min(max_items, candidates.length);
  const plans = Array.from({ length: countLimit + 1 }, () => Array(minutes + 1).fill(null));
  plans[0][0] = { indices: [], favorites: 0 };
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index];
    for (let count = Math.min(countLimit, index + 1); count > 0; count--) {
      for (let time = minutes; time >= item.estimated_minutes; time--) {
        const previous = plans[count - 1][time - item.estimated_minutes];
        if (!previous) continue;
        const favorites = previous.favorites + Number(item.favorite);
        const existing = plans[count][time];
        const indices = [...previous.indices, index];
        if (!existing || favorites > existing.favorites
          || (favorites === existing.favorites && earlier(indices, existing.indices))) {
          plans[count][time] = { indices, favorites };
        }
      }
    }
  }
  let selected = plans[0][0], total = 0;
  for (let time = minutes; time > 0; time--) {
    let best = null;
    for (let count = 1; count <= countLimit; count++) {
      const plan = plans[count][time];
      // Ascending count makes fewer texts win a tie in duration/favourites.
      if (plan && (!best || plan.favorites > best.favorites)) best = plan;
    }
    if (best) { selected = best; total = time; break; }
  }
  const items = selected.indices.map((index) => candidates[index]);
  return { budget_minutes: minutes, words_per_minute: speed, max_items,
    estimated_minutes: total, unused_minutes: minutes - total,
    total_words: items.reduce((sum, item) => sum + item.word_count, 0),
    matching_unread: matching.length, eligible_candidates: candidates.length,
    not_selected: candidates.length - items.length, excluded,
    filters: { ...(options.tag ? { tag: options.tag } : {}), ...(options.site ? { site: options.site } : {}) },
    items, estimate: "Each complete text uses ceil(word_count / words_per_minute) minutes. Actual reading time can differ.",
    selection: "Fullest estimated budget, then favourites, fewer texts, older saved entries. No links are marked read or resurfaced." };
}

export function readingPlan(input) {
  // Do not load full article bodies or call resurface(), which saves daily picks.
  const rows = db().prepare(`SELECT id, url, title, site, word_count, kind, saved_at, favorite, tags,
    fetch_status, length(trim(content_text)) > 0 AS has_text
    FROM links WHERE archived = 0 AND read_at IS NULL`).all();
  return selectReadingPlan(rows.map((row) => ({ ...row, tags: JSON.parse(row.tags || "[]") })), input);
}
