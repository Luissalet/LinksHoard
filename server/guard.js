// Request guard shared by every Hoard app: which Host values are accepted,
// which Origins may call the API and which Fetch Metadata combinations are
// let through. Pure functions over plain header objects so the rules are
// unit-testable; createGuard() wraps them as Express middleware.
//
// Rules (identical in every app):
// 1. Host: localhost / 127.0.0.1 / [::1] plus the comma-separated env list
//    (exact hostnames or "*.suffix"), compared without port, case-insensitive.
// 2. Origin (when present): its host must pass the host rule (any scheme or
//    port), or be one of the Vite dev origins.
// 3. Fetch Metadata: a cross-site request is only accepted when it is a
//    top-level navigation (mode "navigate" and not embedded in a frame).
//    Requests without Sec-Fetch-* headers (curl, the MCP bridge) pass.
// 4. State-changing methods are never accepted as navigations (an HTML form
//    post from another page): the API takes JSON from fetch() only.

export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"];
const FRAME_DESTS = new Set(["iframe", "frame", "embed", "object"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host part of a Host header, Origin or URL: no scheme, no path, no port, lowercase. */
export function hostOf(value) {
  let host = String(value || "").trim().toLowerCase();
  const scheme = host.indexOf("://");
  if (scheme !== -1) host = host.slice(scheme + 3);
  host = host.split("/")[0];
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(":")[0];
}

/** Parse "a.example, *.ts.net" into a clean list of patterns. */
export function parseAllowedHosts(raw) {
  return String(raw || "")
    .split(",")
    .map((entry) => (entry.trim().startsWith("*.") ? "*." + hostOf(entry.trim().slice(2)) : hostOf(entry)))
    .filter((entry) => entry && entry !== "*.");
}

export function isAllowedHost(host, allowedHosts = []) {
  if (!host) return false;
  for (const pattern of [...LOCAL_HOSTS, ...allowedHosts]) {
    if (pattern.startsWith("*.")) {
      if (host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1) return true;
    } else if (host === pattern) return true;
  }
  return false;
}

/** Returns null when the request may proceed, otherwise the error message. */
export function checkRequest({ method = "GET", headers = {} }, allowedHosts = []) {
  if (!isAllowedHost(hostOf(headers.host), allowedHosts)) return "Solo se permite acceso local.";
  const origin = headers.origin;
  if (origin && !DEV_ORIGINS.includes(origin) && !isAllowedHost(hostOf(origin), allowedHosts)) return "Origen no permitido.";
  const site = headers["sec-fetch-site"];
  const mode = headers["sec-fetch-mode"];
  const dest = headers["sec-fetch-dest"];
  if (site === "cross-site" && (mode !== "navigate" || FRAME_DESTS.has(dest))) return "Petición desde otra web no permitida.";
  if (mode === "navigate" && !SAFE_METHODS.has(String(method).toUpperCase())) return "Envío de formulario no permitido.";
  return null;
}

/** Express middleware: 403 { error } when checkRequest() rejects. */
export function createGuard(allowedHosts = []) {
  const allowed = Array.isArray(allowedHosts) ? allowedHosts : parseAllowedHosts(allowedHosts);
  return function guard(req, res, next) {
    const error = checkRequest(req, allowed);
    if (error) return res.status(403).json({ error });
    next();
  };
}
