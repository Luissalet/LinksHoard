// Shared test helpers: temp data dir and an in-process server on a free port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { close } from "../server/db.js";

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "links-hoard-test-"));
}

export async function bootServer() {
  const dataDir = tempDir();
  const { app, token } = createApp({ dataDir, dataDirConfigured: true, serveStatic: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, body: json };
  };
  const agent = (name, args) => call("POST", "/api/agent/call", { name, arguments: args }, { Authorization: `Bearer ${token}` });
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, dataDir, token, call, agent, stop };
}

/** Poll until a link's fetch_status is no longer "pending" (or timeout). */
export async function waitFetched(s, id, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const { body } = await s.call("GET", `/api/links/${id}`);
    if (body.fetch_status !== "pending") return body;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for fetch");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Start a tiny local HTTP server serving the given text at "/", for extraction/import tests. */
export async function serveText(text, contentType = "text/html; charset=utf-8") {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

export const FIXTURE_ARTICLE = `<!doctype html>
<html lang="en">
<head>
  <title>Ignore this title tag</title>
  <meta name="description" content="A short fixture description.">
  <meta property="og:title" content="The Real Article Title">
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <header><h1>Site Nav Header</h1></header>
  <article>
    <h1>The Real Article Title</h1>
    <p class="byline">By Jane Fixture</p>
    ${"<p>This is a paragraph of fixture body text meant to be long enough that Mozilla Readability recognises it as the main article content rather than boilerplate navigation chrome around the page. </p>".repeat(6)}
  </article>
  <footer>Copyright fixture footer text that should not appear in extracted content.</footer>
</body>
</html>`;
