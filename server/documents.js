// Text of documents that are not web pages: PDF (through unpdf, a bundled pdf.js without native modules), DOCX and EPUB
// (both zip files, read here with node:zlib). The result follows the extractor's convention: one paragraph per line.
import zlib from "node:zlib";
import { parseHTML } from "linkedom";
import { extractHtml } from "./extract.js";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const EPUB_TYPE = "application/epub+zip";

/** "pdf" | "docx" | "epub" | null from the content type, the URL or the first bytes. */
export function documentType(url, contentType, body) {
  const type = String(contentType || "").toLowerCase();
  const pathname = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return String(url || "").toLowerCase(); } })();
  if (type.includes("pdf") || pathname.endsWith(".pdf") || (body && body.subarray(0, 5).toString("latin1") === "%PDF-")) return "pdf";
  if (type.includes("wordprocessingml") || pathname.endsWith(".docx")) return "docx";
  if (type.includes("epub") || pathname.endsWith(".epub")) return "epub";
  if (body && body.length > 60 && body.readUInt32LE(0) === 0x04034b50) {
    const head = body.subarray(30, 90).toString("latin1");
    if (head.startsWith("mimetypeapplication/epub+zip")) return "epub";
    if (readZip(body).has("word/document.xml")) return "docx";
  }
  return null;
}

/** Bytes of a document -> { kind, title, byline, lang, contentText, pages? }. Throws with a Spanish message when unreadable. */
export async function extractDocument(body, { type, url = "" } = {}) {
  const kind = type || documentType(url, "", body);
  if (kind === "pdf") return { kind: "pdf", ...(await pdfText(body)) };
  if (kind === "docx") return { kind: "document", ...docxText(body) };
  if (kind === "epub") return { kind: "document", ...epubText(body, url) };
  throw new Error("Formato de documento no reconocido (PDF, DOCX o EPUB).");
}

// ------------------------------------------------------------------------------------------------ zip

/** Entries of a zip file: Map name -> () => Buffer (stored or deflated; enough for DOCX and EPUB). */
export function readZip(buf) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return entries;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const decodeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const named = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" }[e.toLowerCase()];
  if (named) return named;
  const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

// ------------------------------------------------------------------------------------------------ DOCX

function docxText(buf) {
  const zip = readZip(buf);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error("El DOCX no tiene word/document.xml.");
  const xml = doc().toString("utf8");
  const lines = [];
  for (const match of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const para = match[0];
    let text = "";
    for (const run of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) text += run[1] !== undefined ? decodeXml(run[1]) : " ";
    text = text.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
  }
  const core = zip.get("docProps/core.xml")?.().toString("utf8") || "";
  const title = decodeXml(core.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] || "").trim();
  const byline = decodeXml(core.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] || "").trim();
  const lang = core.match(/<dc:language>([\s\S]*?)<\/dc:language>/)?.[1]?.trim() || "";
  return { title: title || lines[0]?.slice(0, 200) || "", byline, lang, contentText: lines.join("\n") };
}

// ------------------------------------------------------------------------------------------------ EPUB

function epubText(buf, url) {
  const zip = readZip(buf);
  const container = zip.get("META-INF/container.xml")?.().toString("utf8") || "";
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath && zip.get(opfPath)?.().toString("utf8");
  if (!opf) throw new Error("El EPUB no tiene índice (OPF).");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const id = m[0].match(/\sid="([^"]+)"/)?.[1], href = m[0].match(/\shref="([^"]+)"/)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const blocks = [];
  for (const m of opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]);
    const file = href && zip.get(normalizePath(base + href));
    if (!file) continue;
    const { document } = parseHTML(file().toString("utf8"));
    const text = extractHtml(`<html><body><article>${document.body?.innerHTML || ""}</article></body></html>`, url || "https://epub.invalid/").contentText;
    if (text) blocks.push(text);
  }
  const title = decodeXml(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || "").trim();
  const byline = decodeXml(opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/)?.[1] || "").trim();
  const lang = opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/)?.[1]?.trim() || "";
  return { title, byline, lang, contentText: blocks.join("\n") };
}

function normalizePath(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

// ------------------------------------------------------------------------------------------------ PDF

/** PDF text rebuilt into paragraphs: lines from the text items, a new paragraph on a wide vertical gap, words split by a
 * hyphen at a line end joined again, and running heads/feet (the same line on many pages) and bare page numbers dropped. */
async function pdfText(buf) {
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(buf)); } catch (e) { throw new Error(`No se pudo leer el PDF: ${e.message || e}`); }
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const lines = [];
    let current = null;
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      // rotated text (a stamp in the margin, a vertical label) is not part of the reading flow
      if (Math.abs(item.transform?.[1] || 0) > 0.01 || Math.abs(item.transform?.[2] || 0) > 0.01) continue;
      const y = item.transform?.[5] ?? 0, size = Math.abs(item.transform?.[3] || item.height || 10);
      if (!current || Math.abs(current.y - y) > size * 0.5) {
        if (current && current.text.trim()) lines.push(current);
        current = { y, size, text: "" };
      }
      current.text += item.str;
      if (item.hasEOL) { if (current.text.trim()) lines.push(current); current = null; }
    }
    if (current && current.text.trim()) lines.push(current);
    pages.push(lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })));
  }
  const meta = await pdf.getMetadata().catch(() => null);
  // running heads and feet: a line (digits ignored) present on at least half the pages of a document of 3+ pages
  const seen = new Map();
  for (const lines of pages) for (const key of new Set(lines.map((l) => l.text.replace(/\d+/g, "#")))) seen.set(key, (seen.get(key) || 0) + 1);
  const repeated = (text) => pages.length >= 3 && seen.get(text.replace(/\d+/g, "#")) >= Math.ceil(pages.length / 2);
  const paragraphs = [];
  let para = "";
  const flush = () => { if (para.trim()) paragraphs.push(para.trim()); para = ""; };
  for (const lines of pages) {
    const kept = lines.filter((l) => !/^\d{1,4}$/.test(l.text) && !repeated(l.text));
    const gaps = [];
    for (let i = 1; i < kept.length; i++) { const g = kept[i - 1].y - kept[i].y; if (g > 0) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    // the line spacing: most gaps on a page are between lines of one paragraph, so the lower quartile is that spacing
    const usual = gaps.length ? gaps[Math.floor((gaps.length - 1) / 4)] : 14;
    for (let i = 0; i < kept.length; i++) {
      const line = kept[i];
      if (i > 0) {
        const gap = kept[i - 1].y - line.y;
        const sizeChange = Math.abs(line.size - kept[i - 1].size) > 0.8;
        if (gap <= 0 || gap > usual * 1.45 || sizeChange) flush();
      }
      if (!para) para = line.text;
      else if (/[A-Za-zÀ-ÿ]-$/.test(para) && /^[a-zà-ÿ]/.test(line.text)) para = para.slice(0, -1) + line.text;
      else para += ` ${line.text}`;
    }
    // a paragraph that runs over a page break continues when the page ended mid-sentence
    if (para && /[.!?:;)\]"»”]$/.test(para)) flush();
  }
  flush();
  return {
    title: String(meta?.info?.Title || "").trim(),
    byline: String(meta?.info?.Author || "").trim(),
    lang: "",
    contentText: paragraphs.join("\n"),
    pages: pdf.numPages,
  };
}
