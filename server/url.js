// URL normalization: this is the dedupe key for saved links. Strip tracking
// params, fragments and a trailing slash; lowercase the host.
const TRACKING_PREFIXES = ["utm_"];
const TRACKING_EXACT = new Set(["fbclid", "gclid", "gclsrc", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref"]);

export function normalizeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    const lower = key.toLowerCase();
    if (TRACKING_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (TRACKING_EXACT.has(lower)) continue;
    kept.append(key, value);
  }
  kept.sort();
  const query = kept.toString();
  parsed.search = query ? `?${query}` : "";
  // Strip a single trailing slash from the path (but keep the bare root "/").
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

export function siteOf(normalized) {
  try {
    return new URL(normalized).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isValidUrl(input) {
  return normalizeUrl(input) !== null;
}
