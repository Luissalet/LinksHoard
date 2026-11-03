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
  // start_href: the start page as typed, fetched as such ("/guide/" and "/guide" may both answer with different relative links)
  const startHref = !explicit && sameHost(typed, start) ? typed.split("#")[0] : undefined;
  const options = { ...o, url: start, start_href: startHref, urls: explicit || undefined, path_prefix: section, depth: o.depth ?? (explicit ? 0 : 1) };
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
  if (handle) { handle.cancel = true; handle.resumeAfter = false; }
  else if (["queued", "running", "interrupted"].includes(job.status)) patchJob(id, { status: "cancelled", finished_at: now() });
  return getCrawl(id);
}

/** Remove a crawl job record (its history), never the links it saved. A job still running must be cancelled first.
 * Returns null when it does not exist; throws 409 while it runs. */
export function deleteCrawl(id) {
  const job = getCrawl(id);
  if (!job) return null;
  if (running.has(id)) throw Object.assign(new Error("El rastreo sigue en marcha: cancélalo antes de borrarlo."), { status: 409 });
  db().prepare("DELETE FROM crawl_jobs WHERE id = ?").run(id);
  return { ok: true, deleted: id, links_kept: job.saved, tag: job.tag, note: "Solo se borra el registro del rastreo; las páginas guardadas siguen en la biblioteca." };
}

/** Run a stopped, cancelled, failed or interrupted job again; pages already saved are skipped, so it only does the rest. */
export function resumeCrawl(id) {
  const job = getCrawl(id);
  if (!job) return null;
  const handle = running.get(id);
  if (handle) {
    // still winding down after a cancel: run it again as soon as it has stopped instead of dropping the request
    if (handle.cancel && !handle.stopping) handle.resumeAfter = true;
    return job;
  }
  patchJob(id, { status: "queued", found: 0, done: 0, saved: 0, skipped: 0, failed: 0, current: "", error: "", results: "[]", finished_at: null });
  launch(id);
  return getCrawl(id);
}

function launch(id) {
  const handle = { cancel: false, stopping: false, resumeAfter: false, promise: null };
  running.set(id, handle);
  handle.promise = run(id, handle)
    .catch((e) => patchJob(id, { status: "failed", error: String(e?.message || e).slice(0, 300), finished_at: now() }))
    .finally(() => {
      running.delete(id);
      if (handle.resumeAfter && !handle.stopping && isOpen()) resumeCrawl(id);
    });
}

/** At boot: jobs that were running when the app stopped (killed: queued/running; clean shutdown: interrupted) are marked
 * interrupted and, unless LINKS_CRAWL_RESUME=0, continued. */
export function initCrawls() {
  const rows = db().prepare("SELECT id FROM crawl_jobs WHERE status IN ('queued', 'running', 'interrupted')").all();
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
  // url: the normalized dedupe key; href: the address as found (fetched as such)
  const push = (url, depth, href) => {
    const n = normalizeUrl(url);
    if (!n || seen.has(n)) return;
    seen.add(n);
    frontier.push({ url: n, depth, href: href && normalizeUrl(href) === n ? href : n });
  };
  if (o.urls) for (const u of o.urls) push(u, 0);
  else {
    push(o.url, 0, o.start_href);
    if (o.depth > 0) {
      const map = await mapSite({ url: o.start_href || o.url, include: o.include, exclude: o.exclude, path_prefix: o.path_prefix, limit: Math.min(o.limit * 4, 5000) });
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
  // a long Crawl-delay must not keep a cancel or a shutdown waiting: sleep in short slices and stop when asked
  const pause = async (ms) => {
    const end = Date.now() + ms;
    while (!handle.cancel && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
  };
  const gate = async () => {
    if (!delay) return;
    const wait = Math.max(0, nextAt - Date.now());
    nextAt = Math.max(nextAt, Date.now()) + delay;
    if (wait) await pause(wait);
  };
  let active = 0;
  let fetched = 0; // requests made: pages skipped without a request (already saved, robots) do not use up the budget

  const process_ = async ({ url, depth, href }) => {
    if (!sameHost(url, o.url)) { counts.done++; counts.skipped++; return record({ url, status: "offsite" }); }
    if (!robotsAllows(robots, url)) { counts.done++; counts.skipped++; return record({ url, status: "robots" }); }
    const existing = getLinkByUrl(url);
    // A page already in the library is not saved again; it is fetched only when its links are still needed.
    if (existing && depth >= o.depth) { counts.done++; counts.skipped++; return record({ url, status: "existing", title: existing.title }); }
    await gate();
    if (handle.cancel) return;
    fetched++;
    const r = await webGet(href || url, { profile: fetchProfile(), accept: "any", timeoutMs: 15_000, maxBytes: MAX_BYTES, userAgent: USER_AGENT, retries: 0 });
    if (handle.cancel) return; // cancelled while downloading: nothing more is saved (a resume fetches it again)
    const finalUrl = r.finalUrl || href || url;
    // a redirect may leave the site, or land on a path robots.txt forbids
    if (!sameHost(finalUrl, o.url)) { counts.done++; counts.skipped++; return record({ url, status: "offsite", error: `redirige a ${finalUrl}`.slice(0, 200) }, url); }
    if (normalizeUrl(finalUrl) !== url && !robotsAllows(robots, finalUrl)) { counts.done++; counts.skipped++; return record({ url, status: "robots" }, url); }
    const kind = kindFromResponse(finalUrl, r.contentType);
    // PDFs and images have no text, so webGet does not call them ok; a 2xx with a body is a good download
    const binaryOk = (kind === "pdf" || kind === "image") && r.status >= 200 && r.status < 300 && r.body?.length > 0;
    if (!r.ok && !binaryOk) {
      counts.done++; counts.failed++;
      return record({ url, status: "failed", error: String(r.error || `HTTP ${r.status}`).slice(0, 200) }, url);
    }
    let extracted = { title: "", description: "", contentText: "", byline: "", lang: "" };
    if (kind === "pdf" || kind === "image") {
      const last = new URL(finalUrl).pathname.split("/").filter(Boolean).pop() || "";
      let name = last;
      try { name = decodeURIComponent(last); } catch { name = unescape(last); } // a Latin-1 "%E9" is not valid UTF-8
      extracted.title = name || finalUrl;
    } else {
      extracted = extractHtml(r.text || "", finalUrl);
      if (depth < o.depth) {
        for (const l of pageLinks(r.text || "", finalUrl)) {
          if (filter(l.url) && sameHost(l.url, o.url)) push(l.url, depth + 1, l.href);
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
      if (handle.cancel || counts.saved >= o.limit || fetched >= o.limit * 3) return;
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
