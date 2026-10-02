// Background fetch queue (concurrency 2): downloads a saved link's page,
// extracts text with extract.js and writes the result back through links.js.
import { extractHtml, kindFromResponse, oembedTitle, excerptOf, wordCount } from "./extract.js";
import { applyFetchResult } from "./links.js";
import { webGet } from "./hoard-commons/web.js";
import { fetchProfile, USER_AGENT } from "./net-policy.js";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const CONCURRENCY = 2;

const queue = [];
const waiters = new Map(); // linkId -> [{resolve}]
const runningIds = new Set();
let drainWaiters = [];
let active = 0;
let stopped = false;

/** What the person reads when a page could not be fetched: the shared fetcher's reason, in Spanish where it is about the address. */
function failureMessage(r) {
  if (r.errorKind === "policy") return `Esa dirección no se puede descargar: ${r.error}. Solo se descargan páginas públicas (LINKS_ALLOW_PRIVATE_URLS=1 permite las de tu red).`;
  if (r.errorKind === "timeout") return "La página tardó demasiado en responder.";
  return r.error || "Error al descargar.";
}

async function fetchOne(url) {
  // webGet: address check on every redirect hop, charset detection, a body cap, block detection. accept "any" because PDFs and images are
  // saved by their title only and must not be refused as "not HTML".
  const r = await webGet(url, { profile: fetchProfile(), accept: "any", timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, userAgent: USER_AGENT });
  if (!r.ok) throw new Error(failureMessage(r));
  const finalUrl = r.finalUrl || url;
  const kind = kindFromResponse(finalUrl, r.contentType);

  if (kind === "pdf" || kind === "image") {
    return { kind, title: filenameTitle(finalUrl), description: "", contentText: "", byline: "", lang: "" };
  }

  const oembed = await oembedTitle(finalUrl).catch(() => null);
  const extracted = extractHtml(r.text, finalUrl);
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
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.(); // a settled wait must not keep the process alive for the rest of the timeout
    list.push({ resolve: () => { clearTimeout(timer); resolve(); } });
    waiters.set(linkId, list);
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
