// List watches: a page without a feed whose repeated entries (job offers, products, posts, listings) become watch items.
//
// The entries are found once: the largest group of sibling elements that look alike (same tag and classes) and each carry a link,
// outside navigation, header, footer and asides. That group is stored as a CSS selector, so later checks read the same thing; a
// selector can also be given by hand. Pages are followed through rel=next or a "Siguiente / Next / »" link, up to a limit, and the
// walk stops at the first page that brings nothing new. The idea of a list robot with pagination and a stop on known entries comes
// from the Maxun project (AGPL, ideas only; no code taken).
import { parseHTML } from "linkedom";
import { createHash } from "node:crypto";

const SKIP = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]";
const NOISE_CLASS = /^(active|selected|current|odd|even|first|last|is-.*|js-.*|hover|focus)$/i;
const NEXT_TEXT = /^(next|next page|siguiente|página siguiente|sig\.?|older|older posts|más antiguas|anteriores|›|»|>|→)$/i;
const SAFE = /^[A-Za-z_][\w-]*$/;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const classesOf = (el) => [...(el.classList || [])].filter((c) => SAFE.test(c) && !NOISE_CLASS.test(c)).sort();
const sig = (el) => `${el.tagName.toLowerCase()}.${classesOf(el).join(".")}`;
const cssOf = (el) => {
  if (el.id && SAFE.test(el.id)) return `#${el.id}`;
  const cls = classesOf(el).slice(0, 3);
  return el.tagName.toLowerCase() + cls.map((c) => `.${c}`).join("");
};

function absolute(href, base) {
  if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href.trim())) return "";
  try {
    const u = new URL(href.trim(), base);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    return u.href;
  } catch { return ""; }
}

/** One entry of an item element: its main link, a title and the rest of its text. */
function entryOf(el, base) {
  const anchors = el.tagName === "A" ? [el] : [...el.querySelectorAll("a[href]")];
  const links = anchors.map((a) => ({ a, url: absolute(a.getAttribute("href"), base), text: clean(a.textContent) })).filter((l) => l.url);
  if (!links.length) return null;
  // the heading is the first title-like element that holds one of the links (a rank cell classed "title" does not count)
  const heading = [...el.querySelectorAll("h1, h2, h3, h4, h5, h6, [itemprop=name], .title, .titleline")]
    .find((h) => links.some((l) => h.contains(l.a)));
  const headingText = clean(heading?.textContent);
  const inHeading = heading ? links.find((l) => heading.contains(l.a)) : null;
  const main = inHeading || links.slice().sort((x, y) => y.text.length - x.text.length)[0];
  const title = (headingText || main.text || clean(el.textContent)).slice(0, 200);
  let summary = clean(el.textContent);
  const at = title ? summary.indexOf(title) : -1;
  if (at >= 0) summary = clean(`${summary.slice(0, at)} ${summary.slice(at + title.length)}`);
  summary = summary.replace(/^\d+[.)]\s*/, "");                 // a rank number ("1.") is not a summary
  return { guid: `list:${main.url}`, url: main.url, title, summary: summary.slice(0, 400) };
}

/** The repeated element that holds an anchor: the nearest ancestor with at least two siblings that look the same. */
function itemOf(a) {
  let el = a;
  for (let depth = 0; el && el.parentElement && depth < 7; depth++, el = el.parentElement) {
    const s = sig(el);
    let same = 0;
    for (const c of el.parentElement.children) if (sig(c) === s && ++same >= 3) return el;
  }
  return null;
}

/** Find the list in a document: -> { selector, elements } or null. */
function detect(document) {
  const groups = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    if (a.closest(SKIP)) continue;
    const item = itemOf(a);
    if (!item || item.closest(SKIP)) continue;
    const key = item.parentElement;
    if (!groups.has(key)) groups.set(key, new Map());
    const bySig = groups.get(key);
    const s = sig(item);
    if (!bySig.has(s)) bySig.set(s, new Set());
    bySig.get(s).add(item);
  }
  let best = null;
  for (const [parent, bySig] of groups) {
    for (const [, set] of bySig) {
      const entries = [...set].map((e) => entryOf(e, "http://x/")).filter(Boolean);
      const urls = new Set(entries.map((e) => e.url));
      if (urls.size < 3) continue;
      // many distinct links, and links that read like titles: a row of "12 comments | hide" loses against the row of headlines
      const titleLen = entries.reduce((n, e) => n + Math.min(e.title.length, 80), 0) / entries.length;
      const score = urls.size * (1 + titleLen / 20);
      if (!best || score > best.score) best = { score, parent, item: [...set][0] };
    }
  }
  if (!best) return null;
  // an item without classes must not also match its classed siblings (a header row, a spacer)
  const itemClasses = classesOf(best.item).slice(0, 3);
  const itemCss = best.item.tagName.toLowerCase() + (itemClasses.length ? itemClasses.map((c) => `.${c}`).join("") : ":not([class])");
  return { selector: `${cssOf(best.parent)} > ${itemCss}` };
}

function nextUrl(document, base) {
  const rel = document.querySelector("link[rel~=next][href], a[rel~=next][href]");
  const candidates = rel ? [rel] : [...document.querySelectorAll("a[href]")].filter((a) => {
    const label = clean(a.getAttribute("aria-label") || a.textContent);
    return NEXT_TEXT.test(label) || /(^|[\s_-])(next|siguiente)([\s_-]|$)/i.test(a.getAttribute("class") || "");
  });
  for (const a of candidates) {
    const url = absolute(a.getAttribute("href"), base);
    if (url && url !== absolute(base, base) && new URL(url).host === new URL(base).host) return url;
  }
  return "";
}

/**
 * Read one page of a list: -> { items, selector, detected, next, title, hash } or { error }.
 * With a selector, its matches are the entries (outside navigation); without one, the list is detected and its selector returned.
 */
export function readListPage(html, baseUrl, selector = "") {
  const { document } = parseHTML(String(html || ""));
  let used = (selector || "").trim();
  let detected = false;
  if (!used) {
    const found = detect(document);
    if (!found) return { error: "No encuentro una lista repetida en la página (al menos 3 entradas con enlace). Indica un selector CSS." };
    used = found.selector;
    detected = true;
  }
  let elements;
  try {
    elements = [...document.querySelectorAll(used)].filter((el) => !el.closest(SKIP) || el.matches(SKIP));
  } catch {
    return { error: `Selector CSS no válido: ${used}` };
  }
  const items = [];
  const seen = new Set();
  for (const el of elements) {
    const entry = entryOf(el, baseUrl);
    if (entry && !seen.has(entry.guid)) { seen.add(entry.guid); items.push(entry); }
  }
  if (!items.length) return { error: `El selector «${used}» no encuentra entradas con enlace en la página.` };
  const hash = createHash("sha256").update(items.map((i) => i.guid).join("\n")).digest("hex").slice(0, 32);
  return { items, selector: used, detected, next: nextUrl(document, baseUrl), title: clean(document.querySelector("title")?.textContent).slice(0, 200), hash };
}

/**
 * Walk a list from its first page (already fetched): follow next pages up to `pages`, stopping at the first page with nothing that
 * `known` holds as new (when `known` is given). `fetchPage(url)` -> { ok, text, url, error }.
 * -> { items (first page first, page order), pages: [{url, count, fresh}], selector, detected, title, hash, error }
 */
export async function walkList(first, { selector = "", pages = 3, known = null, fetchPage }) {
  const firstUrl = first.final_url || first.url;
  const page1 = readListPage(first.text, firstUrl, selector);
  if (page1.error) return { error: page1.error, items: [], pages: [] };
  const out = { items: [], pages: [], selector: page1.selector, detected: page1.detected, title: page1.title, hash: page1.hash, error: "" };
  const visited = new Set([firstUrl]);
  let page = page1;
  let url = firstUrl;
  for (let n = 1; ; n++) {
    const fresh = known ? page.items.filter((i) => !known.has(i.guid)).length : page.items.length;
    out.items.push(...page.items);
    out.pages.push({ url, count: page.items.length, fresh });
    if (n >= pages || !page.next || visited.has(page.next) || (known && fresh === 0)) break;
    url = page.next;
    visited.add(url);
    const got = await fetchPage(url).catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (!got.ok) { out.error = `Página ${n + 1}: ${got.error || "sin respuesta"}`; break; }
    page = readListPage(got.text, got.final_url || got.url || url, out.selector);
    if (page.error) break;                                   // a next page with another layout ends the walk quietly
  }
  return out;
}
