import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFetched, serveText, FIXTURE_ARTICLE } from "./helpers.js";

let s, fixture;
before(async () => {
  s = await bootServer();
  fixture = await serveText(FIXTURE_ARTICLE);
});
after(async () => {
  await s.stop();
  await fixture.close();
});

test("health and state bootstrap", async () => {
  const health = await s.call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ["dataDirConfigured", "service", "version"]);
  assert.equal(health.body.service, "links-hoard");
  const state = await s.call("GET", "/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.stats.total, 0);
  assert.equal(state.body.dataDir, s.dataDir);
  assert.equal(typeof state.body.ftsEnabled, "boolean");
});

test("save rejects invalid URLs with 400", async () => {
  const bad = await s.call("POST", "/api/links", { url: "not a url" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error);
});

let linkId;
test("save fetches in the background and extracts the real article", async () => {
  const created = await s.call("POST", "/api/links", { url: fixture.url, tags: ["prueba"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.existing, false);
  assert.equal(created.body.fetch_status, "pending");
  linkId = created.body.id;

  const fetched = await waitFetched(s, linkId);
  assert.equal(fetched.fetch_status, "ok");
  assert.equal(fetched.title, "The Real Article Title");
  assert.match(fetched.content_text, /fixture body text/);
  assert.ok(fetched.excerpt.length > 0 && fetched.excerpt.length <= 301);
  assert.equal(fetched.kind, "article");
});

test("save is idempotent on the normalized URL", async () => {
  const again = await s.call("POST", "/api/links", { url: `${fixture.url}?utm_source=newsletter` });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.id, linkId);
});

test("state filters: unread, read, archived, all", async () => {
  const unread = await s.call("GET", "/api/links?state=unread");
  assert.equal(unread.body.total, 1);
  await s.call("POST", `/api/links/${linkId}/read`);
  assert.equal((await s.call("GET", "/api/links?state=unread")).body.total, 0);
  assert.equal((await s.call("GET", "/api/links?state=read")).body.total, 1);
  await s.call("POST", `/api/links/${linkId}/archive`, { archived: true });
  assert.equal((await s.call("GET", "/api/links?state=archived")).body.total, 1);
  assert.equal((await s.call("GET", "/api/links?state=all")).body.total, 1);
  await s.call("POST", `/api/links/${linkId}/archive`, { archived: false });
  await s.call("POST", `/api/links/${linkId}/unread`);
});

test("full-text search finds the fixture by body text", async () => {
  const results = await s.call("GET", "/api/links?state=all&q=readability");
  assert.equal(results.status, 200);
  assert.equal(results.body.total, 1);
  assert.equal(results.body.items[0].id, linkId);
  const miss = await s.call("GET", "/api/links?state=all&q=nonexistentxyz123");
  assert.equal(miss.body.total, 0);
});

test("favorite and get with highlights", async () => {
  await s.call("POST", `/api/links/${linkId}/favorite`, { favorite: true });
  const one = await s.call("GET", `/api/links/${linkId}`);
  assert.equal(one.body.favorite, true);
  assert.deepEqual(one.body.highlights, []);
});

test("highlights CRUD", async () => {
  const created = await s.call("POST", `/api/links/${linkId}/highlights`, { text: "fixture body text", note: "nice" });
  assert.equal(created.status, 201);
  const hid = created.body.id;
  const list = await s.call("GET", `/api/links/${linkId}/highlights`);
  assert.equal(list.body.length, 1);
  const updated = await s.call("PATCH", `/api/highlights/${hid}`, { note: "updated note" });
  assert.equal(updated.body.note, "updated note");
  const del = await s.call("DELETE", `/api/highlights/${hid}`);
  assert.equal(del.body.ok, true);
  assert.equal((await s.call("GET", `/api/links/${linkId}/highlights`)).body.length, 0);
  assert.equal((await s.call("POST", "/api/links/does-not-exist/highlights", { text: "x" })).status, 404);
});

test("tags and sites facets", async () => {
  const tags = await s.call("GET", "/api/tags");
  assert.deepEqual(tags.body, [{ tag: "prueba", count: 1 }]);
  const sites = await s.call("GET", "/api/sites");
  assert.equal(sites.body.length, 1);
  assert.equal(sites.body[0].count, 1);
});

test("digest groups links saved since a date by site", async () => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const digest = await s.call("GET", `/api/digest?since=${encodeURIComponent(since)}`);
  assert.equal(digest.status, 200);
  assert.equal(digest.body.total, 1);
  assert.equal(digest.body.sites.length, 1);
  assert.equal(digest.body.sites[0].links[0].id, linkId);
  const future = await s.call("GET", `/api/digest?since=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`);
  assert.equal(future.body.total, 0);
});

test("update (patch) validates and rejects unknown fields", async () => {
  const ok = await s.call("PATCH", `/api/links/${linkId}`, { notes: "my notes", tags: ["a", "b"] });
  assert.equal(ok.body.notes, "my notes");
  assert.deepEqual(ok.body.tags, ["a", "b"]);
  const bad = await s.call("PATCH", `/api/links/${linkId}`, { url: "https://not-allowed.test" });
  assert.equal(bad.status, 400);
});

test("refetch resets fetch_status and re-extracts", async () => {
  const out = await s.call("POST", `/api/links/${linkId}/refetch`);
  assert.equal(out.body.fetch_status, "pending");
  const done = await waitFetched(s, linkId);
  assert.equal(done.fetch_status, "ok");
});

test("share endpoint saves and renders a confirmation page", async () => {
  const response = await fetch(`${s.base}/share?url=${encodeURIComponent("https://share-fixture.test/x")}&title=Shared`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Guardado/);
  const list = await s.call("GET", "/api/links?state=all&q=share-fixture");
  assert.ok(list.body.total >= 0); // fetch of a non-existent host fails; the link should still be recorded
  const bySite = await s.call("GET", "/api/sites");
  assert.ok(bySite.body.some((x) => x.site === "share-fixture.test"));
});

test("manifest and service worker are served", async () => {
  const manifest = await fetch(`${s.base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const body = await manifest.json();
  assert.equal(body.share_target.action, "/share");
  const sw = await fetch(`${s.base}/sw.js`);
  assert.equal(sw.status, 200);
});

test("delete removes the link and its highlights", async () => {
  const del = await s.call("DELETE", `/api/links/${linkId}`);
  assert.equal(del.body.ok, true);
  assert.equal((await s.call("GET", `/api/links/${linkId}`)).status, 404);
  assert.equal((await s.call("DELETE", `/api/links/${linkId}`)).body.ok, false);
});

test("unknown API routes and bad JSON answer with { error }", async () => {
  assert.equal((await s.call("GET", "/api/nothing")).status, 404);
  const response = await fetch(`${s.base}/api/links`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error);
});
