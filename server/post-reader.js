// Read a social post as text (X, Instagram, Threads, TikTok, Facebook, Reddit…) with the session the person signed in to.
//
// The sessions are the ones of "Iniciar sesión con…" (site-login.js): a browser profile of Links' own where the person signed in
// themselves. Reading a post opens it in that profile without a window, waits for the page to render and takes what a reader
// sees: the author, the text, the links (X's t.co links resolved to where they go) and the page's own description. Nothing is
// posted, liked or marked as seen beyond what opening a page does. A page that only shows a login wall says so and names the
// site to sign in to, instead of returning an empty text.
import { cookiesFileFor, siteForUrl, sitesView, withCdp, withHeadless } from "./site-login.js";
import { resolveTool } from "./media.js";
import { runCapture } from "./hoard-commons/media.js";

export class PostError extends Error {
  constructor(message, { status = 400, code = "POST", site = null } = {}) { super(message); this.status = status; this.code = code; this.site = site; this.expose = true; }
}

const WAIT_MS = () => Number(process.env.LINKS_POST_WAIT_MS) || 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The script run in the page: returns null while it is not ready, else what a reader sees. Kept as a string (runs in the browser). */
export const EXTRACT = String.raw`(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"]')?.content || "";
  const host = location.hostname.replace(/^www\./, "");
  const body = (document.body?.innerText || "");
  if (location.protocol === "chrome-error:" || /^HTTP ERROR \d{3}/m.test(body) || /^Access to .* was denied/m.test(body)) {
    return { error: (body.match(/HTTP ERROR \d{3}/) || ["la página no cargó"])[0] };
  }
  const wall = /\b(log ?in|sign ?in|inicia sesión|regístrate|create an account)\b/i;
  const links = (root) => [...(root || document).querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 300) }))
    .filter((l) => /^https?:/.test(l.href));
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const id = (location.pathname.match(/status\/(\d+)/) || [])[1];
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const art = arts.find((a) => id && a.querySelector('a[href*="/status/' + id + '"]')) || arts[0];
    if (!art) {
      if (/\/i\/flow\//.test(location.pathname)) return { wall: true };
      const waited = performance.now() > 9000;
      return document.readyState === "complete" && waited && wall.test(body) ? { wall: true } : null;
    }
    const text = [...art.querySelectorAll('[data-testid="tweetText"]')].map((n) => n.innerText).join("\n\n");
    const author = (art.querySelector('[data-testid="User-Name"]')?.innerText || "").replace(/\n/g, " ");
    const card = art.querySelector('[data-testid="card.wrapper"]');
    return { text, author, links: links(art), card: card ? card.innerText.slice(0, 500) : "", title: document.title, description: meta("og:description") };
  }
  if (document.readyState !== "complete") return null;
  if (/instagram\.com$/.test(host)) {
    const art = document.querySelector("article") || document.querySelector("main");
    const caption = art?.querySelector("h1")?.innerText || "";
    const desc = meta("og:description");
    if (!caption && !desc) return wall.test(body) ? { wall: true } : null;
    return { text: caption || desc, author: meta("og:title"), links: links(art), title: document.title, description: desc };
  }
  const main = document.querySelector("article") || document.querySelector("main") || document.body;
  const text = (main?.innerText || "").slice(0, 6000);
  if (!text && !meta("og:description")) return null;
  return { text, author: meta("og:site_name") || meta("author"), links: links(main).slice(0, 80), title: meta("og:title") || document.title, description: meta("og:description") };
})()`;

/** Where a short link goes (t.co, bit.ly…): one hop at a time, at most 4, no body downloaded. */
export async function resolveShort(href, { fetchImpl = fetch } = {}) {
  let url = href;
  for (let i = 0; i < 4; i++) {
    let host = "";
    try { host = new URL(url).hostname; } catch { return url; }
    if (!/^(t\.co|bit\.ly|buff\.ly|ow\.ly|lnkd\.in|tinyurl\.com|dlvr\.it|t\.ly|rb\.gy)$/i.test(host)) return url;
    try {
      const res = await fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(6000) });
      const next = res.headers.get("location");
      if (!next) return url;
      url = new URL(next, url).href;
    } catch { return url; }
  }
  return url;
}

/** The same post through gallery-dl with the signed-in session (the way downloads already read X and Instagram): its metadata
 *  carries the text. Returns null when gallery-dl or the session is missing, or it found nothing. */
export async function galleryPost(url, { resolve = resolveTool, run = runCapture, cookiesFor = cookiesFileFor } = {}) {
  const cookies = cookiesFor(url);
  if (!cookies) return null;
  const tool = await resolve("gallerydl");
  if (!tool?.found) return null;
  const g = await run(tool.command, ["-j", "--cookies", cookies, "-o", "text-tweets=true", "-o", "conversations=false", "--range", "1-1", "--", url], { timeoutMs: 60_000 });
  let parsed = null;
  try { parsed = JSON.parse(g.stdout); } catch { return null; }
  const metas = (Array.isArray(parsed) ? parsed : []).map((e) => (Array.isArray(e) ? e.find((x) => x && typeof x === "object" && !Array.isArray(x)) : null)).filter(Boolean);
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const m = metas.find((x) => str(x.content) || str(x.description) || str(x.caption));
  if (!m) return null;
  const text = str(m.content) || str(m.description) || str(m.caption);
  const author = str(m.author?.nick) || str(m.author?.name) || str(m.username) || str(m.owner?.username) || str(m.fullname);
  const urls = [...new Set([...(text.match(/https?:\/\/[^\s)\]]+/g) || []), ...((m.urls || m.links || []).filter((u) => typeof u === "string"))])];
  return { text, author, links: urls.map((href) => ({ href, text: "" })), title: text.split(/\r?\n/)[0].slice(0, 120), description: "", via: "gallery-dl" };
}

const INTERNAL = /^https?:\/\/([a-z0-9-]+\.)?(x|twitter|instagram|threads|facebook|tiktok)\.(com|net)\/(?!.*\/status\/)/i;

/** Read one post. */
export async function readPost(input = {}, { headless = withHeadless, cdp = withCdp, resolver = resolveShort, gallery = galleryPost } = {}) {
  const url = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new PostError("Hace falta la URL completa del post.", { code: "BAD_URL" });
  const site = siteForUrl(url);
  const session = site ? sitesView().find((s) => s.id === site.id) : null;
  const got = await headless((ws) => cdp(ws, async (c) => {
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
    try {
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Page.navigate", { url }, sessionId);
      const end = Date.now() + WAIT_MS();
      while (Date.now() < end) {
        await sleep(700);
        const r = await c.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true }, sessionId).catch(() => null);
        const v = r?.result?.value;
        if (v) return v;
      }
      return null;
    } finally {
      await c.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }));
  let page = got;
  if ((!page || page.wall || page.error) && site && ["x", "instagram", "threads", "tiktok"].includes(site.id)) {
    const viaGallery = await gallery(url).catch(() => null);
    if (viaGallery) page = viaGallery;
  }
  return finish(url, site, session, page, resolver);
}

async function finish(url, site, session, got, resolver) {
  if (!got) throw new PostError("La página no mostró el post a tiempo.", { status: 504, code: "TIMEOUT", site: site?.id || null });
  if (got.error) {
    throw new PostError(`${site?.label || "La página"} no dejó leer el post (${got.error}).`, { status: 502, code: "REFUSED", site: site?.id || null });
  }
  if (got.wall) {
    throw new PostError(site ? `${site.label} pide iniciar sesión para ver este post: inicia sesión con ${site.label} en Links (Descargas → Sesiones) y vuelve a intentarlo.`
      : "La página pide iniciar sesión.", { status: 401, code: "LOGIN_NEEDED", site: site?.id || null });
  }
  const seen = new Set();
  const links = [];
  for (const l of got.links || []) {
    const href = await resolver(l.href);
    if (INTERNAL.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: l.text });
    if (links.length >= 40) break;
  }
  return {
    url, site: site?.id || null, signed_in: !!session?.logged_in,
    author: got.author || "", title: got.title || "", text: String(got.text || "").slice(0, 8000),
    description: got.description || "", card: got.card || "", links, via: got.via || "browser",
  };
}
