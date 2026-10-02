// The MCP bridge's HTTP call to the running app. It uses node:http instead of
// fetch because fetch gives up on a response that takes more than five minutes
// to start, and a download that waits for its file can take longer.
import http from "node:http";

/** How long the bridge waits for the app to answer one tool call. */
export function callTimeoutMs(name, args = {}) {
  if ((name === "media_download" || name === "media_retry") && args.wait !== false) return ((Number(args.timeout_s) || 150) + 30) * 1000;
  if (name === "media_status" && args.wait_s) return (Number(args.wait_s) + 30) * 1000;
  if (name === "media_tools" && args.update) return 6 * 60_000;
  if (name === "media_probe") return 120_000;
  return 90_000;
}

/** POST JSON to <base><pathname>. Resolves { status, ok, body }; rejects on connection errors and timeouts. */
export function postJson(base, pathname, payload, { token = "", timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(new URL(pathname, base), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("El servidor tardó demasiado en responder."), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(data);
  });
}
