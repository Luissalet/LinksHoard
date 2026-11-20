import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { articleSource } from "../server/article-source.js";
import { buildSections, keySentences, isHeading } from "../server/fold.js";
import { extractDocument, documentType } from "../server/documents.js";
import { arxivPdf } from "../server/fetcher.js";
import { createLink, applyFetchResult, getLink } from "../server/links.js";
import { bootServer, waitFetched } from "./helpers.js";
import { pdf, docx, epub } from "./doc-fixtures.js";

const para = (topic, n) => Array.from({ length: n }, (_, i) =>
  `${topic} paragraph ${i + 1} explains how folding keeps the literal text of a document apart from what a model writes about it, so every summary can be checked against its source passage.`).join(" ");
const ARTICLE = ["1 Introduction", para("Introduction", 3), para("Context", 2), "2 Method", para("Method", 4), "3 Results", para("Results", 3), "References", "[1] A. Author. A paper. 2020."].join("\n");

test("sections follow the headings, key sentences are literal with exact offsets, references are set apart", () => {
  const source = articleSource({ id: "f", content_text: ARTICLE });
  const sections = buildSections(source);
  assert.deepEqual(sections.map((s) => s.title), ["1 Introduction", "2 Method", "3 Results", "References"]);
  assert.equal(sections.at(-1).references, true);
  assert.deepEqual(sections.flatMap((s) => s.paragraph_ids), source.paragraphs.map((p) => p.id), "every paragraph once, in reading order");
  const sentences = keySentences(source, sections, "en");
  for (const s of sections.slice(0, 3)) {
    const picked = sentences.get(s.id);
    assert.ok(picked.length >= 1 && picked.length <= 5);
    for (const x of picked) assert.equal(ARTICLE.slice(x.start, x.end), x.text);
  }
  assert.deepEqual(sentences.get(sections[3].id), []);
  // a text without headings is cut by length
  const plain = articleSource({ id: "p", content_text: Array.from({ length: 12 }, (_, i) => para(`Plain ${i}`, 4)).join("\n") });
  const chunks = buildSections(plain);
  assert.ok(chunks.length >= 2 && chunks.every((s) => s.title === ""));
  assert.equal(isHeading({ text: "This sentence ends with a period." }, { text: "x".repeat(200) }), false);
});

test("PDF, DOCX and EPUB become paragraphs; arXiv abstract pages point at their PDF", async () => {
  const doc = pdf([
    [[740, "1 Introduction", 16], [700, "Folding keeps the literal text apart from what a"], [686, "model writes, so a reader can check every sum-"], [672, "mary against its source."], [640, "A second paragraph after a wide gap."], [60, "Running foot 1"]],
    [[740, "2 Method", 16], [700, "We split the text into sections."], [60, "Running foot 2"]],
    [[740, "3 Results", 16], [700, "The levels read from five to one."], [60, "Running foot 3"]],
  ], { title: "Folding paper", author: "Ana" });
  assert.equal(documentType("https://example.com/download", "", doc), "pdf");
  const p = await extractDocument(doc, { url: "https://example.com/a.pdf" });
  assert.equal(p.title, "Folding paper"); assert.equal(p.byline, "Ana"); assert.equal(p.pages, 3);
  assert.deepEqual(p.contentText.split("\n"), ["1 Introduction",
    "Folding keeps the literal text apart from what a model writes, so a reader can check every summary against its source.",
    "A second paragraph after a wide gap.", "2 Method", "We split the text into sections.", "3 Results", "The levels read from five to one."]);
  const w = await extractDocument(docx(["Título", "Primer párrafo con |dos runs.", "Tercero & último."], { title: "Mi DOCX", author: "Equipo editorial" }), {});
  assert.deepEqual({ ...w }, { kind: "document", title: "Mi DOCX", byline: "Equipo editorial", lang: "es", contentText: "Título\nPrimer párrafo con dos runs.\nTercero & último." });
  const e = await extractDocument(epub(["<h1>Capítulo uno</h1><p>Texto del primero.</p>", "<h2>Capítulo dos</h2><p>Más texto.</p>"], { title: "Mi libro", author: "Ana" }), {});
  assert.equal(e.title, "Mi libro"); assert.equal(e.contentText, "Capítulo uno\nTexto del primero.\nCapítulo dos\nMás texto.");
  assert.equal(arxivPdf("https://arxiv.org/abs/2401.01234v2"), "https://arxiv.org/pdf/2401.01234v2");
  assert.equal(arxivPdf("https://example.com/abs/1"), null);
});

test("fold, translation and capture through HTTP and the real stdio MCP bridge", async (t) => {
  Object.assign(process.env, { LINKS_WATCHES: "0", LINKS_VIDEO_AUTO: "0", LINKS_MEDIA_AUTO_UPDATE: "0", HOARD_HUB_AUTOSTART: "0" });
  const calls = { fold: 0, themes: 0, translate: 0 };
  let failNext = false;
  const hub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const system = body.messages?.[0]?.content || "";
      const input = JSON.parse(body.messages?.[1]?.content || "{}");
      let json;
      if (failNext) { failNext = false; res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no_model" })); return; }
      if (system.startsWith("You fold")) {
        calls.fold++;
        json = { sections: input.sections.map((s) => ({ section_id: s.section_id, title: s.heading || "Título generado", idea: `Idea de ${s.section_id}`,
          why: `Porque ${s.section_id} importa`, line: `Línea de ${s.section_id}`, paragraph: Number(s.text.match(/\[(\d+)\]/g).at(-1).slice(1, -1)) })) };
      } else if (system.startsWith("Group")) {
        calls.themes++;
        json = { themes: [{ title: "Tema A", summary: "Resumen A", section_ids: input.sections.slice(0, 2).map((s) => s.section_id) },
          { title: "Tema B", summary: "Resumen B", section_ids: [...input.sections.slice(2).map((s) => s.section_id), "s99"] }] };
      } else if (system.startsWith("Translate")) {
        calls.translate++;
        json = { items: input.paragraphs.map((p) => ({ paragraph_id: p.paragraph_id, text: `[es] ${p.text}` })) };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, json, model: "fold-fixture", provider: "fixture" }));
    });
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const oldHub = process.env.HOARD_HUB_URL;
  process.env.HOARD_HUB_URL = `http://127.0.0.1:${hub.address().port}`;
  const s = await bootServer();
  let client;
  const link = createLink({ url: "https://example.com/fold-article" }).link;
  applyFetchResult(link.id, { title: "Plegado", kind: "article", fetch_status: "ok", content_text: ARTICLE, word_count: 300 });
  try {
    await t.test("levels 1-2 need no model; 3-5 are generated once and cached", async () => {
      const before = await s.call("GET", `/api/links/${link.id}/fold`);
      assert.equal(before.status, 200);
      assert.equal(before.body.format, "links-fold"); assert.equal(before.body.generation.status, "none");
      assert.equal(before.body.sections.length, 4); assert.ok(before.body.sections[0].sentences.length);
      const lv2 = await s.call("GET", `/api/links/${link.id}/fold/read?level=2`);
      assert.equal(lv2.body.ok, true); assert.match(lv2.body.text, /## s2 · 2 Method/); assert.match(lv2.body.text, /\[¶\d+\]/);
      const lv3 = await s.call("GET", `/api/links/${link.id}/fold/read?level=key`);
      assert.equal(lv3.body.ok, false); assert.equal(calls.fold, 0);
      const started = await s.call("POST", `/api/links/${link.id}/fold`, { wait_s: 30 });
      assert.equal(started.body.status, "done");
      assert.equal(calls.fold, 1); assert.equal(calls.themes, 1);
      const doc = (await s.call("GET", `/api/links/${link.id}/fold`)).body;
      assert.equal(doc.sections[1].key.idea, "Idea de s2");
      assert.ok(doc.sections[1].paragraph_ids.includes(doc.sections[1].key.paragraph_id));
      assert.equal(doc.sections[3].key, null, "references are not sent to the model");
      assert.deepEqual(doc.themes.map((x) => x.section_ids), [["s1", "s2"], ["s3"]], "unknown section ids are dropped");
      assert.ok(doc.levels.every((l) => typeof l.tokens === "number"));
      await s.call("POST", `/api/links/${link.id}/fold`, { wait_s: 5 });
      assert.equal(calls.fold, 1, "cached: no second generation");
      const lv5 = (await s.call("GET", `/api/links/${link.id}/fold/read?level=5`)).body;
      assert.match(lv5.text, /### Tema A/); assert.equal(lv5.generated, true);
      const lv4 = (await s.call("GET", `/api/links/${link.id}/fold/read?level=4&section=s3`)).body;
      assert.match(lv4.text, /3 Results: Línea de s3/);
      assert.equal((await s.call("GET", `/api/links/${link.id}/fold/read?level=9`)).status, 400);
    });

    await t.test("a note stays with its passage at every level", async () => {
      const source = articleSource(getLink(link.id));
      const target = source.paragraphs.find((p) => p.text.startsWith("Method"));
      await s.call("POST", `/api/links/${link.id}/highlights`, { text: target.text.slice(0, 60), note: "Revisar este método" });
      const doc = (await s.call("GET", `/api/links/${link.id}/fold`)).body;
      assert.equal(doc.sections[1].notes[0].note, "Revisar este método");
      assert.equal(doc.sections[1].notes[0].paragraph_id, target.id);
      assert.match((await s.call("GET", `/api/links/${link.id}/fold/read?level=4`)).body.text, /nota: Revisar este método/);
    });

    await t.test("a changed text makes the generated levels stale and a model failure is reported, not hidden", async () => {
      applyFetchResult(link.id, { content_text: `${ARTICLE}\nOne more closing paragraph that changes the source version of the text entirely.` });
      assert.equal((await s.call("GET", `/api/links/${link.id}/fold`)).body.generation.status, "stale");
      failNext = true;
      const out = (await s.call("POST", `/api/links/${link.id}/fold`, { wait_s: 30 })).body;
      assert.equal(out.status, "failed"); assert.equal(out.generation.error, "no_model");
      assert.equal((await s.call("GET", `/api/links/${link.id}/fold/read?level=2`)).body.ok, true, "literal levels still read");
      assert.equal((await s.call("POST", `/api/links/${link.id}/fold`, { wait_s: 30 })).body.status, "done", "asking again completes it");
    });

    await t.test("bilingual pairs are stored per language and reused", async () => {
      const first = (await s.call("POST", `/api/links/${link.id}/translate`, { lang: "es", offset: 0, limit: 3 })).body;
      assert.equal(first.status, "translated"); assert.equal(first.pairs.length, 3);
      assert.equal(first.pairs[1].translation, `[es] ${first.pairs[1].original}`);
      const n = calls.translate;
      const again = (await s.call("POST", `/api/links/${link.id}/translate`, { lang: "es", offset: 0, limit: 3 })).body;
      assert.equal(calls.translate, n); assert.deepEqual(again.pairs, first.pairs);
      const stored = (await s.call("POST", `/api/links/${link.id}/translate`, { lang: "es", offset: 2, limit: 3, translate: false })).body;
      assert.equal(stored.missing, 2); assert.equal(calls.translate, n);
      assert.deepEqual((await s.call("GET", `/api/links/${link.id}/translations`)).body.languages, [{ lang: "es", paragraphs: 3 }]);
      assert.equal((await s.call("POST", `/api/links/${link.id}/translate`, { lang: "xx" })).status, 400);
    });

    await t.test("the extension's capture keeps the page as the browser showed it and reads documents", async () => {
      const html = `<html lang="es"><head><title>Privado</title></head><body><article><h1>Solo con sesión</h1>${"<p>Contenido que solo ve quien ha iniciado sesión en el sitio, con detalle suficiente para que sea el artículo.</p>".repeat(5)}</article></body></html>`;
      const page = await s.call("POST", "/api/capture", { url: "https://members.example.com/post/1", title: "Privado", html });
      assert.equal(page.status, 201); assert.equal(page.body.fetch_status, "ok"); assert.equal(page.body.source, "extension");
      assert.match(page.body.content_text, /solo ve quien ha iniciado sesión/); assert.match(page.body.reader_url, /fold=2/);
      await new Promise((r) => setTimeout(r, 300));
      assert.match(getLink(page.body.id).content_text, /solo ve quien ha iniciado sesión/, "no server fetch replaces it");
      const file = docx(["Informe", "Un párrafo del informe privado."], { title: "Informe privado" });
      const doc = await s.call("POST", "/api/capture", { url: "https://intranet.example.com/informe.docx", data_base64: file.toString("base64") });
      assert.equal(doc.body.kind, "document"); assert.equal(doc.body.title, "Informe privado");
      assert.equal((await s.call("POST", "/api/capture", { url: "https://x.example.com/" })).status, 400);
    });

    await t.test("a saved PDF link is fetched and read as text", async () => {
      const file = pdf([[[740, "Abstract", 16], [700, "A paper saved by its link is read as text."]], [[740, "Body", 16], [700, "Its second page."]]], { title: "Saved paper" });
      const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end(file); });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const saved = await s.call("POST", "/api/links", { url: `http://127.0.0.1:${server.address().port}/paper.pdf` });
        const fetched = await waitFetched(s, saved.body.id);
        assert.equal(fetched.fetch_status, "ok"); assert.equal(fetched.kind, "pdf"); assert.equal(fetched.title, "Saved paper");
        assert.equal(fetched.content_text, "Abstract\nA paper saved by its link is read as text.\nBody\nIts second page.");
      } finally { await new Promise((r) => server.close(r)); }
    });

    await t.test("real stdio MCP: fold_link, fold_read and translate_link", async () => {
      client = new Client({ name: "fold-qa", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))],
        env: { ...process.env, LINKS_URL: s.base, LINKS_TOKEN_FILE: path.join(s.dataDir, "mcp-token") } }));
      const names = (await client.listTools()).tools.map((x) => x.name);
      for (const n of ["fold_link", "fold_read", "translate_link"]) assert.ok(names.includes(n), n);
      const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
      assert.equal((await call("fold_link", { url: "https://example.com/fold-article", wait_s: 10 })).status, "done");
      const themes = await call("fold_read", { id: link.id, level: "theme" });
      assert.match(themes.text, /Tema B/);
      const full = await call("fold_read", { id: link.id, level: 1, section: "s2" });
      assert.match(full.text, /^## s2 · 2 Method/); assert.match(full.text, /\[¶\d+\] Method paragraph 1/);
      const pairs = await call("translate_link", { id: link.id, lang: "es", limit: 2 });
      assert.equal(pairs.pairs.length, 2); assert.ok(pairs.pairs.every((p) => p.translation.startsWith("[es] ")));
    });
  } finally {
    if (client) await client.close();
    await s.stop();
    await new Promise((resolve) => hub.close(resolve));
    if (oldHub === undefined) delete process.env.HOARD_HUB_URL; else process.env.HOARD_HUB_URL = oldHub;
  }
});
