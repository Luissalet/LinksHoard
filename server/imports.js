// Bulk import: Netscape bookmarks HTML (exported by every browser) and a
// plain list of URLs, one per line. Both dedupe against existing links and
// against repeats within the same import via createLink's URL idempotency.
import { parseHTML } from "linkedom";
import { z } from "zod";
import { createLink } from "./links.js";
import { isValidUrl } from "./url.js";
import { enqueueFetch } from "./fetcher.js";

export const importInput = z.object({
  format: z.enum(["netscape", "urls"]),
  content: z.string().min(1).max(10_000_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
});

// Netscape bookmark exports commonly use uppercase attributes (HREF, ADD_DATE);
// linkedom's parser does not case-fold them, so look the attribute up by name
// case-insensitively instead of assuming lowercase "href".
function hrefOf(a) {
  for (const attr of a.attributes) {
    if (attr.name.toLowerCase() === "href") return attr.value;
  }
  return "";
}

function parseNetscape(html) {
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll("a")];
  return links
    .map((a) => ({ url: hrefOf(a), title: a.textContent?.trim() || "" }))
    .filter((l) => isValidUrl(l.url));
}

function parseUrlList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url, title: "" }))
    .filter((l) => isValidUrl(l.url));
}

export function runImport(input) {
  const data = importInput.parse(input);
  const found = data.format === "netscape" ? parseNetscape(data.content) : parseUrlList(data.content);
  let added = 0;
  let skipped = 0;
  const items = [];
  for (const entry of found) {
    const { link, existing } = createLink({ url: entry.url, tags: data.tags, source: "import" });
    if (existing) skipped++;
    else {
      added++;
      enqueueFetch(link.id, link.url);
    }
    items.push(link);
  }
  return { found: found.length, added, skipped, links: items };
}
