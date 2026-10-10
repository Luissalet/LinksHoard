// References use exact offsets into the stored extraction, never a second HTML parse.
import { createHash } from "node:crypto";

export function articleSource(link) {
  const text = link.content_text || "";
  const version = createHash("sha256").update(text).digest("hex");
  const paragraphs = [];
  // The extractor puts one block per line; blank lines remain untouched in the reader.
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    const value = match[0].trim();
    if (!value) continue;
    const start = match.index + match[0].indexOf(value);
    const index = paragraphs.length + 1;
    const id = `p-${version.slice(0, 16)}-${index}`;
    paragraphs.push({ id, index, start, end: start + value.length, text: value,
      reader_url: `#/link/${encodeURIComponent(link.id)}?paragraph=${id}&version=${version}` });
  }
  return { version, paragraphs, total_chars: text.length };
}
