// Watches: feed/Atom parsing, GitHub feeds, page diffs, the baseline first
// check, auto-saved links, the tools and the events on the family bus.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer } from "./helpers.js";
import { parseFeed, discoverFeed, githubFeed, diffSummary } from "../server/watches.js";
import * as family from "../server/hoard-link.js";

const RSS = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title>
${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.guid || i.link}</guid><pubDate>Wed, 24 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>${i.desc || "desc"}</p>]]></description></item>`).join("")}
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from repo</title>
<entry><id>tag:github.com,2008:Repository/1/v1.2.0</id><updated>2026-09-24T09:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.2.0"/><title>v1.2.0</title><content type="html">&lt;p&gt;Fixes &amp; features&lt;/p&gt;</content></entry>
</feed>`;

test("parseFeed handles RSS and Atom, rejects HTML", () => {
  const rss = parseFeed(RSS([{ title: "One", link: "https://ex.com/1" }, { title: "Two", link: "https://ex.com/2", desc: "second" }]));
  assert.equal(rss.title, "Fixture Feed");
  assert.deepEqual(rss.items.map((i) => i.title), ["One", "Two"]);
  assert.equal(rss.items[1].summary, "second");
  assert.match(rss.items[0].published_at, /^2026-09-24T10:00:00/);
  const atom = parseFeed(ATOM);
  assert.equal(atom.title, "Release notes from repo");
  assert.equal(atom.items[0].url, "https://github.com/o/r/releases/tag/v1.2.0");
  assert.equal(atom.items[0].summary, "Fixes & features");
  assert.equal(parseFeed("<html><body>no</body></html>"), null);
  assert.equal(discoverFeed('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>', "https://ex.com/blog/"), "https://ex.com/feed.xml");
  assert.deepEqual(githubFeed("https://github.com/anomalyco/opencode"), { repo: "anomalyco/opencode", url: "https://github.com/anomalyco/opencode/releases.atom", what: "releases" });
  assert.equal(githubFeed("https://github.com/o/r/commits/main").what, "commits");
  assert.equal(githubFeed("https://example.com/x"), null);
  const d = diffSummary("a\nb\nc", "a\nc\nd\ne");
  assert.equal(d.added, 2); assert.equal(d.removed, 1); assert.match(d.summary, /\+ d \| e/);
});

let s, feedServer, feedItems, page, pageText, events;
before(async () => {
  s = await bootServer();
  feedItems = [{ title: "One", link: "https://ex.com/1" }];
  pageText = "Version 1.0 is out. Nothing else.";
  feedServer = http.createServer((req, res) => {
    if (req.url.startsWith("/feed")) { res.writeHead(200, { "Content-Type": "application/rss+xml" }); return res.end(RSS(feedItems)); }
    if (req.url.startsWith("/blog")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>blog</body></html>`); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><title>Status page</title></head><body><main><article><h1>Status page</h1><p>${pageText}</p>${"<p>Filler paragraph to look like content for the extractor, long enough to be kept as body text by the fallback path.</p>".repeat(4)}</article></main></body></html>`);
  });
  await new Promise((r) => feedServer.listen(0, "127.0.0.1", r));
  page = `http://127.0.0.1:${feedServer.address().port}`;
  // capture what the app would post to the hub
  events = [];
  const origEmit = family.emit;
  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  globalThis.__origEmit = origEmit;
});
after(async () => {
  await s.stop();
  await new Promise((r) => feedServer.close(r));
});

test("a feed watch: baseline first, then new entries become items and links", async () => {
  const add = await s.agent("watch_add", { url: `${page}/feed.xml`, tags: ["news"], every_min: 5 });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.kind, "feed");
  assert.equal(add.body.name, "Fixture Feed");
  assert.equal(add.body.baseline_items, 1);
  const id = add.body.id;
  // baseline items are dismissed: nothing "new"
  let items = await s.agent("watch_items", {});
  assert.deepEqual(items.body.items, []);
  const again = await s.agent("watch_add", { url: `${page}/feed.xml` });
  assert.equal(again.body.existing, true);
  feedItems.push({ title: "Two", link: `${page}/article-2`, desc: "the second" });
  const check = await s.agent("watch_check", { watch_id: id });
  assert.equal(check.status, 200);
  assert.equal(check.body.new_items.length, 1);
  assert.equal(check.body.new_items[0].title, "Two");
  assert.ok(check.body.new_items[0].link_id, "auto_save made a link");
  items = await s.agent("watch_items", {});
  assert.equal(items.body.items.length, 1);
  assert.equal(items.body.items[0].summary, "the second");
  const link = await s.call("GET", `/api/links/${items.body.items[0].link_id}`);
  assert.equal(link.status, 200);
  assert.deepEqual(link.body.tags, ["news"]);
  assert.equal(link.body.source, "watch");
  assert.equal(link.body.notes, "Vía Fixture Feed");
  // a second check finds nothing new
  const check2 = await s.agent("watch_check", { watch_id: id });
  assert.equal(check2.body.new_items.length, 0);
  const dismissed = await s.agent("watch_dismiss", { item_id: items.body.items[0].id });
  assert.equal(dismissed.body.dismissed, true);
  assert.deepEqual((await s.agent("watch_items", {})).body.items, []);
  assert.equal((await s.agent("watch_items", { unread: false })).body.items.length, 2);
  const list = await s.agent("watch_list", {});
  assert.equal(list.body.watches[0].item_count, 2);
  assert.equal(list.body.stats.watches, 1);
});

test("a page that advertises a feed becomes a feed watch; a plain page is diffed", async () => {
  const viaBlog = await s.call("POST", "/api/watches", { url: `${page}/blog` });
  assert.equal(viaBlog.status, 200, JSON.stringify(viaBlog.body)); // same feed as before → existing
  assert.equal(viaBlog.body.existing, true);
  const plain = await s.call("POST", "/api/watches", { url: `${page}/status`, auto_save: false, every_min: 5 });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.watch.kind, "page");
  assert.equal(plain.body.watch.name, "Status page");
  const wid = plain.body.watch.id;
  let check = await s.call("POST", `/api/watches/${wid}/check`);
  assert.equal(check.body.new_items.length, 0);
  pageText = "Version 2.0 is out. Nothing else.";
  check = await s.call("POST", `/api/watches/${wid}/check`);
  assert.equal(check.body.new_items.length, 1);
  const items = await s.call("GET", `/api/watch-items?watch_id=${wid}`);
  assert.match(items.body.items[0].summary, /Version 2\.0/);
  assert.equal(items.body.items[0].link_id, null); // auto_save off
  // update + remove
  const upd = await s.call("PATCH", `/api/watches/${wid}`, { enabled: false, name: "Status" });
  assert.equal(upd.body.enabled, false);
  assert.equal(upd.body.name, "Status");
  const gone = await s.agent("watch_remove", { watch_id: wid });
  assert.equal(gone.body.ok, true);
  assert.equal((await s.call("GET", `/api/watch-items?watch_id=${wid}`)).body.items.length, 0); // cascade
  assert.equal((await s.call("POST", `/api/watches/${wid}/check`)).status, 404);
});

test("bad inputs and a GitHub repository", async () => {
  assert.equal((await s.agent("watch_add", { url: "not a url" })).status, 400);
  assert.equal((await s.agent("watch_add", { url: "https://example.com", kind: "github" })).status, 400);
  const state = await s.call("GET", "/api/state");
  assert.equal(typeof state.body.watches.watches, "number");
});
