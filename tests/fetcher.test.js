// The page fetcher of saved links on the shared web.js: charset, kinds that are saved by title, block detection, the byte cap and the address check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer, waitFetched } from "./helpers.js";

let s, server, base;
const ARTICLE = (title, body) => `<!doctype html><html lang="es"><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
const PARAS = Array.from({ length: 6 }, (_, i) => `<p>Párrafo ${i + 1}: el café está caliente y la canción suena en la plaza mientras la gente pasea tranquilamente por la avenida principal.</p>`).join("");

before(async () => {
  s = await bootServer();
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/latin1")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
      return res.end(Buffer.from(ARTICLE("Café y canción", PARAS), "latin1"));
    }
    if (req.url.startsWith("/legacy")) {
      // no charset in the header, a <meta> says windows-1252, and the bytes are cp1252 (the euro sign is 0x80)
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(Buffer.from(`<!doctype html><html><head><meta charset="windows-1252"><title>Precio 5\u0080</title></head><body><article><h1>Precio 5\u0080</h1>${PARAS}</article></body></html>`, "latin1"));
    }
    if (req.url.startsWith("/paper.pdf")) { res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end(Buffer.from("%PDF-1.4 fake")); }
    if (req.url.startsWith("/picture")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
    if (req.url.startsWith("/cloudflare")) {
      res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
      return res.end("<html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>");
    }
    if (req.url.startsWith("/missing")) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<html><body>no</body></html>"); }
    if (req.url.startsWith("/redirect")) { res.writeHead(302, { Location: "/latin1" }); return res.end(); }
    if (req.url.startsWith("/huge")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(ARTICLE("Enorme", PARAS));
      return res.end(`<!-- ${"x".repeat(6 * 1024 * 1024)} -->`);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ARTICLE("Artículo", PARAS));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await s.stop();
  await new Promise((r) => server.close(r));
});

const save = async (path) => {
  const r = await s.agent("save_link", { url: `${base}${path}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return waitFetched(s, r.body.id);
};

test("the charset of the header and of the page decides how the text is read", async () => {
  const latin = await save("/latin1");
  assert.equal(latin.fetch_status, "ok", latin.fetch_error);
  assert.equal(latin.title, "Café y canción");
  assert.match(latin.content_text, /el café está caliente/);
  const legacy = await save("/legacy");
  assert.equal(legacy.title, "Precio 5€");
});

test("PDFs and images are saved by their file name, not refused as 'not HTML'", async () => {
  const pdf = await save("/paper.pdf");
  assert.equal(pdf.fetch_status, "ok", pdf.fetch_error);
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.title, "paper.pdf");
  const img = await save("/picture");
  assert.equal(img.kind, "image");
});

test("a redirect is followed and a normal page is extracted", async () => {
  const r = await save("/redirect");
  assert.equal(r.fetch_status, "ok", r.fetch_error);
  assert.equal(r.kind, "article");
  assert.match(r.content_text, /Párrafo 1/);
});

test("a challenge page and an error page fail with the reason instead of being saved as content", async () => {
  const blocked = await save("/cloudflare");
  assert.equal(blocked.fetch_status, "failed");
  assert.match(blocked.fetch_error, /blocked: Cloudflare/);
  assert.equal(blocked.content_text, "");
  const gone = await save("/missing");
  assert.equal(gone.fetch_status, "failed");
  assert.match(gone.fetch_error, /HTTP 404/);
});

test("a page far beyond the 5 MB cap is cut, not refused, and still gives its text", async () => {
  const huge = await save("/huge");
  assert.equal(huge.fetch_status, "ok", huge.fetch_error);
  assert.match(huge.content_text, /Párrafo 1/);
});

test("without the opt-in a saved link to this machine fails with a message that says what to do", async () => {
  process.env.LINKS_ALLOW_PRIVATE_URLS = "0";
  try {
    const r = await save("/latin1?private=1");
    assert.equal(r.fetch_status, "failed");
    assert.match(r.fetch_error, /no se puede descargar.*loopback/i);
    assert.match(r.fetch_error, /LINKS_ALLOW_PRIVATE_URLS=1/);
  } finally {
    process.env.LINKS_ALLOW_PRIVATE_URLS = "1";
  }
});
