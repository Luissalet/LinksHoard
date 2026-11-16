// Small real documents built in the test: a zip writer (for DOCX and EPUB) and a one-font PDF with positioned lines.
import zlib from "node:zlib";

/** A zip file of { name: string | Buffer } entries, deflated (the first one stored, as EPUB wants its mimetype). */
export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, value], i) => {
    const data = Buffer.from(value);
    const stored = i === 0;
    const body = stored ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  });
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function docx(paragraphs, { title = "", author = "" } = {}) {
  const body = paragraphs.map((p) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${p.split("|").map((run) => `<w:r><w:t xml:space="preserve">${esc(run)}</w:t></w:r>`).join("")}</w:p>`).join("");
  return zip({
    "[Content_Types].xml": "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="c" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>es</dc:language></cp:coreProperties>`,
  });
}

export function epub(chapters, { title = "", author = "" } = {}) {
  const files = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": "<?xml version=\"1.0\"?><container><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
    "OEBPS/content.opf": `<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>es</dc:language></metadata>
<manifest>${chapters.map((_, i) => `<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`,
  };
  chapters.forEach((html, i) => { files[`OEBPS/text/c${i}.xhtml`] = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${html}</body></html>`; });
  return zip(files);
}

/** A PDF whose pages are lists of [y, text, size?] lines in Helvetica; a gap wider than a line starts a new paragraph. */
export function pdf(pages, { title = "", author = "" } = {}) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null), pagesObj = add(null), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const info = add(`<< /Title (${title}) /Author (${author}) >>`);
  const kids = [];
  for (const lines of pages) {
    const stream = lines.map(([y, text, size = 11]) => `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
