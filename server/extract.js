// Turns fetched bytes into { title, byline, lang, contentText, description,
// kind }. HTML goes through linkedom + Readability with a manual fallback;
// PDFs and known video/social hosts get a lighter title-only extraction.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export function kindFromResponse(url, contentType) {
  const host = safeHost(url);
  const type = (contentType || "").toLowerCase();
  if (type.includes("pdf") || /\.pdf($|\?)/i.test(url)) return "pdf";
  if (type.startsWith("image/")) return "image";
  if (isVideoHost(host) || type.startsWith("video/")) return "video";
  if (type.includes("html")) return "article";
  return "other";
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "twitch.tv"];
const SOCIAL_HOSTS = ["x.com", "twitter.com"];
function isVideoHost(host) {
  return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
function isSocialHost(host) {
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Boilerplate that survives Readability's own heuristics often enough to
// pollute the excerpt (infoboxes are dense, plausible-looking text blocks)
// or the reading experience (navboxes, reference markers, the ToC). Stripped
// from the DOM before Readability runs, so neither its output nor our manual
// fallback ever sees them. Figure captions are deliberately NOT stripped.
const NOISE_SELECTORS = [
  "table.infobox", ".infobox", ".navbox", ".metadata", ".sidebar",
  ".mw-editsection", "[role=navigation]", "nav", "aside",
  ".reference", "sup.reference", ".toc",
];

function stripNoise(root) {
  for (const selector of NOISE_SELECTORS) {
    for (const el of [...root.querySelectorAll(selector)]) el.remove();
  }
}

const BLOCK_TAGS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote", "pre", "section", "article"]);
const CELL_TAGS = new Set(["td", "th"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

/**
 * DOM -> text that keeps block structure: a newline after block-level
 * elements (p, div, li, headings, tr, blockquote, pre, section, article, br)
 * and a separator between table cells, so "Cáncer de hígadoSepultura"-style
 * concatenation across cells/blocks cannot happen. Plain `.textContent`
 * loses all of this, which was the root cause of the glued-together text.
 */
function blockAwareText(root) {
  let out = "";
  function walk(node) {
    if (node.nodeType === 3) { out += node.data; return; } // TEXT_NODE
    if (node.nodeType !== 1) return; // element nodes only otherwise
    const tag = node.tagName?.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "br") { out += "\n"; return; }
    for (const child of node.childNodes) walk(child);
    if (CELL_TAGS.has(tag)) out += "\t";
    else if (BLOCK_TAGS.has(tag)) out += "\n";
  }
  walk(root);
  return out;
}

/** Collapse the raw block-aware text into readable lines: tabs (cell
 * separators) become spaces, runs of spaces collapse, each line is trimmed,
 * and 3+ consecutive newlines collapse to at most a single blank line. */
function normalizeBlockText(raw) {
  return raw
    .split("\n")
    .map((line) => line.replace(/\t+/g, " ").replace(/[  ]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse an HTML fragment (e.g. Readability's cleaned `article.content`) into block-aware, normalized text.
 * Needs a full `<html>` wrapper: linkedom's `document.body` getter only resolves a real
 * `<html><body>` pair — parsing a bare `<body>…</body>` string leaves it pointing at an empty phantom body. */
function htmlFragmentToText(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html || ""}</body></html>`);
  return normalizeBlockText(blockAwareText(document.body));
}

function metaContent(document, selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const value = el?.getAttribute("content") || el?.textContent;
    if (value && value.trim()) return value.trim();
  }
  return "";
}

/** Manual fallback when Readability finds nothing usable: title + meta description + the (already noise-stripped) body, block-aware. */
function manualExtract(document) {
  const title = metaContent(document, ['meta[property="og:title"]', "title"]) || "";
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']) || "";
  const bodyText = normalizeBlockText(blockAwareText(document.body || document));
  return { title, description, contentText: bodyText, byline: "" };
}

export function extractHtml(html, url) {
  const { document } = parseHTML(html, { location: url });
  const lang = document.documentElement?.getAttribute("lang") || "";
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']);

  // Remove infoboxes/navboxes/references/ToC etc. before Readability runs,
  // so its own "what is the article" heuristic is not thrown off by them
  // either — this is what kept the Borges infobox out of the excerpt.
  stripNoise(document);

  let article = null;
  try {
    // Readability mutates the DOM; work on the already-parsed document directly.
    article = new Readability(document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }

  if (article?.content) {
    const contentText = htmlFragmentToText(article.content);
    if (contentText) {
      return {
        title: article.title || metaContent(document, ['meta[property="og:title"]', "title"]) || "",
        byline: article.byline || "",
        contentText,
        description: description || (article.excerpt || ""),
        lang: article.lang || lang,
      };
    }
  }

  const fallback = manualExtract(document);
  return {
    title: fallback.title,
    byline: "",
    contentText: fallback.contentText,
    description: description || fallback.description,
    lang,
  };
}

/** YouTube/X (and other oEmbed-capable hosts) title without API keys. */
export async function oembedTitle(url) {
  const host = safeHost(url);
  let endpoint = null;
  if (isVideoHost(host) && (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com"))) {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else if (host === "vimeo.com") {
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  }
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    return { title: data.title || "", byline: data.author_name || "" };
  } catch {
    return null;
  }
}

/**
 * The excerpt is the first "real" paragraph — a line (see blockAwareText:
 * one per p/li/heading/tr/…) of at least 80 characters that contains
 * sentence punctuation, which in practice is the lead paragraph rather than
 * a short infobox label/value row. Falls back to the first `max` characters
 * of the whole text when no line qualifies (e.g. very short pages).
 */
export function excerptOf(text, max = 300) {
  const clean = (text || "").trim();
  if (!clean) return "";
  const lead = clean
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 80 && /[.!?]/.test(line));
  const base = lead || clean.slice(0, max);
  if (base.length <= max) return base;
  return `${base.slice(0, max).trim()}…`;
}

export function wordCount(text) {
  return (text || "").trim() ? (text.trim().match(/\S+/g) || []).length : 0;
}

export { isSocialHost, isVideoHost };
