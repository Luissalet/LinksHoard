// Background fetch queue (concurrency 2): downloads a saved link's page,
// extracts text with extract.js and writes the result back through links.js.
import { extractHtml, kindFromResponse, oembedTitle, excerptOf, wordCount } from "./extract.js";
import { applyFetchResult } from "./links.js";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LinksHoard/1.0";
const CONCURRENCY = 2;

const queue = [];
const waiters = new Map(); // linkId -> [{resolve}]
const runningIds = new Set();
let drainWaiters = [];
let active = 0;
let stopped = false;

/** Read a response body up to maxBytes, aborting the stream past the limit. */
async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return await response.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("La página supera el límite de 5 MB."), { code: "TOO_LARGE" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function fetchOne(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const kind = kindFromResponse(response.url || url, contentType);

  if (kind === "pdf") {
    return { kind, title: filenameTitle(response.url || url), description: "", contentText: "", byline: "", lang: "" };
  }
  if (kind === "image") {
    return { kind, title: filenameTitle(response.url || url), description: "", contentText: "", byline: "", lang: "" };
  }

  const oembed = await oembedTitle(response.url || url).catch(() => null);
  const html = await readLimited(response, MAX_BYTES);
  const extracted = extractHtml(html, response.url || url);
  if (oembed?.title) {
    extracted.title = oembed.title;
    if (oembed.byline) extracted.byline = oembed.byline;
  }
  return { kind: oembed ? "video" : kind, ...extracted };
}

function filenameTitle(url) {
  try {
    const { pathname } = new URL(url);
    const name = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || pathname);
    return name || url;
  } catch {
    return url;
  }
}

async function runOne(linkId, url) {
  try {
    const result = await fetchOne(url);
    applyFetchResult(linkId, {
      fetch_status: "ok",
      fetch_error: "",
      title: result.title || "",
      description: result.description || "",
      content_text: result.contentText || "",
      excerpt: excerptOf(result.contentText || result.description || ""),
      byline: result.byline || "",
      lang: result.lang || "",
      word_count: wordCount(result.contentText || ""),
      kind: result.kind || "other",
    });
  } catch (error) {
    applyFetchResult(linkId, { fetch_status: "failed", fetch_error: error.message || "Error al descargar." });
  } finally {
    for (const w of waiters.get(linkId) || []) w.resolve();
    waiters.delete(linkId);
  }
}

function pump() {
  while (!stopped && active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    runningIds.add(job.linkId);
    runOne(job.linkId, job.url).finally(() => {
      active--;
      runningIds.delete(job.linkId);
      pump();
    });
  }
  if (active === 0 && (queue.length === 0 || stopped)) {
    const resolved = drainWaiters;
    drainWaiters = [];
    for (const resolve of resolved) resolve();
  }
}

/** Enqueue a fetch for linkId/url; runs in the background. No-op once stop() has been called (shutting down). */
export function enqueueFetch(linkId, url) {
  if (stopped) return;
  queue.push({ linkId, url });
  pump();
}

/** Resolve once the given link's in-flight fetch (if any) settles, or immediately if none is queued/running. */
export function waitForFetch(linkId, timeoutMs = 10_000) {
  const isPending = queue.some((j) => j.linkId === linkId) || runningIds.has(linkId);
  if (!isPending) return Promise.resolve();
  return new Promise((resolve) => {
    const list = waiters.get(linkId) || [];
    list.push({ resolve });
    waiters.set(linkId, list);
    setTimeout(resolve, timeoutMs);
  });
}

export function queueDepth() {
  return { queued: queue.length, active };
}

/**
 * Wait for every queued and in-flight fetch to settle (resolves immediately
 * if the queue is already idle). Awaited by tests before closing the
 * database, and by the app on shutdown — see stop() below.
 */
export function drain(timeoutMs = 15_000) {
  if (active === 0 && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    drainWaiters.push(finish);
    if (timeoutMs) setTimeout(finish, timeoutMs).unref?.();
  });
}

/**
 * Stop accepting new fetches and wait for in-flight ones to settle. Call
 * this before closing the database (server/index.js on SIGINT/SIGTERM, and
 * tests/helpers.js before db.close()) so a background write never lands
 * after the connection it needs is gone.
 */
export function stop(timeoutMs = 15_000) {
  stopped = true;
  return drain(timeoutMs);
}
