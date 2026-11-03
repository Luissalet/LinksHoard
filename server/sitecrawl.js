// "Save a whole site or section": a background crawl job. Pages are found from the sitemap / start-page links (sitemap.js) and by
// following same-host links up to a depth; every page goes through the same extractor as a single saved link (extract.js), is saved
// as a normal Link tagged with the site and the job, and is skipped when the URL is already in the library. Politeness: robots.txt
// rules and Crawl-delay are honoured, requests to the host are spaced by a delay, concurrency is small. Jobs live in the crawl_jobs
// table, so a crawl interrupted by a restart or a cancel can be resumed: running it again only fetches what is not saved yet.
import { z } from "zod";
import { db, uid, now, isOpen } from "./db.js";
import { webGet } from "./hoard-commons/web.js";
import { fetchProfile, USER_AGENT } from "./net-policy.js";
import { extractHtml, kindFromResponse, excerptOf, wordCount } from "./extract.js";
import { createLink, applyFetchResult, getLinkByUrl } from "./links.js";
import { normalizeUrl, siteOf } from "./url.js";
import { mapSite, makeFilter, defaultPrefix, loadRobots, robotsAllows, pageLinks, sameHost } from "./sitemap.js";

const globs = z.array(z.string().trim().min(1).max(200)).max(50).default([]);
const tagList = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

export const mapInput = z.object({
  url: z.string().trim().min(1),
  include: globs,
  exclude: globs,
  path_prefix: z.string().trim().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
  sitemaps: z.boolean().default(true),
  links: z.boolean().default(true),
});

export const crawlInput = z.object({
  url: z.string().trim().min(1).optional(),
  urls: z.array(z.string().trim().min(1)).max(2000).optional(),
  include: globs,
  exclude: globs,
  path_prefix: z.string().trim().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  depth: z.coerce.number().int().min(0).max(5).optional(),
  tags: tagList,
  delay_ms: z.coerce.number().int().min(0).max(10_000).default(500),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
}).refine((v) => v.url || (v.urls && v.urls.length), { message: "Indica url o urls." });

const running = new Map(); // job id -> { cancel: false, stopping: false, promise }
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

const view = (r) => (r ? {
  id: r.id, start_url: r.start_url, host: r.host, status: r.status,
  found: r.found, done: r.done, saved: r.saved, skipped: r.skipped, failed: r.failed,
  current: r.current || undefined, error: r.error || undefined,
  options: JSON.parse(r.options || "{}"), tag: jobTag(r.id),
  created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at || undefined,
} : null);

export const jobTag = (id) => `crawl-${String(id).slice(0, 8)}`;

export function getCrawl(id, { results = false } = {}) {
  const r = db().prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(id);
  if (!r) return null;
  const out = view(r);
  if (results) out.results = JSON.parse(r.results || "[]");
  return out;
}

export function listCrawls(limit = 20) {
  return db().prepare("SELECT * FROM crawl_jobs ORDER BY created_at DESC LIMIT ?").all(limit).map(view);
}

function patchJob(id, patch) {
  if (!isOpen()) return;
  const keys = Object.keys(patch);
  db().prepare(`UPDATE crawl_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), now(), id);
}

/** Create a crawl job and start it in the background. */
export function startCrawl(input) {
  const o = crawlInput.parse(input);
  const startRaw = o.url || o.urls[0];
  const start = normalizeUrl(startRaw);
  if (!start) throw Object.assign(new Error("URL no válida."), { status: 400 });
  const explicit = o.urls?.length ? [...new Set(o.urls.map(normalizeUrl).filter(Boolean))] : null;
  if (o.urls?.length && !explicit.length) throw Object.assign(new Error("Ninguna URL válida."), { status: 400 });
  let typed = start;
  try { typed = new URL(startRaw.trim()).href; } catch { /* keep normalized */ }
  const section = o.path_prefix ?? (explicit ? "/" : defaultPrefix(typed) || "/");
  const options = { ...o, url: start, urls: explicit || undefined, path_prefix: section, depth: o.depth ?? (explicit ? 0 : 1) };
  const id = uid();
  const ts = now();
  db().prepare("INSERT INTO crawl_jobs (id, start_url, host, options, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
    .run(id, start, siteOf(start), JSON.stringify(options), ts, ts);
  launch(id);
  return getCrawl(id);
}

export function cancelCrawl(id) {
  const job = getCrawl(id);
  if (!job) return null;
  const handle = running.get(id);
  if (handle) handle.cancel = true;
  else if (["queued", "running", "interrupted"].includes(job.status)) patchJob(id, { status: "cancelled", finished_at: now() });
  return getCrawl(id);
}

/** Run a stopped, cancelled, failed or interrupted job again; pages already saved are skipped, so it only does the rest. */
export function resumeCrawl(id) {
  const job = getCrawl(id);
  if (!job) return null;
  if (running.has(id)) return job;
  patchJob(id, { status: "queued", found: 0, done: 0, saved: 0, skipped: 0, failed: 0, current: "", error: "", results: "[]", finished_at: null });
  launch(id);
  return getCrawl(id);
}

function launch(id) {
  const handle = { cancel: false, stopping: false, promise: null };
  running.set(id, handle);
  handle.promise = run(id, handle)
    .catch((e) => patchJob(id, { status: "failed", error: String(e?.message || e).slice(0, 300), finished_at: now() }))
    .finally(() => running.delete(id));
}

/** At boot: jobs that were running when the app stopped are marked interrupted and, unless LINKS_CRAWL_RESUME=0, continued. */
export function initCrawls() {
  const rows = db().prepare("SELECT id FROM crawl_jobs WHERE status IN ('queued', 'running')").all();
  for (const { id } of rows) {
    patchJob(id, { status: "interrupted" });
    if (process.env.LINKS_CRAWL_RESUME !== "0") resumeCrawl(id);
  }
}

/** Stop every running job (they stay resumable) and wait for them; call before the database closes. */
export async function shutdownCrawls() {
  const handles = [...running.values()];
  for (const h of handles) { h.cancel = true; h.stopping = true; }
  await Promise.all(handles.map((h) => h.promise));
}

const MAX_BYTES = 5 * 1024 * 1024;

async function run(id, handle) {
  const job = db().prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(id);
  const o = JSON.parse(job.options);
  const origin = new URL(o.url).origin;
  patchJob(id, { status: "running" });

  const robots = await loadRobots(origin);
  const crawlDelayMs = Math.round((robots.crawlDelay || 0) * 1000);
  const delay = Math.max(o.delay_ms || 0, crawlDelayMs);
  const concurrency = crawlDelayMs > 0 ? 1 : o.concurrency || 2;
  const prefix = !o.path_prefix || o.path_prefix === "/" ? "" : o.path_prefix;
  const filter = makeFilter({ include: o.include, exclude: o.exclude, path_prefix: prefix });
  const tags = [...new Set([...(o.tags || []), `site:${siteOf(o.url)}`.slice(0, 40), jobTag(id)])];

  const seen = new Set();
  const frontier = [];
  const push = (url, depth) => {
    const n = normalizeUrl(url);
    if (!n || seen.has(n)) return;
    seen.add(n);
    frontier.push({ url: n, depth });
  };
  if (o.urls) for (const u of o.urls) push(u, 0);
  else {
    push(o.url, 0);
    if (o.depth > 0) {
      const map = await mapSite({ url: o.url, include: o.include, exclude: o.exclude, path_prefix: o.path_prefix, limit: Math.min(o.limit * 4, 5000) });
      for (const u of map.urls) push(u.url, 1);
    }
  }

  const counts = { found: seen.size, done: 0, saved: 0, skipped: 0, failed: 0 };
  const results = [];
  const record = (entry, current = "") => {
    results.push(entry);
    if (results.length > 300) results.shift();
    patchJob(id, { ...counts, found: seen.size, current, results: JSON.stringify(results) });
  };
  patchJob(id, { found: seen.size });

  let nextAt = 0;
  const gate = async () => {
    if (!delay) return;
    const wait = Math.max(0, nextAt - Date.now());
    nextAt = Math.max(nextAt, Date.now()) + delay;
    if (wait) await sleep(wait);
  };
  let active = 0;

  const process_ = async ({ url, depth }) => {
    if (!robotsAllows(robots, url)) { counts.done++; counts.skipped++; return record({ url, status: "robots" }); }
    const existing = getLinkByUrl(url);
    // A page already in the library is not saved again; it is fetched only when its links are still needed.
    if (existing && depth >= o.depth) { counts.done++; counts.skipped++; return record({ url, status: "existing", title: existing.title }); }
    await gate();
    if (handle.cancel) return;
    const r = await webGet(url, { profile: fetchProfile(), accept: "any", timeoutMs: 15_000, maxBytes: MAX_BYTES, userAgent: USER_AGENT, retries: 0 });
    const finalUrl = r.finalUrl || url;
    if (!r.ok) {
      counts.done++; counts.failed++;
      return record({ url, status: "failed", error: String(r.error || `HTTP ${r.status}`).slice(0, 200) }, url);
    }
    const kind = kindFromResponse(finalUrl, r.contentType);
    let extracted = { title: "", description: "", contentText: "", byline: "", lang: "" };
    if (kind === "pdf" || kind === "image") extracted.title = decodeURIComponent(new URL(finalUrl).pathname.split("/").filter(Boolean).pop() || finalUrl);
    else {
      extracted = extractHtml(r.text || "", finalUrl);
      if (depth < o.depth) {
        for (const l of pageLinks(r.text || "", finalUrl)) {
          if (filter(l.url) && sameHost(l.url, o.url)) push(l.url, depth + 1);
        }
        counts.found = seen.size;
      }
    }
    if (existing) { counts.done++; counts.skipped++; return record({ url, status: "existing", title: existing.title }, url); }
    if (counts.saved >= o.limit) return; // another worker took the last slot while this page was downloading
    const { link, existing: raced } = createLink({ url: finalUrl === url ? url : finalUrl, tags, source: "import" });
    if (raced) { counts.done++; counts.skipped++; return record({ url, status: "existing", title: link.title }, url); }
    applyFetchResult(link.id, {
      fetch_status: "ok", fetch_error: "", title: extracted.title || "", description: extracted.description || "",
      content_text: extracted.contentText || "", excerpt: excerptOf(extracted.contentText || extracted.description || ""),
      byline: extracted.byline || "", lang: extracted.lang || "", word_count: wordCount(extracted.contentText || ""), kind: kind || "other",
    });
    counts.done++; counts.saved++;
    record({ url, status: "saved", title: extracted.title || "", link_id: link.id }, url);
  };

  const worker = async () => {
    for (;;) {
      if (handle.cancel || counts.saved >= o.limit || counts.done >= o.limit * 3) return;
      const item = frontier.shift();
      if (!item) {
        if (active === 0) return;
        await sleep(25);
        continue;
      }
      active++;
      try {
        await process_(item);
      } catch (e) {
        counts.done++; counts.failed++;
        record({ url: item.url, status: "failed", error: String(e?.message || e).slice(0, 200) });
      } finally { active--; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (handle.stopping) patchJob(id, { ...counts, status: "interrupted", current: "" });
  else if (handle.cancel) patchJob(id, { ...counts, status: "cancelled", current: "", finished_at: now() });
  else patchJob(id, { ...counts, status: "done", current: "", finished_at: now() });
}
