// Edge cases of map_site / crawl_site found in review: off-host redirects, binary pages, the skip cap, resume after a clean
// shutdown, sitemap budgets, sections deep in big sitemaps, responsive cancel under Crawl-delay, cancel/resume races,
// section prefixes and pages that serve "/dir" and "/dir/" alike. Every site here is a local fixture server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer } from "./helpers.js";
import { makeFilter } from "../server/sitemap.js";
import { shutdownCrawls, initCrawls } from "../server/sitecrawl.js";

const page = (title, links = []) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body>
<article><h1>${title}</h1>${`<p>Texto del cuerpo de ${title} lo bastante largo para que el extractor lo trate como el artículo principal. </p>`.repeat(6)}</article>
${links.map((l) => `<a href="${l}">enlace ${l}</a>`).join("\n")}</body></html>`;

/** A fixture site: handler(req, res, ctx) where ctx = { base, send }; returns { base, hits, close }. */
async function fixture(handler) {
  const hits = [];
  const ctx = {};
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (body, type = "text/html; charset=utf-8", code = 200) => { res.writeHead(code, { "Content-Type": type }); res.end(body); return true; };
    const path = req.url.split("?")[0];
    Promise.resolve(handler({ req, res, path, send, base: ctx.base }))
      .then((handled) => { if (handled === undefined && !res.headersSent) send("not found", "text/plain", 404); })
      .catch(() => { if (!res.headersSent) send("error", "text/plain", 500); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ctx.base = `http://127.0.0.1:${server.address().port}`;
  return { ctx, base: ctx.base, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJob(s, id, timeoutMs = 10_000, until = (b) => !["queued", "running"].includes(b.status)) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await s.call("GET", `/api/crawls/${id}`);
    if (until(body)) return body;
    if (Date.now() - t0 > timeoutMs) throw new Error("crawl timed out: " + JSON.stringify(body));
    await wait(40);
  }
}
const libraryPaths = async (s, base) => (await s.call("GET", "/api/links?state=all&limit=200")).body.items.map((l) => l.url.replace(base, "")).sort();

test("a page that redirects to another host is not saved (the crawl stays on the site)", async () => {
  const away = await fixture(({ path, send }) => (path === "/elsewhere" ? send(page("Otro sitio")) : undefined));
  const site = await fixture(({ path, send, res }) => {
    if (path === "/s" || path === "/s/") return send(page("Inicio S", ["/s/a", "/s/go"]));
    if (path === "/s/a") return send(page("Página A"));
    if (path === "/s/go") { res.writeHead(302, { Location: `${away.base}/elsewhere` }); res.end(); return true; }
  });
  const s = await bootServer();
  try {
    const job = await waitJob(s, (await s.call("POST", "/api/crawls", { url: `${site.base}/s/`, delay_ms: 0 })).body.id);
    assert.equal(job.status, "done");
    const all = (await s.call("GET", "/api/links?state=all&limit=50")).body.items.map((l) => l.url);
    assert.ok(!all.some((u) => u.startsWith(away.base)), `off-site page saved: ${all.join(", ")}`);
    assert.deepEqual(all.map((u) => u.replace(site.base, "")).sort(), ["/s", "/s/a"]);
    assert.ok(job.results.some((r) => r.url.endsWith("/s/go") && r.status === "offsite"));
  } finally { await s.stop(); await site.close(); await away.close(); }
});

test("PDF pages are saved (not failed) and legacy-encoded titles and file names survive", async () => {
  const site = await fixture(({ path, send, res }) => {
    if (path.endsWith(".pdf")) { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end(Buffer.from("%PDF-1.4\n%fixture\n")); return true; }
    if (path === "/latin") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(Buffer.from(page("Canción del año").replace('<meta charset="utf-8">', '<meta charset="iso-8859-1">'), "latin1"));
      return true;
    }
  });
  const s = await bootServer();
  try {
    const urls = [`${site.base}/f/manual.pdf`, `${site.base}/f/r%E9sum%E9.pdf`, `${site.base}/latin`];
    const job = await waitJob(s, (await s.call("POST", "/api/crawls", { urls, delay_ms: 0 })).body.id);
    assert.equal(job.failed, 0, JSON.stringify(job.results));
    assert.equal(job.saved, 3);
    const items = (await s.call("GET", "/api/links?state=all&limit=50")).body.items;
    const pdf = items.find((l) => l.url.endsWith("/manual.pdf"));
    assert.equal(pdf.kind, "pdf");
    assert.equal(pdf.title, "manual.pdf");
    assert.ok(items.find((l) => l.url.includes("sum")).title.length > 0);
    assert.equal(items.find((l) => l.url.endsWith("/latin")).title, "Canción del año");
  } finally { await s.stop(); await site.close(); }
});

test("pages already in the library do not use up the crawl's budget", async () => {
  const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const site = await fixture(({ path, send }) => {
    if (path === "/c" || path === "/c/") return send(page("Índice", names.map((n) => `/c/${n}`)));
    if (path.startsWith("/c/p")) return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    for (const p of ["/c", ...names.slice(0, 6).map((n) => `/c/${n}`)]) await s.call("POST", "/api/links", { url: site.base + p });
    const job = await waitJob(s, (await s.call("POST", "/api/crawls", { url: `${site.base}/c/`, limit: 1, delay_ms: 0 })).body.id);
    assert.equal(job.status, "done");
    assert.equal(job.saved, 1, JSON.stringify(job.results));
    assert.ok((await libraryPaths(s, site.base)).includes("/c/p7"));
  } finally { await s.stop(); await site.close(); }
});

test("a crawl stopped by a clean shutdown is continued at the next start", async () => {
  const names = ["a", "b", "c", "d", "e"];
  const site = await fixture(({ path, send }) => {
    if (path === "/r" || path === "/r/") return send(page("Raíz", names.map((n) => `/r/${n}`)));
    if (path.startsWith("/r/")) return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    const { id } = (await s.call("POST", "/api/crawls", { url: `${site.base}/r/`, delay_ms: 300, concurrency: 1 })).body;
    await waitJob(s, id, 5000, (b) => b.saved >= 1);
    await shutdownCrawls(); // what index.js does on SIGINT/SIGTERM before the database closes
    assert.equal((await s.call("GET", `/api/crawls/${id}`)).body.status, "interrupted");
    initCrawls(); // what createApp does at the next start
    const job = await waitJob(s, id, 15_000);
    assert.equal(job.status, "done");
    assert.deepEqual(await libraryPaths(s, site.base), ["/r", ...names.map((n) => `/r/${n}`)].sort());
  } finally { await s.stop(); await site.close(); }
});

test("a sitemap index full of dead children does not fetch them all", async () => {
  const site = await fixture(({ path, send, base }) => {
    if (path === "/robots.txt") return send(`User-agent: *\nAllow: /\nSitemap: ${base}/idx.xml\n`, "text/plain");
    if (path === "/idx.xml") return send(`<sitemapindex>${Array.from({ length: 200 }, (_, i) => `<sitemap><loc>${base}/missing-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`, "application/xml");
    if (path === "/") return send(page("Inicio"));
  });
  const s = await bootServer();
  try {
    const r = await s.call("POST", "/api/site/map", { url: `${site.base}/`, links: false });
    assert.equal(r.status, 200);
    const tried = site.hits.filter((h) => h.startsWith("/missing-")).length;
    assert.ok(tried <= 40, `fetched ${tried} dead sitemaps`);
  } finally { await s.stop(); await site.close(); }
});

test("a section listed late in a big sitemap is still found", async () => {
  const site = await fixture(({ path, send, base }) => {
    if (path === "/sitemap_index.xml") return send(`<sitemapindex><sitemap><loc>${base}/sm-other.xml</loc></sitemap><sitemap><loc>${base}/sm-docs.xml</loc></sitemap></sitemapindex>`, "application/xml");
    if (path === "/sm-other.xml") return send(`<urlset>${Array.from({ length: 1000 }, (_, i) => `<url><loc>${base}/other/${i}</loc></url>`).join("")}</urlset>`, "application/xml");
    if (path === "/sm-docs.xml") return send(`<urlset>${[1, 2, 3, 4, 5].map((i) => `<url><loc>${base}/docs/${i}</loc></url>`).join("")}</urlset>`, "application/xml");
  });
  const s = await bootServer();
  try {
    const r = await s.agent("map_site", { url: `${site.base}/docs/`, limit: 10, links: false });
    assert.equal(r.status, 200);
    const urls = r.body.urls.map((u) => u.url.replace(site.base, "")).filter((u) => u.startsWith("/docs/"));
    assert.deepEqual(urls.sort(), ["/docs/1", "/docs/2", "/docs/3", "/docs/4", "/docs/5"]);
  } finally { await s.stop(); await site.close(); }
});

test("cancel and shutdown answer at once even while a long Crawl-delay is being honoured", async () => {
  const site = await fixture(({ path, send }) => {
    if (path === "/robots.txt") return send("User-agent: *\nCrawl-delay: 30\n", "text/plain");
    if (path.startsWith("/d/")) return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    const urls = ["p1", "p2", "p3"].map((n) => `${site.base}/d/${n}`);
    const { id } = (await s.call("POST", "/api/crawls", { urls, delay_ms: 0 })).body;
    await waitJob(s, id, 5000, (b) => b.saved >= 1);
    const t0 = Date.now();
    await s.call("POST", `/api/crawls/${id}/cancel`);
    const job = await waitJob(s, id, 3000);
    assert.equal(job.status, "cancelled");
    assert.ok(Date.now() - t0 < 2500, `cancel took ${Date.now() - t0} ms`);
    assert.equal(job.saved, 1);

    const second = (await s.call("POST", "/api/crawls", { urls: urls.slice(1), delay_ms: 0 })).body;
    await waitJob(s, second.id, 5000, (b) => b.saved >= 1);
    const t1 = Date.now();
    await shutdownCrawls();
    assert.ok(Date.now() - t1 < 2500, `shutdown took ${Date.now() - t1} ms`);
  } finally { await s.stop(); await site.close(); }
});

test("resume right after cancel is not lost, and a page in flight when cancelling is not saved", async () => {
  const site = await fixture(async ({ path, send }) => {
    if (path === "/slow") { await wait(600); return send(page("Lenta")); }
    if (path.startsWith("/q/")) return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    const inflight = (await s.call("POST", "/api/crawls", { urls: [`${site.base}/slow`], delay_ms: 0 })).body;
    await wait(200);
    await s.call("POST", `/api/crawls/${inflight.id}/cancel`);
    const stopped = await waitJob(s, inflight.id);
    assert.equal(stopped.status, "cancelled");
    assert.equal((await libraryPaths(s, site.base)).length, 0, "a page fetched after cancel was saved");

    const urls = ["a", "b", "c", "d"].map((n) => `${site.base}/q/${n}`);
    const { id } = (await s.call("POST", "/api/crawls", { urls, delay_ms: 300, concurrency: 1 })).body;
    await waitJob(s, id, 5000, (b) => b.saved >= 1);
    await s.call("POST", `/api/crawls/${id}/cancel`);
    await s.agent("crawl_status", { id, action: "resume" });
    const job = await waitJob(s, id, 10_000, (b) => b.status === "done");
    assert.equal(job.status, "done");
    assert.deepEqual(await libraryPaths(s, site.base), ["/q/a", "/q/b", "/q/c", "/q/d"]);
  } finally { await s.stop(); await site.close(); }
});

test("a section start page served at /dir and /dir/ alike resolves its relative links against the address as typed", async () => {
  const site = await fixture(({ path, send }) => {
    if (path === "/g" || path === "/g/") return send(page("Guía", ["intro", "setup"]));
    if (path === "/g/intro" || path === "/g/setup") return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    const map = await s.call("POST", "/api/site/map", { url: `${site.base}/g/`, sitemaps: false });
    assert.deepEqual(map.body.urls.map((u) => u.url.replace(site.base, "")).sort(), ["/g", "/g/intro", "/g/setup"]);
    const job = await waitJob(s, (await s.call("POST", "/api/crawls", { url: `${site.base}/g/`, depth: 2, delay_ms: 0 })).body.id);
    assert.equal(job.saved, 3, JSON.stringify(job.results));
  } finally { await s.stop(); await site.close(); }
});

test("a path prefix is a section boundary and may be written with accents", () => {
  const u = (p) => `http://x.test${p}`;
  const docs = makeFilter({ path_prefix: "/docs" });
  assert.ok(docs(u("/docs")) && docs(u("/docs/a")));
  assert.ok(!docs(u("/docs-old/a")), "/docs must not match /docs-old");
  const accent = makeFilter({ path_prefix: "/año/" });
  assert.ok(accent(u("/a%C3%B1o/x")));
  assert.ok(accent(u("/año/y")));
});

test("a crawl job can be deleted from the history (REST and MCP) without touching the links it saved; a running one is refused", async () => {
  const site = await fixture(async ({ path, send }) => {
    if (path === "/slow") { await wait(800); return send(page("Lenta")); }
    if (path.startsWith("/k/")) return send(page("Página " + path.slice(3)));
  });
  const s = await bootServer();
  try {
    const done = await waitJob(s, (await s.call("POST", "/api/crawls", { urls: [`${site.base}/k/a`, `${site.base}/k/b`], delay_ms: 0 })).body.id);
    assert.equal(done.saved, 2);
    const del = await s.call("DELETE", `/api/crawls/${done.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.links_kept, 2);
    assert.equal((await s.call("GET", `/api/crawls/${done.id}`)).status, 404);
    assert.deepEqual(await libraryPaths(s, site.base), ["/k/a", "/k/b"]);
    assert.equal((await s.call("DELETE", `/api/crawls/${done.id}`)).status, 404);

    const live = (await s.call("POST", "/api/crawls", { urls: [`${site.base}/slow`], delay_ms: 0 })).body;
    await wait(100);
    const refused = await s.agent("crawl_delete", { id: live.id });
    assert.equal(refused.status, 409);
    assert.equal((await s.call("DELETE", `/api/crawls/${live.id}`)).status, 409);
    await s.agent("crawl_status", { id: live.id, action: "cancel" });
    await waitJob(s, live.id);
    const ok = await s.agent("crawl_delete", { id: live.id });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deleted, live.id);
    assert.equal((await s.agent("crawl_status", {})).body.crawls.length, 0);
    assert.equal((await s.agent("crawl_delete", { id: "nope" })).status, 400);
  } finally { await s.stop(); await site.close(); }
});
