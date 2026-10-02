// The address this app is served on, so events can carry a link back to it.
// server/index.js sets it once the port is known; tests leave it empty.
let base = "";

export function setPublicUrl(url) { base = String(url || "").replace(/\/+$/, ""); }

/** `<base>/#/<route>`, or "" when the address is not known. */
export function appLink(route = "") { return base ? `${base}/#/${String(route).replace(/^#?\/?/, "")}` : ""; }
