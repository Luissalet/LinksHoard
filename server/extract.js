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

function stripText(html) {
  const { document } = parseHTML(`<body>${html}</body>`);
  return (document.body.textContent || "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function metaContent(document, selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const value = el?.getAttribute("content") || el?.textContent;
    if (value && value.trim()) return value.trim();
  }
  return "";
}

/** Manual fallback when Readability finds nothing usable: title + meta description + stripped body. */
function manualExtract(document) {
  const title = metaContent(document, ['meta[property="og:title"]', "title"]) || "";
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']) || "";
  const bodyText = stripText(document.body?.innerHTML || "");
  return { title, description, contentText: bodyText, byline: "" };
}

export function extractHtml(html, url) {
  const { document } = parseHTML(html, { location: url });
  const lang = document.documentElement?.getAttribute("lang") || "";
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']);

  let article = null;
  try {
    // Readability mutates the DOM; work on the already-parsed document directly.
    article = new Readability(document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }

  if (article?.textContent?.trim()) {
    return {
      title: article.title || metaContent(document, ['meta[property="og:title"]', "title"]) || "",
      byline: article.byline || "",
      contentText: article.textContent.trim(),
      description: description || (article.excerpt || ""),
      lang: article.lang || lang,
    };
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

export function excerptOf(text, max = 300) {
  const clean = (text || "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}…`;
}

export function wordCount(text) {
  return (text || "").trim() ? (text.trim().match(/\S+/g) || []).length : 0;
}

export { isSocialHost, isVideoHost };
