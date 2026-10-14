#!/usr/bin/env node
// Command line for the video digest of a running Links Hoard: what an assistant on another machine (or a script) runs to have a video
// "watched" locally and read only the text.
//
//   node scripts/digest.mjs <url> [--focus "what I want"] [--level brief|card|index|visual|transcript|full] [--force] [--no-wait]
//   node scripts/digest.mjs --id <link id> [--level transcript] [--from 3:00 --to 5:00]
//   node scripts/digest.mjs --id <link id> --ask "¿Qué dice de la caché?"
//   node scripts/digest.mjs --find "palabra" [--id <link id>]
//   node scripts/digest.mjs --id <link id> --frame 3:45 [--width 1024]
//   node scripts/digest.mjs --list
//
// Progress goes to stderr; the result (the text of the level, or JSON with --json / --ask / --find / --frame / --list) to stdout, or to
// --out <file> as UTF-8. The app's address: LINKS_URL, else http://127.0.0.1:<LINKS_PORT|5181>; its token: <data>/mcp-token.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opts = { level: "brief", wait: true, timeout: 3600 };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--focus") opts.focus = next();
  else if (a === "--level") opts.level = next();
  else if (a === "--id") opts.id = next();
  else if (a === "--from") opts.from = next();
  else if (a === "--to") opts.to = next();
  else if (a === "--ask") opts.ask = next();
  else if (a === "--find") opts.find = next();
  else if (a === "--frame") opts.frame = next();
  else if (a === "--width") opts.width = Number(next());
  else if (a === "--path") opts.path = next();
  else if (a === "--out") opts.out = next();
  else if (a === "--timeout") opts.timeout = Number(next());
  else if (a === "--language") opts.language = next();
  else if (a === "--force") opts.force = true;
  else if (a === "--redo-media") opts.redo_media = true;
  else if (a === "--no-wait") opts.wait = false;
  else if (a === "--json") opts.json = true;
  else if (a === "--list") opts.list = true;
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n")); process.exit(0); }
  else positional.push(a);
}
if (positional[0]) opts.url = positional[0];

const base = process.env.LINKS_URL || `http://127.0.0.1:${process.env.LINKS_PORT || 5181}`;
const tokenFile = process.env.LINKS_TOKEN_FILE || path.join(process.env.LINKS_DATA_DIR || path.join(root, "data"), "mcp-token");
let token = process.env.LINKS_TOKEN || "";
if (!token) { try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { console.error(`No hay token en ${tokenFile}: ¿está Links Hoard instalado aquí?`); process.exit(2); } }

async function call(name, args, timeoutMs = 120_000) {
  const res = await fetch(`${base}/api/agent/call`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => { console.error(`Links Hoard no responde en ${base} (${e.cause?.code || e.message}). Ábrelo desde el Hub o con npm start.`); process.exit(3); });
  const body = await res.json().catch(() => null);
  if (!res.ok) { console.error(`Error ${res.status}: ${body?.error || "sin detalle"}`); process.exit(4); }
  return body;
}

function emit(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (opts.out) { fs.writeFileSync(opts.out, text, "utf8"); console.error(`Escrito en ${path.resolve(opts.out)}`); } else process.stdout.write(`${text}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (opts.list) emit(await call("video_digests", { limit: 50 }));
else if (opts.find) emit(await call("video_find", { query: opts.find, ...(opts.id ? { id: opts.id } : {}) }));
else if (opts.ask) emit(await call("video_ask", { id: opts.id, url: opts.url, question: opts.ask }, 960_000));
else if (opts.frame) emit(await call("video_frame", { id: opts.id, url: opts.url, t: opts.frame, ...(opts.width ? { width: opts.width } : {}) }));
else if (opts.id && !opts.url && !opts.force && !opts.focus && !opts.path) {
  const view = await call("video_digest_read", { id: opts.id, level: opts.level, ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}), max_chars: 400000 });
  emit(opts.json ? view : view.text ?? `(estado: ${view.status}${view.detail ? ` · ${view.detail}` : ""})`);
} else {
  if (!opts.url && !opts.id) { console.error("Indica una URL o --id. --help para ver el uso."); process.exit(1); }
  const args = { url: opts.url, id: opts.id, path: opts.path, focus: opts.focus, force: !!opts.force, redo_media: !!opts.redo_media, language: opts.language, level: "none", wait: false };
  let view = await call("video_digest", args);
  console.error(`Digest de ${view.title || view.url} (${view.link_id}): ${view.status}`);
  const end = Date.now() + opts.timeout * 1000;
  let last = "";
  while (opts.wait && ["queued", "running"].includes(view.status) && Date.now() < end) {
    await sleep(5000);
    view = await call("video_digests", { limit: 200 }).then((r) => r.digests.find((d) => d.link_id === view.link_id) || view);
    const line = `${view.status}${view.stage ? ` · ${view.stage}` : ""}${view.detail ? ` · ${view.detail}` : ""}`;
    if (line !== last) { console.error(line); last = line; }
  }
  const id = view.link_id;
  if (!opts.wait || ["queued", "running"].includes(view.status)) { emit(opts.json ? view : `Sigue en marcha (${view.status}). Vuelve con: node scripts/digest.mjs --id ${id}`); process.exit(0); }
  const full = await call("video_digest_read", { id, level: opts.level, max_chars: 400000 });
  if (opts.json) emit(full);
  else {
    console.error(`Estado: ${full.status}${full.error ? ` · ${full.error}` : ""} · carpeta: ${full.dir || "-"} · brief ≈ ${full.stats?.tokens?.brief ?? "?"} tokens`);
    emit(full.text ?? `(sin texto: ${full.error || full.detail || full.status})`);
  }
}
