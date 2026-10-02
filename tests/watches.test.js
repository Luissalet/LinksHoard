// Watches: feed/Atom parsing, GitHub feeds, page diffs, the baseline first
// check, auto-saved links, the tools and the events on the family bus.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer } from "./helpers.js";
import { parseFeed, discoverFeeds, githubFeed, diffLines, diffSummary } from "../server/hoard-commons/web.js";
import * as family from "../server/hoard-link.js";

const RSS = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title>
${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.guid || i.link}</guid><pubDate>Wed, 24 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>${i.desc || "desc"}</p>]]></description></item>`).join("")}
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from repo</title>
<entry><id>tag:github.com,2008:Repository/1/v1.2.0</id><updated>2026-09-24T09:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.2.0"/><title>v1.2.0</title><content type="html">&lt;p&gt;Fixes &amp; features&lt;/p&gt;</content></entry>
</feed>`;

test("the shared feed parser, feed discovery, GitHub feeds and diffs behave as the watches need", () => {
  const rss = parseFeed(RSS([{ title: "One", link: "https://ex.com/1" }, { title: "Two", link: "https://ex.com/2", desc: "second" }]));
  assert.equal(rss.title, "Fixture Feed");
  assert.deepEqual(rss.items.map((i) => i.title), ["One", "Two"]);
  assert.equal(rss.items[1].summary, "second");
  assert.match(rss.items[0].published, /^2026-09-24T10:00:00/);
  const atom = parseFeed(ATOM);
  assert.equal(atom.title, "Release notes from repo");
  assert.equal(atom.items[0].link, "https://github.com/o/r/releases/tag/v1.2.0");
  assert.equal(atom.items[0].summary, "Fixes & features");
  assert.equal(parseFeed("<html><body>no</body></html>"), null);
  assert.equal(discoverFeeds('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>', "https://ex.com/blog/")[0].url, "https://ex.com/feed.xml");
  assert.deepEqual(githubFeed("https://github.com/anomalyco/opencode"), { repo: "anomalyco/opencode", url: "https://github.com/anomalyco/opencode/releases.atom", what: "releases", name: "anomalyco/opencode releases" });
  assert.equal(githubFeed("https://github.com/o/r/commits/main").what, "commits");
  assert.equal(githubFeed("https://example.com/x"), null);
  const [added, removed] = diffLines("a\nb\nc", "a\nc\nd\ne");
  assert.deepEqual([added, removed], [["d", "e"], ["b"]]);
  assert.match(diffSummary(added, removed), /\+ d\n\+ e\n- 1 line\(s\) removed: b/);
});

let s, feedServer, feedItems, page, pageText, events;
const requests = [];
let tick = 0;
// enough distinct text to be a document for the shared page comparison (it ignores pages of fewer than 40 words)
const BODY = [
  "The service status page lists every component with its current state and the maintenance windows planned for the next quarter.",
  "Subscribers receive an email whenever an incident is opened, updated or resolved, and the history keeps the last ninety days.",
  "Operators are reachable through the usual support channels; an escalation path is described for the customers of the business plan.",
].map((t) => `<p>${t}</p>`).join("");
const PAGE = (text, volatile = "") => `<!doctype html><html><head><title>Status page</title></head><body><main><article><h1>Status page</h1><p>${text}</p>${BODY}${volatile ? `<p>${volatile}</p>` : ""}</article></main></body></html>`;
before(async () => {
  s = await bootServer();
  feedItems = [{ title: "One", link: "https://ex.com/1" }];
  pageText = "Version 1.0 is out. Nothing else.";
  feedServer = http.createServer((req, res) => {
    requests.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] || "", ifModifiedSince: req.headers["if-modified-since"] || "" });
    if (req.url.startsWith("/feed")) { res.writeHead(200, { "Content-Type": "application/rss+xml" }); return res.end(RSS(feedItems)); }
    if (req.url.startsWith("/blog")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>blog</body></html>`); }
    if (req.url.startsWith("/cloudflare")) {
      res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
      return res.end("<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. challenges.cloudflare.com</body></html>");
    }
    if (req.url.startsWith("/short")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><head><title>Tiny</title></head><body><p>Version 1</p></body></html>"); }
    if (req.url.startsWith("/etag")) {
      if (req.headers["if-none-match"] === '"v1"') { res.writeHead(304, { ETag: '"v1"' }); return res.end(); }
      res.writeHead(200, { "Content-Type": "text/html", ETag: '"v1"', "Last-Modified": "Wed, 30 Sep 2026 10:00:00 GMT" });
      return res.end(PAGE("Stable page content for the validator test."));
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE(pageText, `Last checked at 10:${String(10 + (++tick % 40)).padStart(2, "0")}:17 (${tick} minutes ago)`));
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

test("an unchanged page answers 304: the validators are sent back and nothing counts as a change", async () => {
  const add = await s.call("POST", "/api/watches", { url: `${page}/etag`, auto_save: false, every_min: 5 });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const wid = add.body.watch.id;
  requests.length = 0;
  const check = await s.call("POST", `/api/watches/${wid}/check`);
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.ok, true);
  assert.deepEqual(check.body.new_items, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ifNoneMatch, '"v1"', "the stored ETag goes back as If-None-Match");
  assert.match(requests[0].ifModifiedSince, /30 Sep 2026/);
  const stored = (await import("../server/db.js")).db().prepare("SELECT last_etag, last_modified FROM watches WHERE id = ?").get(wid);
  assert.equal(stored.last_etag, '"v1"');
  assert.equal((await s.call("GET", "/api/watches")).body.watches.find((w) => w.id === wid).last_error, "");
  await s.agent("watch_remove", { watch_id: wid });
});

test("a Cloudflare challenge is an error, never a change, and the stored text is kept", async () => {
  const db = (await import("../server/db.js")).db();
  const add = await s.call("POST", "/api/watches", { url: `${page}/status2`, kind: "page", auto_save: false });
  const wid = add.body.watch.id;
  const before = db.prepare("SELECT last_hash, last_text FROM watches WHERE id = ?").get(wid);
  assert.ok(before.last_hash);
  db.prepare("UPDATE watches SET url = ? WHERE id = ?").run(`${page}/cloudflare`, wid);
  const check = await s.call("POST", `/api/watches/${wid}/check`);
  assert.equal(check.body.ok, false);
  assert.match(check.body.error, /blocked: Cloudflare/);
  assert.deepEqual(check.body.new_items, []);
  assert.deepEqual(db.prepare("SELECT last_hash, last_text FROM watches WHERE id = ?").get(wid), before);
  assert.match(db.prepare("SELECT last_error FROM watches WHERE id = ?").get(wid).last_error, /blocked/);
  await s.agent("watch_remove", { watch_id: wid });
});

test("a page with too little text says so instead of comparing nothing", async () => {
  const add = await s.call("POST", "/api/watches", { url: `${page}/short`, kind: "page", auto_save: false });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.match(add.body.first_check.error, /too short/);
  await s.agent("watch_remove", { watch_id: add.body.watch.id });
});

test("a watch compared by the previous extractor starts over silently", async () => {
  const db = (await import("../server/db.js")).db();
  const add = await s.call("POST", "/api/watches", { url: `${page}/status3`, kind: "page", auto_save: false });
  const wid = add.body.watch.id;
  // what an old database holds: a hash and a text made by the old extractor, no engine marker
  db.prepare("UPDATE watches SET last_hash = 'old-hash', last_text = 'old text', check_engine = 0 WHERE id = ?").run(wid);
  const check = await s.call("POST", `/api/watches/${wid}/check`);
  assert.equal(check.body.ok, true);
  assert.deepEqual(check.body.new_items, [], "no false change after the upgrade");
  assert.equal(db.prepare("SELECT check_engine FROM watches WHERE id = ?").get(wid).check_engine, 1);
  assert.notEqual(db.prepare("SELECT last_hash FROM watches WHERE id = ?").get(wid).last_hash, "old-hash");
  await s.agent("watch_remove", { watch_id: wid });
});

test("a private address is refused without the opt-in, and the error says why", async () => {
  process.env.LINKS_ALLOW_PRIVATE_URLS = "0";
  try {
    const refused = await s.agent("watch_add", { url: `${page}/status`, kind: "page" });
    assert.equal(refused.status, 200); // the watch is created, its first check fails and says why
    assert.equal(refused.body.last_error, "address 127.0.0.1 is a loopback address");
    assert.equal(refused.body.first_check_error, refused.body.last_error);
    await s.agent("watch_remove", { watch_id: refused.body.id });
  } finally {
    process.env.LINKS_ALLOW_PRIVATE_URLS = "1";
  }
});

test("a public address is read through the family hub when it is there, with the stored validators", async () => {
  const calls = [];
  const hub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/web/status") return res.end(JSON.stringify({ ok: true, enabled: true }));
      if (req.url === "/api/web/fetch") {
        const payload = JSON.parse(body);
        calls.push(payload);
        const text = RSS([{ title: "Via the hub", link: "https://news.example.com/1" }]);
        return res.end(JSON.stringify({ ok: true, status: 200, tier: "http", final_url: payload.url, content_type: "application/rss+xml", text, etag: '"hub-1"' }));
      }
      res.end("{}");
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  family.configure({ app: "links", dataDir: s.dataDir, hub: `http://127.0.0.1:${hub.address().port}` });
  const { webForgetAvailability } = await import("../server/hoard-commons/fam-web.js");
  webForgetAvailability();
  process.env.LINKS_ALLOW_PRIVATE_URLS = "0";
  try {
    const add = await s.agent("watch_add", { url: "https://news.example.com/feed.xml", kind: "feed", auto_save: false });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal(add.body.name, "Fixture Feed");
    assert.equal(add.body.baseline_items, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://news.example.com/feed.xml");
    assert.equal(calls[0].respect_robots, false, "a feed the person asked for is not held back by robots.txt");
    const again = await s.agent("watch_check", { watch_id: add.body.id });
    assert.equal(again.status, 200);
    assert.equal(calls[1].etag, '"hub-1"', "the ETag the hub reported goes back on the next check");
    await s.agent("watch_remove", { watch_id: add.body.id });
  } finally {
    process.env.LINKS_ALLOW_PRIVATE_URLS = "1";
    family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
    webForgetAvailability();
    await new Promise((r) => hub.close(r));
  }
});
