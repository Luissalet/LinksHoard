// A page as the browser shows it: the browser extension (extension/) sends the rendered HTML of the tab, or the bytes of a
// PDF/DOCX/EPUB it opened with the user's session, and the link is saved with that text instead of being fetched again
// from the server (which would see the signed-out page).
import { z } from "zod";
import * as links from "./links.js";
import { extractHtml, excerptOf, wordCount, kindFromResponse } from "./extract.js";
import { documentType, extractDocument } from "./documents.js";

export const captureInput = z.object({
  url: z.string().trim().min(1).max(4000),
  title: z.string().trim().max(500).default(""),
  html: z.string().max(30 * 1024 * 1024).optional(),
  data_base64: z.string().max(60 * 1024 * 1024).optional(),
  content_type: z.string().trim().max(200).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
}).refine((v) => v.html || v.data_base64, { message: "Falta el contenido: html o data_base64." });

export async function capturePage(input) {
  const data = captureInput.parse(input);
  const { link, existing } = links.createLink({ url: data.url, tags: data.tags, source: "extension" });
  let result;
  if (data.data_base64) {
    const body = Buffer.from(data.data_base64, "base64");
    const type = documentType(data.url, data.content_type, body);
    if (!type) throw Object.assign(new Error("El archivo no es un PDF, DOCX ni EPUB."), { status: 400 });
    const doc = await extractDocument(body, { type, url: data.url });
    result = { kind: doc.kind, title: doc.title, byline: doc.byline, lang: doc.lang, contentText: doc.contentText, description: "" };
  } else {
    const kind = kindFromResponse(data.url, "text/html");
    result = { ...extractHtml(data.html, data.url), kind: kind === "video" ? "video" : "article" };
  }
  const updated = links.applyFetchResult(link.id, {
    fetch_status: "ok", fetch_error: "",
    title: result.title || data.title || links.getLink(link.id).title || "",
    description: result.description || "",
    content_text: result.contentText || "",
    excerpt: excerptOf(result.contentText || result.description || ""),
    byline: result.byline || "", lang: result.lang || "",
    word_count: wordCount(result.contentText || ""), kind: result.kind,
  });
  if (data.tags.length && existing) links.updateLink(link.id, { tags_add: data.tags });
  return { ...links.getLink(updated.id), existing, reader_url: `#/link/${encodeURIComponent(link.id)}?fold=2` };
}
