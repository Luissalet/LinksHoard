import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { bootServer } from "./helpers.js";
import { createLink, getLink } from "../server/links.js";
import { importTranscript, isYouTube, vttText } from "../server/transcript.js";

const VTT = `WEBVTT

00:00:00.000 --> 00:00:01.000
El satélite

00:00:01.000 --> 00:00:02.000
El satélite mide nubes

00:00:02.000 --> 00:00:03.000
El satélite mide nubes

00:00:03.000 --> 00:00:04.000
desde la órbita.
`;

test("transcript parser merges repeated rolling captions", () => {
  assert.equal(vttText(VTT), "El satélite mide nubes desde la órbita.");
  assert.equal(isYouTube("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(isYouTube("https://youtube.com.evil.test/watch?v=abc"), false);
});

test("imported captions reach saved link, search, reading and quotes", async () => {
  const s = await bootServer();
  try {
    const { link } = createLink({ url: "https://www.youtube.com/watch?v=fixture", source: "manual" });
    const result = await importTranscript(link, async (args) => {
      assert.ok(args.includes("--skip-download"));
      const output = args[args.indexOf("--output") + 1];
      await fs.writeFile(path.join(path.dirname(output), "captions.es.vtt"), VTT, "utf8");
    });
    assert.equal(result.language, "es");
    assert.equal(result.word_count, 7);
    assert.equal(getLink(link.id).kind, "video");
    assert.equal(getLink(link.id).content_text, "El satélite mide nubes desde la órbita.");
    const read = await s.agent("read_link", { id: link.id });
    assert.equal(read.body.text, getLink(link.id).content_text);
    const search = await s.agent("search_links", { q: "satélite" });
    assert.equal(search.body.total, 1);
    const quote = await s.agent("add_highlight", { id: link.id, text: "mide nubes", note: "dato" });
    assert.equal(quote.status, 200);

    const other = createLink({ url: "https://youtu.be/without-captions", source: "manual" }).link;
    await assert.rejects(importTranscript(other, async () => {}), /no ofrece subtítulos/);
    assert.equal(getLink(other.id).content_text, "");
  } finally { await s.stop(); }
});
