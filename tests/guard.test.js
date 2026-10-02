// Request guard: host allow-list, Origin rule and Fetch Metadata rules.
// Unit tests on the pure functions plus HTTP tests against the real app.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { checkRequest, createGuard, hostOf, isAllowedHost, parseAllowedHosts } from "../server/hoard-commons/express.js";
import { bootServer } from "./helpers.js";

// fetch() overwrites the Host header, so raw http.request is used to forge it.
function raw(base, { method = "GET", path = "/", headers = {}, body } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path, headers: { host: url.host, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const NAV = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const CORS = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
const IFRAME = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
const JSON_BODY = { "content-type": "application/json" };

test("hostOf strips scheme, path and port and lowercases", () => {
  assert.equal(hostOf("LocalHost:5180"), "localhost");
  assert.equal(hostOf("https://My-PC.ts.net:8443/x"), "my-pc.ts.net");
  assert.equal(hostOf("[::1]:5180"), "[::1]");
  assert.equal(hostOf(""), "");
});

test("parseAllowedHosts accepts exact names and *.suffix patterns, and keeps a pinned port", () => {
  assert.deepEqual(parseAllowedHosts(" pc.example , *.TS.net,, pc2.example:8443"), ["pc.example", "*.ts.net", "pc2.example:8443"]);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});

test("isAllowedHost: local hosts, exact and wildcard entries, unknown rejected", () => {
  const allowed = parseAllowedHosts("pc.example,*.ts.net");
  for (const host of ["localhost", "127.0.0.1", "[::1]", "pc.example", "my-pc.ts.net", "a.b.ts.net"]) assert.ok(isAllowedHost(host, null, allowed), host);
  for (const host of ["ts.net", "evil.example", "pc.example.evil", "", undefined]) assert.equal(isAllowedHost(host, null, allowed), false, String(host));
  assert.equal(isAllowedHost("my-pc.ts.net", null, []), false);
  // an entry with a port only matches that port
  const pinned = parseAllowedHosts("pc2.example:8443");
  assert.ok(isAllowedHost("pc2.example:8443", null, pinned));
  assert.equal(isAllowedHost("pc2.example:9999", null, pinned), false);
});

test("checkRequest: fetch metadata rules", () => {
  const ok = (method, headers) => assert.equal(checkRequest(method, headers), null);
  const bad = (method, headers) => assert.equal(checkRequest(method, headers)?.[0], 403);
  ok("GET", { host: "localhost:5180" }); // curl / MCP bridge: no Sec-Fetch headers
  ok("POST", { host: "127.0.0.1:5180" });
  ok("GET", { host: "localhost", ...NAV }); // top-level navigation from another site
  ok("GET", { host: "localhost", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
  bad("GET", { host: "localhost", ...CORS }); // cross-site fetch
  bad("GET", { host: "localhost", ...IFRAME });
  bad("GET", { host: "localhost", ...NAV, "sec-fetch-dest": "embed" });
  bad("POST", { host: "localhost", ...NAV }); // form post from another site
  bad("POST", { host: "localhost", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" });
  bad("GET", { host: "evil.example" });
});

test("checkRequest: Origin passes on host, not on exact string", () => {
  const allowed = parseAllowedHosts("*.ts.net");
  const headers = (origin) => ({ host: "my-pc.ts.net", origin });
  assert.equal(checkRequest("GET", headers("https://my-pc.ts.net:8443"), null, allowed), null);
  assert.equal(checkRequest("GET", headers("http://localhost:5180"), null, allowed), null);
  assert.equal(checkRequest("GET", headers("http://localhost:5173"), null, allowed), null); // vite dev
  assert.equal(checkRequest("GET", headers("https://evil.example"), null, allowed)?.[0], 403);
  assert.equal(checkRequest("GET", { host: "localhost", origin: "http://my-pc.ts.net" })?.[0], 403); // not in the list
});

test("guard middleware: cross-site navigation reaches /, embedding and fetches do not", async () => {
  const app = express();
  app.use(createGuard({ allowedHosts: "*.ts.net" }));
  app.get("/", (req, res) => res.send("home"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await raw(base, { headers: NAV })).status, 200);
    assert.equal((await raw(base, { headers: { ...NAV, host: "my-pc.ts.net" } })).status, 200);
    assert.equal((await raw(base, { headers: IFRAME })).status, 403);
    assert.equal((await raw(base, { headers: CORS })).status, 403);
    assert.equal((await raw(base, { headers: { host: "other.example", ...NAV } })).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app: host allow-list, Origin and cross-site rules over the API", async () => {
  const s = await bootServer({ allowedHosts: "pc.example, *.ts.net" });
  try {
    const health = "/api/health";
    // Host rule: local, exact, wildcard; unknown rejected; case and port ignored.
    assert.equal((await raw(s.base, { path: health })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: { host: "pc.example" } })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: { host: "My-PC.ts.net:8443" } })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: { host: "evil.example" } })).status, 403);
    assert.equal((await raw(s.base, { path: health, headers: { host: "ts.net" } })).status, 403);
    // Origin rule: allowed host with any scheme/port; anything else 403.
    assert.equal((await raw(s.base, { path: health, headers: { origin: "https://my-pc.ts.net:8443" } })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: { origin: "http://localhost:5173" } })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: { origin: "https://evil.example" } })).status, 403);
    // Fetch Metadata: navigation ok, cross-site fetch / iframe / form post rejected.
    assert.equal((await raw(s.base, { path: health, headers: NAV })).status, 200);
    assert.equal((await raw(s.base, { path: health, headers: CORS })).status, 403);
    assert.equal((await raw(s.base, { path: health, headers: IFRAME })).status, 403);
    const post = { method: "POST", path: "/api/agent/call", body: "{}" };
    assert.equal((await raw(s.base, { ...post, headers: { ...JSON_BODY, ...NAV } })).status, 403);
    assert.equal((await raw(s.base, { ...post, headers: { ...JSON_BODY, ...CORS, origin: "https://evil.example" } })).status, 403);
    const same = await raw(s.base, { ...post, headers: { ...JSON_BODY, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
    assert.notEqual(same.status, 403); // reaches the route (which then wants a token)
  } finally {
    await s.stop();
  }
});

test("app: no ALLOWED_HOSTS means local only", async () => {
  const s = await bootServer({ allowedHosts: "" });
  try {
    assert.equal((await raw(s.base, { path: "/api/health", headers: { host: "my-pc.ts.net" } })).status, 403);
    assert.equal((await raw(s.base, { path: "/api/health", headers: { host: "[::1]:5180" } })).status, 200);
  } finally {
    await s.stop();
  }
});

test("app: the share target is a cross-site navigation and must work", async () => {
  const s = await bootServer();
  try {
    const share = "/share?url=" + encodeURIComponent("https://example.com/article");
    const r = await raw(s.base, { path: share, headers: NAV });
    assert.equal(r.status, 200);
    assert.match(r.text, /Guardado/);
    assert.equal((await raw(s.base, { path: share, headers: IFRAME })).status, 403);
  } finally {
    await s.stop();
  }
});
