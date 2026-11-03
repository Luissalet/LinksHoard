// Save a whole site or section: map_site / crawl_site / crawl_status against a local fixture site (no internet).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { bootServer } from "./helpers.js";
import { globToRegex, makeFilter, defaultPrefix, parseSitemapXml } from "../server/sitemap.js";

const page = (title, links = []) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><nav><a href="/">Home</a></nav>
<article><h1>${title}</h1>${`<p>Body text of ${title} that is long enough for the extractor to treat it as the main article content of the page. </p>`.repeat(6)}</article>
${links.map((l) => `<a href="${l}">link ${l}</a>`).join("\n")}</body></html>`;

let site, base, hits;
const sitemapXml = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

before(async () => {
  hits = [];
  site = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (body, type = "text/html; charset=utf-8", code = 200) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
    const path = req.url.split("?")[0];
    if (path === "/robots.txt") return send(`User-agent: *\nDisallow: /docs/private/\nSitemap: ${base}/sitemap_index.xml\n`, "text/plain");
    if (path === "/sitemap_index.xml") return send(`<sitemapindex><sitemap><loc>${base}/sm1.xml</loc></sitemap><sitemap><loc>${base}/sm2.xml.gz</loc></sitemap></sitemapindex>`, "application/xml");
    if (path === "/sm1.xml") return send(sitemapXml([`${base}/docs/a`, `${base}/docs/b`, `${base}/docs/private/x`, `${base}/other/z`]), "application/xml");
    if (path === "/sm2.xml.gz") { res.writeHead(200, { "Content-Type": "application/gzip" }); return res.end(zlib.gzipSync(sitemapXml([`${base}/docs/c`, `${base}/docs/a?utm_source=x`]))); }
    if (path === "/docs/" || path === "/docs") return send(page("Docs home", ["/docs/a", "/docs/e", "/docs/private/x", "https://example.com/away", "#top", "/docs/logo.png"]));
    if (path === "/docs/c") return send(page("Page C", ["/docs/d"]));
    if (["/docs/a", "/docs/b", "/docs/d", "/docs/e", "/other/z"].includes(path)) return send(page("Page " + path.split("/").pop().toUpperCase()));
    if (path === "/docs/private/x") return send(page("Private"));
    send("not found", "text/plain", 404);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => new Promise((r) => site.close(r)));

async function waitJob(s, id, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await s.call("GET", `/api/crawls/${id}`);
    if (!["queued", "running"].includes(body.status)) return body;
    if (Date.now() - t0 > timeoutMs) throw new Error("crawl timed out: " + JSON.stringify(body));
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("globs, prefix and sitemap parsing", () => {
  const f = makeFilter({ include: ["/docs/**"], exclude: ["*.pdf", "**/private/**"] });
  const u = (p) => `http://x.test${p}`;
  assert.ok(f(u("/docs/a/b")));
  assert.ok(!f(u("/other/a")));
  assert.ok(!f(u("/docs/private/x")));
  assert.ok(!f(u("/docs/file.pdf")));
  assert.ok(globToRegex("/a/*").re.test("/a/b") && !globToRegex("/a/*").re.test("/a/b/c"));
  assert.ok(makeFilter({ path_prefix: "/docs" })(u("/docs/x")) && !makeFilter({ path_prefix: "/docs" })(u("/doc")));
  assert.equal(defaultPrefix("http://x.test/3/howto/"), "/3/howto/");
  assert.equal(defaultPrefix("http://x.test/docs/intro.html"), "/docs/");
  assert.equal(defaultPrefix("http://x.test/"), "");
  const p = parseSitemapXml("<urlset><url><loc>http://a/1?x=1&amp;y=2</loc></url><url><loc><![CDATA[http://a/2]]></loc></url></urlset>");
  assert.deepEqual(p.locs, ["http://a/1?x=1&y=2", "http://a/2"]);
});

test("map_site finds sitemap index (gz), page links, honours robots, prefix and filters", async () => {
  const s = await bootServer();
  try {
    const r = await s.agent("map_site", { url: `${base}/docs/` });
    assert.equal(r.status, 200);
    const urls = r.body.urls.map((x) => x.url.replace(base, ""));
    assert.deepEqual(urls.sort(), ["/docs", "/docs/a", "/docs/b", "/docs/c", "/docs/e"].sort());
    assert.equal(r.body.blocked_by_robots, 1);
    assert.equal(r.body.sitemaps.length, 3);
    assert.equal(r.body.path_prefix, "/docs/");
    const e = r.body.urls.find((x) => x.url.endsWith("/docs/e"));
    assert.equal(e.source, "link");
    assert.equal(e.title, "link /docs/e");

    const whole = await s.call("POST", "/api/site/map", { url: `${base}/docs/`, path_prefix: "/" , exclude: ["/docs/**"] });
    assert.deepEqual(whole.body.urls.map((x) => x.url.replace(base, "")).sort(), ["", "/docs", "/other/z"]);
    const bad = await s.call("POST", "/api/site/map", { url: "not a url" });
    assert.equal(bad.status, 400);
  } finally { await s.stop(); }
});

test("crawl_site saves pages as normal links, deduplicates and reports progress", async () => {
  const s = await bootServer();
  try {
    await s.call("POST", "/api/links", { url: `${base}/docs/b`, tags: ["mine"] });
    const start = await s.agent("crawl_site", { url: `${base}/docs/`, depth: 2, delay_ms: 0, tags: ["docs"] });
    assert.equal(start.status, 200);
    const id = start.body.id;
    const job = await waitJob(s, id);
    assert.equal(job.status, "done");
    assert.equal(job.failed, 0);
    // saved: home, a, c, d (depth 2 via c), e ; skipped: b (already saved), private (robots)
    const list = await s.call("GET", "/api/links?state=all&limit=100");
    const paths = list.body.items.map((l) => l.url.replace(base, "")).sort();
    assert.deepEqual(paths, ["/docs", "/docs/a", "/docs/b", "/docs/c", "/docs/d", "/docs/e"].sort());
    assert.equal(job.saved, 5);
    const a = list.body.items.find((l) => l.url.endsWith("/docs/a"));
    assert.equal(a.fetch_status, "ok");
    assert.equal(a.title, "Page A");
    assert.ok(a.content_text.includes("Body text of Page A"));
    assert.ok(a.tags.includes("docs") && a.tags.includes(job.tag) && a.tags.some((t) => t.startsWith("site:")));
    const b = list.body.items.find((l) => l.url.endsWith("/docs/b"));
    assert.deepEqual(b.tags, ["mine"]); // an existing link is not touched
    assert.ok(!list.body.items.some((l) => l.url.includes("private")));
    const detail = await s.agent("crawl_status", { id });
    assert.ok(detail.body.results.some((x) => x.status === "robots"));
    assert.ok(detail.body.results.some((x) => x.status === "existing"));

    // idempotent: a second crawl saves nothing new
    const again = await waitJob(s, (await s.agent("crawl_site", { url: `${base}/docs/`, depth: 2, delay_ms: 0 })).body.id);
    assert.equal(again.saved, 0);
    const total = await s.call("GET", "/api/links?state=all&limit=100");
    assert.equal(total.body.total, 6);
    const jobs = await s.agent("crawl_status", {});
    assert.equal(jobs.body.crawls.length, 2);
  } finally { await s.stop(); }
});

test("crawl respects limit, explicit urls and include/exclude", async () => {
  const s = await bootServer();
  try {
    const limited = await waitJob(s, (await s.call("POST", "/api/crawls", { url: `${base}/docs/`, limit: 2, delay_ms: 0 })).body.id);
    assert.equal(limited.saved, 2);
    assert.equal((await s.call("GET", "/api/links?state=all")).body.total, 2);
    const explicit = await waitJob(s, (await s.call("POST", "/api/crawls", { urls: [`${base}/other/z`, `${base}/nope`], delay_ms: 0 })).body.id);
    assert.equal(explicit.saved, 1);
    assert.equal(explicit.failed, 1);
    assert.equal((await s.call("POST", "/api/crawls", {})).status, 400);
    await waitJob(s, (await s.call("POST", "/api/crawls", { url: `${base}/docs/`, exclude: ["/docs/a", "/docs/e"], include: ["/docs/*"], delay_ms: 0, limit: 20 })).body.id);
    const all = (await s.call("GET", "/api/links?state=all&limit=100")).body.items.map((l) => l.url.replace(base, ""));
    assert.ok(all.includes("/docs/b") && all.includes("/docs/c"));
    assert.ok(!all.includes("/docs/e"), "excluded pages are not saved unless an earlier crawl saved them");
  } finally { await s.stop(); }
});

test("a cancelled crawl can be resumed and only fetches the missing pages", async () => {
  const s = await bootServer();
  try {
    const slow = (await s.call("POST", "/api/crawls", { url: `${base}/docs/`, delay_ms: 400, concurrency: 1, limit: 20 })).body;
    await new Promise((r) => setTimeout(r, 900));
    await s.call("POST", `/api/crawls/${slow.id}/cancel`);
    const cancelled = await waitJob(s, slow.id);
    assert.equal(cancelled.status, "cancelled");
    const partial = (await s.call("GET", "/api/links?state=all&limit=100")).body.total;
    assert.ok(partial >= 1 && partial < 5, `partial ${partial}`);
    hits.length = 0;
    await s.agent("crawl_status", { id: slow.id, action: "resume" });
    const resumed = await waitJob(s, slow.id, 20_000);
    assert.equal(resumed.status, "done");
    assert.equal((await s.call("GET", "/api/links?state=all&limit=100")).body.total, 5);
    assert.equal(resumed.saved, 5 - partial);
    assert.equal((await s.call("GET", "/api/crawls/nope")).status, 404);
    assert.equal((await s.agent("crawl_status", { id: "nope" })).status, 400);
  } finally { await s.stop(); }
});
