import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bootServer, waitFetched, serveText, FIXTURE_ARTICLE } from "./helpers.js";
import { TOOLS } from "../server/agent-tools.js";

const EXPECTED = ["save_link", "list_links", "search_links", "read_link", "tag_link", "mark_link", "add_highlight", "link_digest", "refetch_link", "delete_link", "list_tags"];

let s, fixture;
before(async () => {
  s = await bootServer();
  fixture = await serveText(FIXTURE_ARTICLE);
});
after(async () => {
  await s.stop();
  await fixture.close();
});

test("tool list is public and complete, with Spanish synonyms", async () => {
  const r = await s.call("GET", "/api/agent/tools");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tools.map((t) => t.name), EXPECTED);
  assert.ok(r.body.instructions.length > 100);
  for (const t of r.body.tools) {
    assert.match(t.description, /\nSinónimos: /, `${t.name} has a Sinónimos line`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === "boolean");
  }
  assert.equal(r.body.tools.find((t) => t.name === "delete_link").annotations.destructiveHint, true);
  assert.equal(TOOLS.length, EXPECTED.length);
});

test("agent/call requires the bearer token from the data dir", async () => {
  assert.equal((await s.call("POST", "/api/agent/call", { name: "list_links", arguments: {} })).status, 401);
  assert.equal((await s.call("POST", "/api/agent/call", { name: "list_links", arguments: {} }, { Authorization: "Bearer nope" })).status, 401);
  const token = fs.readFileSync(path.join(s.dataDir, "mcp-token"), "utf8").trim();
  assert.equal(token, s.token);
  assert.equal(token.length, 64);
  const ok = await s.call("POST", "/api/agent/call", { name: "list_links", arguments: {} }, { Authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.equal((await s.agent("nope", {})).status, 404);
});

let linkId;
test("save_link waits for the fetch and reports the real title", async () => {
  const r = await s.agent("save_link", { url: fixture.url, tags: ["ia"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.existing, false);
  assert.equal(r.body.fetch_status, "ok");
  assert.equal(r.body.title, "The Real Article Title");
  linkId = r.body.id;
});

test("save_link is idempotent", async () => {
  const again = await s.agent("save_link", { url: `${fixture.url}?utm_source=x` });
  assert.equal(again.body.existing, true);
  assert.equal(again.body.id, linkId);
});

test("list_links and search_links", async () => {
  const listed = await s.agent("list_links", { state: "all" });
  assert.equal(listed.body.total, 1);
  const found = await s.agent("search_links", { q: "readability" });
  assert.equal(found.body.total, 1);
  const missed = await s.agent("search_links", { q: "zzz_no_match_zzz" });
  assert.equal(missed.body.total, 0);
});

test("read_link paginates by characters and never trusts the title", async () => {
  const first = await s.agent("read_link", { id: linkId, max_chars: 200 });
  assert.equal(first.status, 200);
  assert.equal(first.body.text.length, 200);
  assert.equal(first.body.has_more, true);
  const rest = await s.agent("read_link", { id: linkId, offset: 200, max_chars: 20000 });
  assert.equal(rest.body.has_more, false);
  assert.equal(first.body.total_chars, rest.body.total_chars);
  assert.equal(first.body.text.length + rest.body.text.length, rest.body.total_chars);
  const byUrl = await s.agent("read_link", { url: fixture.url, max_chars: 200 });
  assert.equal(byUrl.body.id, linkId);
  const missing = await s.agent("read_link", { id: "nope" });
  assert.equal(missing.status, 400);
});

test("tag_link adds and removes", async () => {
  const added = await s.agent("tag_link", { id: linkId, add: ["favorita", "leer-luego"] });
  assert.deepEqual(added.body.tags.sort(), ["favorita", "ia", "leer-luego"].sort());
  const removed = await s.agent("tag_link", { id: linkId, remove: ["favorita"] });
  assert.ok(!removed.body.tags.includes("favorita"));
});

test("mark_link toggles read/archived/favorite", async () => {
  const read = await s.agent("mark_link", { id: linkId, state: "read" });
  assert.ok(read.body.read_at);
  const unread = await s.agent("mark_link", { id: linkId, state: "unread" });
  assert.equal(unread.body.read_at, null);
  const archived = await s.agent("mark_link", { id: linkId, state: "archived" });
  assert.equal(archived.body.archived, true);
  await s.agent("mark_link", { id: linkId, state: "archived", on: false });
  const fav = await s.agent("mark_link", { id: linkId, state: "favorite" });
  assert.equal(fav.body.favorite, true);
});

test("add_highlight stores a quote with a note", async () => {
  const h = await s.agent("add_highlight", { id: linkId, text: "fixture body text", note: "great line" });
  assert.equal(h.status, 200);
  assert.equal(h.body.note, "great line");
  const read = await s.agent("read_link", { id: linkId, max_chars: 200 });
  assert.equal(read.body.highlights.length, 1);
});

test("link_digest groups by site", async () => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const digest = await s.agent("link_digest", { since });
  assert.equal(digest.status, 200);
  assert.equal(digest.body.total, 1);
  assert.equal(digest.body.sites[0].links[0].id, linkId);
});

test("list_tags returns counts", async () => {
  const tags = await s.agent("list_tags", {});
  assert.ok(tags.body.tags.some((t) => t.tag === "ia"));
});

test("refetch_link re-downloads", async () => {
  const r = await s.agent("refetch_link", { id: linkId });
  assert.equal(r.status, 200);
  assert.equal(r.body.fetch_status, "ok");
});

test("delete_link is irreversible and reports 400/404 style resolution errors otherwise", async () => {
  const badRef = await s.agent("read_link", {});
  assert.equal(badRef.status, 400);
  const del = await s.agent("delete_link", { id: linkId });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted.id, linkId);
  const again = await s.agent("delete_link", { id: linkId });
  assert.equal(again.status, 400);
});
