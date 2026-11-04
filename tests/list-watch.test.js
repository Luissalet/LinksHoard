// List watches: detection of repeated entries, selectors, pagination, the stop at the first page without news, tools and REST.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer } from "./helpers.js";
import { readListPage, walkList } from "../server/list-watch.js";

const NAV = `<header><nav><ul class="menu"><li class="m"><a href="/a">Inicio</a></li><li class="m"><a href="/b">Empresas</a></li><li class="m"><a href="/c">Blog</a></li><li class="m"><a href="/d">Contacto</a></li></ul></nav></header>`;
const card = (j) => `<li class="job card"><h3><a href="/jobs/${j.id}">${j.title}</a></h3><p class="co">${j.company}</p><a class="apply" href="/apply/${j.id}">Inscribirse</a></li>`;
const LISTING = (jobs, next = "") => `<!doctype html><html><head><title>Ofertas de trabajo</title>${next ? `<link rel="next" href="${next}">` : ""}</head><body>${NAV}
<main><h1>Ofertas</h1><ul class="results">${jobs.map(card).join("")}</ul>${next ? `<a class="pager-next" href="${next}">Siguiente</a>` : ""}</main>
<footer><ul class="links"><li class="f"><a href="/x">Aviso legal</a></li><li class="f"><a href="/y">Cookies</a></li><li class="f"><a href="/z">Prensa</a></li></ul></footer></body></html>`;

const job = (id) => ({ id, title: `Puesto ${id}`, company: `Empresa ${id}` });

test("the repeated entries are found, navigation and footer are not, and the next page is followed", () => {
  const out = readListPage(LISTING([job(1), job(2), job(3), job(4)], "/jobs?page=2"), "https://ex.com/jobs");
  assert.equal(out.error, undefined);
  assert.equal(out.detected, true);
  assert.equal(out.selector, "ul.results > li.card.job");
  assert.deepEqual(out.items.map((i) => i.url), [1, 2, 3, 4].map((n) => `https://ex.com/jobs/${n}`));
  assert.equal(out.items[0].title, "Puesto 1");
  assert.match(out.items[0].summary, /Empresa 1/);
  assert.equal(out.items[0].guid, "list:https://ex.com/jobs/1");
  assert.equal(out.next, "https://ex.com/jobs?page=2");
  assert.equal(out.title, "Ofertas de trabajo");
  const again = readListPage(LISTING([job(9), job(8), job(7)]), "https://ex.com/jobs", out.selector);
  assert.deepEqual(again.items.map((i) => i.title), ["Puesto 9", "Puesto 8", "Puesto 7"]);
  assert.equal(again.next, "");
  assert.match(readListPage("<html><body><p>Nada que listar</p></body></html>", "https://ex.com/").error, /No encuentro una lista/);
  assert.match(readListPage(LISTING([job(1)]), "https://ex.com/", "li.nope").error, /no encuentra entradas/);
  assert.match(readListPage(LISTING([job(1)]), "https://ex.com/", "li[").error, /Selector CSS no válido/);
});

test("a table of headlines wins over its rows of '12 comments', and a rank cell is not the title", () => {
  const rows = [1, 2, 3, 4].map((n) => `<tr class="athing" id="${900 + n}"><td class="title"><span class="rank">${n}.</span></td><td class="title"><span class="titleline"><a href="https://site${n}.example/story">A fairly long headline number ${n}</a> <span class="sitebit">(<a href="from?site=site${n}">site${n}</a>)</span></span></td></tr>`
    + `<tr><td class="subtext">${n * 10} points by <a href="user?id=u${n}">u${n}</a> | <a href="item?id=${900 + n}">${n} comments</a></td></tr><tr class="spacer"></tr>`).join("");
  const html = `<html><body><table id="hnmain"><tr><td><table><tr class="head"><td><a href="news">Hacker News</a></td></tr>${rows}</table><a class="morelink" rel="next" href="?p=2">More</a></td></tr></table></body></html>`;
  const out = readListPage(html, "https://news.example/");
  assert.equal(out.selector, "table > tr.athing");
  assert.deepEqual(out.items.map((i) => i.url), [1, 2, 3, 4].map((n) => `https://site${n}.example/story`));
  assert.equal(out.items[0].title, "A fairly long headline number 1 (site1)");
  assert.equal(out.items[0].summary, "", "the rank and the title are not repeated as summary");
  assert.equal(out.next, "https://news.example/?p=2");
});

test("the walk follows pages up to the limit and stops at the first page with nothing unknown", async () => {
  const site = {
    "https://ex.com/jobs?page=2": LISTING([job(5), job(6), job(7)], "/jobs?page=3"),
    "https://ex.com/jobs?page=3": LISTING([job(8), job(9), job(10)], "/jobs?page=4"),
  };
  const asked = [];
  const fetchPage = async (u) => { asked.push(u); return site[u] ? { ok: true, text: site[u], url: u } : { ok: false, error: "HTTP 404" }; };
  const first = { ok: true, text: LISTING([job(1), job(2), job(3), job(4)], "/jobs?page=2"), url: "https://ex.com/jobs" };
  const all = await walkList(first, { pages: 3, fetchPage });
  assert.equal(all.items.length, 10);
  assert.deepEqual(all.pages.map((p) => p.count), [4, 3, 3]);
  assert.deepEqual(asked, ["https://ex.com/jobs?page=2", "https://ex.com/jobs?page=3"]);
  asked.length = 0;
  const known = new Set(all.items.map((i) => i.guid));
  const quiet = await walkList(first, { selector: all.selector, pages: 3, known, fetchPage });
  assert.deepEqual(asked, [], "nothing new on page 1: page 2 is not fetched");
  assert.equal(quiet.pages[0].fresh, 0);
  known.delete("list:https://ex.com/jobs/1");
  const one = await walkList(first, { selector: all.selector, pages: 3, known, fetchPage });
  assert.equal(one.pages[0].fresh, 1);
  assert.deepEqual(asked, ["https://ex.com/jobs?page=2"], "page 2 is read and, having nothing new, ends the walk");
});

let s, server, base, jobs;
const hits = [];
before(async () => {
  process.env.LINKS_ALLOW_PRIVATE_URLS = "1";
  s = await bootServer();
  jobs = [job(1), job(2), job(3), job(4), job(5), job(6)];
  server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.url.startsWith("/plain")) return res.end("<html><head><title>x</title></head><body><p>Sin lista.</p></body></html>");
    const page = Number(new URL(req.url, "http://x").searchParams.get("page") || 1);
    const slice = jobs.slice((page - 1) * 3, page * 3);
    res.end(LISTING(slice, page * 3 < jobs.length ? `/jobs?page=${page + 1}` : ""));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await s.stop();
  await new Promise((r) => server.close(r));
});

test("preview, add, check: a list watch brings each new entry once and saves it as a link", async () => {
  const preview = await s.agent("watch_list_preview", { url: `${base}/jobs`, pages: 2 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.count, 6);
  assert.equal(preview.body.selector, "ul.results > li.card.job");
  assert.deepEqual(preview.body.pages.map((p) => p.count), [3, 3]);
  const rest = await s.call("POST", "/api/watches/list-preview", { url: `${base}/plain` });
  assert.equal(rest.status, 400);
  assert.match(rest.body.error, /No encuentro una lista/);
  const add = await s.agent("watch_add", { url: `${base}/jobs`, kind: "list", pages: 3, tags: ["empleo"] });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.kind, "list");
  assert.equal(add.body.list_selector, "ul.results > li.card.job");
  assert.equal(add.body.baseline_items, 6);
  assert.equal(add.body.name, "Ofertas de trabajo");
  jobs.unshift(job(7));                                     // a new offer on top: page 1 changes, the rest shifts
  hits.length = 0;
  const check = await s.agent("watch_check", { watch_id: add.body.id });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.new_items.map((i) => i.title), ["Puesto 7"]);
  assert.ok(check.body.new_items[0].link_id, "auto_save made a link");
  assert.deepEqual(hits.filter((h) => h.startsWith("/jobs")).length, 2, "page 2 was read and ended the walk (nothing new there)");
  const link = await s.call("GET", `/api/links/${check.body.new_items[0].link_id}`);
  assert.deepEqual(link.body.tags, ["empleo"]);
  const quiet = await s.agent("watch_check", { watch_id: add.body.id });
  assert.deepEqual(quiet.body.new_items, []);
  const patched = await s.call("PATCH", `/api/watches/${add.body.id}`, { pages: 1 });
  assert.equal(patched.body.list_pages, 1);
  await s.agent("watch_remove", { watch_id: add.body.id });
});
