// Every MCP/agent tool description must stay under 1000 characters so the
// Descriptions above 750 characters exceed the conservative chars/3 budget;
// the target-tool assertion below enforces the 250-token threshold directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../server/agent-tools.js";

const MAX_DESCRIPTION_CHARS = 1000;

test("every agent/MCP tool description is at most 1000 characters", () => {
  assert.ok(TOOLS.length > 0, "TOOLS is non-empty");
  const oversized = TOOLS
    .filter((t) => (t.description || "").length > MAX_DESCRIPTION_CHARS)
    .map((t) => `${t.name}:${t.description.length}`);
  assert.deepEqual(oversized, [], `oversized descriptions: ${oversized.join(", ")}`);
});

test("media_download stays under the Faustus 250-token description budget", () => {
  const dl = TOOLS.find((t) => t.name === "media_download");
  assert.ok(dl, "media_download present");
  const chars = dl.description.length;
  const tokens = Math.ceil(chars / 3);
  assert.ok(chars <= 750, `media_download ${chars} chars (>750 ≈ 250 tokens)`);
  assert.ok(tokens <= 250, `media_download ~${tokens} tokens`);
  assert.match(dl.description, /descárgame esto/);
  assert.match(dl.description, /not save_link/);
  const firstLine = dl.description.split("\n")[0];
  assert.ok(firstLine.length <= 110, "first line fits the retrieval index");
  assert.match(firstLine, /descargar/);
  assert.match(firstLine, /bájame/);
  for (const phrase of ["descarga este vídeo", "sácame el audio", "pásalo a mp3", "descargar de YouTube", "descargar tweet", "bajar música", "guardar el vídeo en el disco"]) {
    assert.ok(dl.description.includes(phrase), `Spanish retrieval phrase retained: ${phrase}`);
  }
});
