// URL normalization: this is the dedupe key for saved links. The rules (tracking parameters, fragment, trailing slash, default ports,
// lowercase host, sorted query, the LinkedIn job rule...) are the shared normalizeUrl of hoard-commons/web.js; this file only keeps
// Links' contract on top of it: null (not "") for something that is not an http(s) URL.
import { normalizeUrl as sharedNormalizeUrl, hostOf } from "./hoard-commons/web.js";

export function normalizeUrl(input) {
  return sharedNormalizeUrl(String(input ?? "")) || null;
}

export function siteOf(normalized) {
  return hostOf(normalized).replace(/^www\./, "");
}

export function isValidUrl(input) {
  return normalizeUrl(input) !== null;
}
