// Shared test helpers: temp data dir and an in-process server on a free port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { close } from "../server/db.js";
import { drain } from "../server/fetcher.js";

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "links-hoard-test-"));
}

export async function bootServer(options = {}) {
  const dataDir = tempDir();
  const { app, token } = createApp({ dataDir, dataDirConfigured: true, serveStatic: false, ...options });
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
    // Let any still-queued/in-flight background fetch finish and write its
    // result before the database goes away, or it would throw "Database not
    // initialised" from an unawaited async task after the test has ended.
    await drain();
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

// Mimics the real-world Wikipedia page reported as producing a wrong excerpt
// (the infobox instead of the lead paragraph) and glued-together text
// (table cells and adjacent blocks concatenated without spaces): an infobox
// table before the lead paragraph, reference superscripts inline in the
// prose, an edit-section span, a table of contents, a genuine in-article
// table that must stay readable, and a navbox at the end.
export const FIXTURE_WIKI = `<!doctype html>
<html lang="es">
<head><title>Jorge Luis Borges - Wikipedia</title>
<meta name="description" content="Escritor argentino."></head>
<body>
<nav id="mw-panel" role="navigation"><ul><li><a href="/">Portada</a></li></ul></nav>
<div id="content"><div id="bodyContent"><div id="mw-content-text">
<table class="infobox biography vcard">
<tbody>
<tr><th colspan="2">Jorge Luis Borges</th></tr>
<tr><td colspan="2">Retrato de Borges en 1951</td></tr>
<tr><th>Información personal</th></tr>
<tr><th>Nombre de nacimiento</th><td>Jorge Francisco Isidoro Luis Borges Acevedo</td></tr>
<tr><th>Nacimiento</th><td>24 de agosto de 1899<br>Buenos Aires, Argentina</td></tr>
<tr><th>Fallecimiento</th><td>14 de junio de 1986 (86 años)<br>Ginebra, Suiza</td></tr>
<tr><th>Causa de muerte</th><td>Cáncer de hígado</td></tr>
<tr><th>Sepultura</th><td>Cementerio de los Reyes</td></tr>
<tr><th>Nacionalidad</th><td>argentina</td></tr>
<tr><th>Religión</th><td>Agnosticismo</td></tr>
</tbody>
</table>
<div class="sidebar">Enlaces relacionados de la barra lateral.</div>
<p><b>Jorge Luis Borges</b><sup class="reference">[1]</sup> (Buenos Aires, 24 de agosto de 1899-Ginebra, 14 de junio de 1986) fue un escritor, poeta, ensayista y traductor argentino, considerado una de las figuras más destacadas de la literatura del siglo XX y una de las principales de la lengua española.<sup class="reference">[2]</sup></p>
<p>Nacido en el seno de una familia de clase media acomodada, Borges se crio en el barrio porteño de Palermo, un lugar que se convirtió en tema de algunas de sus obras posteriores.<sup class="reference">[3]</sup></p>
<div class="toc" id="toc"><div class="toctitle">Contenido</div><ul><li>1 Biografía</li><li>2 Obra</li></ul></div>
<h2>Obra literaria<span class="mw-editsection">[<a href="#">editar</a>]</span></h2>
<p>Entre sus obras más conocidas se encuentran Ficciones y El Aleph, colecciones de relatos que exploran temas como el infinito, los laberintos y los espejos.</p>
<table class="wikitable">
<tbody>
<tr><th>Obra</th><th>Año</th></tr>
<tr><td>Ficciones</td><td>1944</td></tr>
<tr><td>El Aleph</td><td>1949</td></tr>
</tbody>
</table>
</div></div></div>
<div class="navbox" role="navigation"><div class="navbox-title">Plantilla Jorge Luis Borges</div><ul><li><a href="#">El libro de arena</a></li><li><a href="#">Obras completas Emecé Editores</a></li></ul></div>
</body>
</html>`;
