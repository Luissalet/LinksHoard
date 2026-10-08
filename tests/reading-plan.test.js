import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { selectReadingPlan } from "../server/reading-plan.js";
import { bootServer } from "./helpers.js";
import { db, setSetting, getSetting } from "../server/db.js";
import { createLink, applyFetchResult, updateLink, markRead } from "../server/links.js";

const item = (id, duration, extra = {}) => ({ id, url: `https://example.com/${id}`, title: id,
  site: "example.com", word_count: duration * 200, kind: "article", saved_at: "2026-09-01T12:00:00Z",
  favorite: false, tags: [], fetch_status: "ok", has_text: true, ...extra });

test("a combination fills the budget better than the single longest or favourite text", () => {
  const rows = [item("long", 10, { favorite: true }), item("nine", 9), item("seven", 7)];
  const out = selectReadingPlan(rows, { minutes: 16 });
  assert.deepEqual(out.items.map((r) => r.id), ["nine", "seven"]);
  assert.equal(out.estimated_minutes, 16);
  assert.equal(out.unused_minutes, 0);
  assert.equal(out.total_words, 3200);
  const one = selectReadingPlan(rows, { minutes: 16, max_items: 1 });
  assert.deepEqual(one.items.map((r) => r.id), ["long"]);
  assert.equal(one.estimated_minutes, 10);
  assert.deepEqual(selectReadingPlan([...rows].reverse(), { minutes: 16 }), out);
});

test("duration ties prefer favourites, fewer texts, then older entries", () => {
  const rows = [item("old", 10, { saved_at: "2026-08-01" }), item("new", 10),
    item("a", 5), item("b", 5)];
  assert.deepEqual(selectReadingPlan(rows, { minutes: 10 }).items.map((r) => r.id), ["old"]);
  rows[1].favorite = true;
  assert.deepEqual(selectReadingPlan(rows, { minutes: 10 }).items.map((r) => r.id), ["new"]);
  rows[2].favorite = true; rows[3].favorite = true;
  assert.deepEqual(selectReadingPlan(rows, { minutes: 10 }).items.map((r) => r.id), ["a", "b"]);
});

test("rounding is per complete text; a speed correction changes the selected plan", () => {
  const rows = [item("a", 1, { word_count: 201 }), item("b", 1, { word_count: 201 })];
  const slow = selectReadingPlan(rows, { minutes: 3 });
  assert.equal(slow.items.length, 1);
  assert.equal(slow.estimated_minutes, 2);
  const fast = selectReadingPlan(rows, { minutes: 3, words_per_minute: 300 });
  assert.equal(fast.items.length, 2);
  assert.equal(fast.estimated_minutes, 2);
  assert.equal(fast.total_words, 402);
});

test("exclude unknown lengths, unreadable text and non-text media; tags are literal", () => {
  const rows = [item("ok", 3, { tags: ["100%"], site: "example.org" }), item("other", 3),
    item("unknown", 0, { tags: ["100%"] }), item("failed", 3, { fetch_status: "failed", tags: ["100%"] }),
    item("blank", 3, { has_text: false, tags: ["100%"] }), item("video", 3, { kind: "video", tags: ["100%"] }),
    item("long", 20, { tags: ["100%"] }), item("read", 3, { read_at: "2026-10-01", tags: ["100%"] }),
    item("archived", 3, { archived: true, tags: ["100%"] })];
  const out = selectReadingPlan(rows, { minutes: 10, tag: "100%" });
  assert.equal(out.matching_unread, 6);
  assert.deepEqual(out.excluded, { unsupported_kind: 1, unavailable_text: 2, unknown_word_count: 1, over_budget: 1 });
  assert.deepEqual(out.items.map((r) => r.id), ["ok"]);
  assert.equal(selectReadingPlan(rows, { minutes: 10, tag: "100%", site: "EXAMPLE.ORG" }).matching_unread, 1);
  assert.equal(selectReadingPlan(rows, { minutes: 1 }).items.length, 0);
});

test("small exhaustive subsets independently verify optimal duration and the item cap", () => {
  for (const durations of [[2, 5, 6, 9], [1, 1, 3, 7], [4, 4, 4, 4]]) {
    const rows = durations.map((time, i) => item(String(i), time));
    for (const budget of [1, 6, 10, 16]) for (const cap of [1, 2, 4]) {
      let optimum = 0;
      for (let mask = 0; mask < 2 ** rows.length; mask++) {
        const chosen = durations.filter((_, i) => mask & (1 << i));
        const sum = chosen.reduce((a, b) => a + b, 0);
        if (chosen.length <= cap && sum <= budget) optimum = Math.max(optimum, sum);
      }
      const plan = selectReadingPlan(rows, { minutes: budget, max_items: cap });
      assert.equal(plan.estimated_minutes, optimum);
      assert.ok(plan.items.length <= cap);
      assert.equal(new Set(plan.items.map((r) => r.id)).size, plan.items.length);
    }
  }
});

test("HTTP and real stdio MCP read the current library without altering links or daily picks", async () => {
  process.env.LINKS_WATCHES = "0";
  process.env.LINKS_RESURFACE = "0";
  process.env.HOARD_EVENTS = "0";
  process.env.HOARD_HUB_AUTOSTART = "0";
  const s = await bootServer();
  let client;
  const add = (name, words) => {
    const link = createLink({ url: `https://example.com/${name}`, tags: ["ia"] }).link;
    applyFetchResult(link.id, { title: name, kind: "article", fetch_status: "ok", content_text: "saved words", word_count: words });
    return link.id;
  };
  try {
    const a = add("four", 800), b = add("nine", 1800), c = add("fourteen", 2800);
    add("unknown", 0);
    // A viable entry must survive a library larger than list_links' page limit.
    for (let i = 0; i < 205; i++) add(`over-budget-${i}`, 100000);
    setSetting("resurface_today", { sentinel: "unchanged" });
    const snapshot = () => JSON.stringify({ links: db().prepare("SELECT * FROM links ORDER BY id").all(),
      settings: db().prepare("SELECT * FROM settings ORDER BY key").all(),
      highlights: db().prepare("SELECT * FROM highlights ORDER BY id").all() });
    const before = snapshot();
    const first = await s.agent("reading_plan", { minutes: 20, tag: "ia" });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((r) => r.id).sort(), [a, c].sort());
    assert.equal(first.body.estimated_minutes, 18);
    assert.equal(first.body.excluded.unknown_word_count, 1);
    assert.equal(first.body.excluded.over_budget, 205);
    assert.equal(snapshot(), before);
    client = new Client({ name: "reading-plan-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))],
      env: { ...process.env, LINKS_URL: s.base, LINKS_TOKEN_FILE: path.join(s.dataDir, "mcp-token") } }));
    const catalogue = await client.listTools();
    const tool = catalogue.tools.find((t) => t.name === "reading_plan");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.ok(tool.inputSchema.required.includes("minutes"));
    const repeated = await client.callTool({ name: "reading_plan", arguments: { minutes: 20, tag: "ia" } });
    assert.equal(repeated.isError ?? false, false);
    assert.deepEqual(JSON.parse(repeated.content[0].text), first.body);
    assert.equal(snapshot(), before);
    const invalid = await s.agent("reading_plan", { minutes: 0 });
    assert.equal(invalid.status, 400);
    assert.equal(snapshot(), before);
    // Explicit fixture-user correction: read one text and favourite another.
    markRead(c, true); updateLink(b, { favorite: true });
    db().prepare("UPDATE links SET read_at = ? WHERE id = ?").run("2026-09-01T00:00:00Z", c);
    const repeatedRead = await s.agent("mark_link", { id: c, state: "read" });
    assert.equal(repeatedRead.body.read_at, "2026-09-01T00:00:00Z");
    const corrected = snapshot();
    const after = await s.agent("reading_plan", { minutes: 20, tag: "ia" });
    assert.deepEqual(after.body.items.map((r) => r.id), [b, a]);
    assert.equal(after.body.estimated_minutes, 13);
    assert.equal(snapshot(), corrected);
    assert.deepEqual(getSetting("resurface_today"), { sentinel: "unchanged" });
  } finally {
    if (client) await client.close();
    await s.stop();
  }
});
