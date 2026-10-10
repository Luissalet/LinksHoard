import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { articleSource } from "../server/article-source.js";
import { createLink, applyFetchResult, getLink } from "../server/links.js";
import { db } from "../server/db.js";
import { bootServer } from "./helpers.js";

test("source offsets preserve accents, duplicate paragraphs and CRLF without changing saved text", () => {
  const link = { id: "qa", content_text: "  Café 💡  \r\n\r\nCafé 💡\nFinal.  " };
  const source = articleSource(link);
  assert.equal(source.paragraphs.length, 3);
  assert.equal(new Set(source.paragraphs.map((p) => p.id)).size, 3);
  for (const p of source.paragraphs) assert.equal(link.content_text.slice(p.start, p.end), p.text);
  assert.deepEqual(articleSource(link), source);
  assert.notEqual(articleSource({ ...link, content_text: link.content_text + "x" }).version, source.version);
  assert.equal(articleSource({ id: "empty", content_text: " \n " }).paragraphs.length, 0);
});

test("questions and anchors use the normal HTTP and stdio MCP flows with verified quotes and explicit failure states", async (t) => {
  Object.assign(process.env, { LINKS_WATCHES: "0", LINKS_VIDEO_AUTO: "0", LINKS_MEDIA_AUTO_UPDATE: "0", HOARD_EVENTS: "0", HOARD_HUB_AUTOSTART: "0" });
  let mode = "valid", mutate = null, calls = 0, payload;
  const hub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url !== "/api/link/chat") { res.writeHead(404); res.end("{}"); return; }
      calls++; payload = JSON.parse(raw);
      const passages = JSON.parse(payload.messages[1].content).passages;
      const sentence = { text: "La apertura es en mayo.", citations: [{ paragraph_id: passages[0].paragraph_id, quote: "Abre en mayo" }] };
      let value = { sentences: [sentence] };
      if (mode === "partial") value.sentences.push({ text: "No comprobada", citations: [{ paragraph_id: "invented", quote: "invented" }] });
      if (mode === "false_quote") sentence.citations[0].quote = "Cierra en agosto";
      if (mode === "outside_context") sentence.citations[0].quote = "FIN FUERA";
      if (mode === "invalid") value = { sentences: [{ text: "Sin citas", citations: [] }] };
      if (mode === "unsupported") value = { sentences: [] };
      if (mutate) { mutate(); mutate = null; }
      res.writeHead(mode === "no_model" ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mode === "no_model" ? { ok: false, error: "no_model" }
        : { ok: true, json: value, model: "qa-cpu-simulation", provider: "fixture" }));
    });
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const oldHub = process.env.HOARD_HUB_URL;
  process.env.HOARD_HUB_URL = `http://127.0.0.1:${hub.address().port}`;
  const s = await bootServer();
  let client;
  const link = createLink({ url: "https://example.com/qa-article", tags: ["qa"] }).link;
  const text = "Abre en mayo y tendrá acceso gratuito.\n\nEl horario es de 10 a 18 horas.";
  const reset = () => applyFetchResult(link.id, { title: "QA artículo", kind: "article", fetch_status: "ok", content_text: text, word_count: 19 });
  reset();
  const snapshot = () => JSON.stringify({ links: db().prepare("SELECT * FROM links ORDER BY id").all(), highlights: db().prepare("SELECT * FROM highlights").all(), settings: db().prepare("SELECT * FROM settings ORDER BY key").all() });
  try {
    await t.test("HTTP result has exact offsets and every answer has a reader anchor; library unchanged", async () => {
      const before = snapshot();
      const { body: reader } = await s.call("GET", `/api/links/${link.id}`);
      const result = await s.call("POST", `/api/links/${link.id}/ask`, { question: "¿Cuándo abre?" });
      assert.equal(result.status, 200); assert.equal(result.body.status, "answered");
      assert.equal(result.body.source_version, reader.article_source.version);
      const citation = result.body.sentences[0].citations[0];
      assert.equal(text.slice(citation.start, citation.end), citation.quote);
      assert.equal(citation.reader_url, reader.article_source.paragraphs[0].reader_url);
      assert.equal(snapshot(), before);
      assert.equal(payload.capability, "llm"); assert.equal(payload.effort, "low");
    });
    await t.test("real stdio MCP catalogue, pagination, answer and annotations match HTTP", async () => {
      client = new Client({ name: "questions-qa", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))],
        env: { ...process.env, LINKS_URL: s.base, LINKS_TOKEN_FILE: path.join(s.dataDir, "mcp-token") } }));
      const catalogue = await client.listTools();
      const tool = catalogue.tools.find((r) => r.name === "ask_link");
      assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.idempotentHint, false);
      const before = snapshot();
      const paragraphs = JSON.parse((await client.callTool({ name: "read_link_paragraphs", arguments: { id: link.id, offset: 1, limit: 1 } })).content[0].text);
      assert.equal(paragraphs.paragraphs[0].text, "El horario es de 10 a 18 horas.");
      assert.equal(paragraphs.total_paragraphs, 2);
      const result = await client.callTool({ name: "ask_link", arguments: { url: link.url, question: "¿Cuándo abre?" } });
      assert.equal(result.isError ?? false, false);
      assert.equal(JSON.parse(result.content[0].text).status, "answered");
      assert.equal(snapshot(), before);
    });
    for (const [state, expected] of [["false_quote", "unsupported"], ["partial", "partial_answer"], ["invalid", "invalid_answer"], ["unsupported", "unsupported"], ["no_model", "no_model"]]) {
      await t.test(`model ${state} is visible without fabricated citations`, async () => {
        mode = state;
        const { body } = await s.agent("ask_link", { id: link.id, question: "¿Cuándo?" });
        assert.equal(body.status, expected);
        assert.equal(body.sentences.length, state === "partial" ? 1 : 0);
      });
    }
    await t.test("unavailable extraction and invalid inputs never call the model", async () => {
      applyFetchResult(link.id, { fetch_status: "pending" });
      const before = calls;
      assert.equal((await s.agent("ask_link", { id: link.id, question: "¿Cuándo?" })).body.status, "text_unavailable");
      assert.equal((await s.call("POST", `/api/links/${link.id}/ask`, { question: " " })).status, 400);
      assert.equal((await s.call("POST", "/api/links/missing/ask", { question: "¿Cuándo?" })).status, 404);
      assert.equal(calls, before); reset();
    });
    await t.test("content changed during the answer cannot use earlier anchors", async () => {
      mode = "valid"; mutate = () => applyFetchResult(link.id, { content_text: "Texto nuevo" });
      const { body } = await s.agent("ask_link", { id: link.id, question: "¿Cuándo?" });
      assert.equal(body.status, "source_changed"); assert.deepEqual(body.sentences, []); reset();
    });
    await t.test("long context is visibly partial and cannot cite the omitted end of a paragraph", async () => {
      mode = "outside_context";
      applyFetchResult(link.id, { content_text: "Abre en mayo " + "a".repeat(65000) + "FIN FUERA" });
      const { body } = await s.agent("ask_link", { id: link.id, question: "¿Cuándo?" });
      assert.equal(body.coverage.partial, true); assert.equal(body.coverage.included_chars, 60000);
      assert.equal(body.status, "unsupported"); assert.deepEqual(body.sentences, []);
      assert.ok(getLink(link.id).content_text.endsWith("FIN FUERA"));
    });
  } finally {
    if (client) await client.close();
    await s.stop();
    await new Promise((resolve) => hub.close(resolve));
    if (oldHub === undefined) delete process.env.HOARD_HUB_URL; else process.env.HOARD_HUB_URL = oldHub;
  }
});
