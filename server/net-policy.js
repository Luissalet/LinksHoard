// Which addresses Links Hoard may reach on the user's behalf (pages, feeds, media links) and how it reaches them.
//
// By default only the public internet: the shared fetcher (hoard-commons/web.js) refuses loopback, private, link-local and cloud
// metadata addresses, and checks every redirect hop. A user who saves pages from a server on their own network (a NAS, a wiki on
// the LAN) opts in with LINKS_ALLOW_PRIVATE_URLS=1, which switches to the "operator_local" profile of the commons. The variable is
// read on every call so a test (or a settings change plus restart) never needs a reload.
import { envFlag } from "./hoard-commons/server.js";
import { PUBLIC, OPERATOR_LOCAL, webGet } from "./hoard-commons/web.js";
import { webFetchOrLocal } from "./hoard-commons/fam-web.js";

export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LinksHoard/1.0";

export const allowPrivateUrls = (env = process.env) => envFlag("LINKS_ALLOW_PRIVATE_URLS", false, env);

/** The safety profile of the commons for fetches the person asked for. */
export const fetchProfile = (env = process.env) => (allowPrivateUrls(env) ? OPERATOR_LOCAL : PUBLIC);

const snakeKey = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * One GET for a watch (feed or page), as the hub's snake_case answer: { ok, status, final_url, text, etag, last_modified, not_modified,
 * blocked, block_reason, error, error_kind, headers, via }. Public addresses go through the family hub when it is there (one polite
 * fetcher for every app, shared robots.txt and block cooldowns) and through the shared local fetcher otherwise; an opted-in private
 * network is always fetched locally, because the hub only reaches the public internet.
 */
export async function fetchForWatch(url, { etag = "", lastModified = "", timeoutMs = 20_000, maxBytes = 3 * 1024 * 1024 } = {}) {
  const common = { accept: "html", etag, lastModified, timeoutMs, maxBytes };
  if (allowPrivateUrls()) {
    const fr = await webGet(url, { ...common, profile: OPERATOR_LOCAL, userAgent: USER_AGENT });
    const { body, ...rest } = fr;
    const out = {};
    for (const [k, v] of Object.entries(rest)) out[snakeKey(k)] = v;
    return { ...out, via: "local" };
  }
  return webFetchOrLocal(url, {
    ...common, respectRobots: false,
    localGet: (u, o) => webGet(u, { ...o, profile: PUBLIC, userAgent: USER_AGENT }),
  });
}
