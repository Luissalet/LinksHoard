// A fake Chromium for the site-login tests, started as LINKS_LOGIN_BROWSER="node:<this file>". It answers the few DevTools calls
// Links makes (Storage.getCookies, Target.createTarget/attachToTarget/closeTarget, Network.deleteCookies, Browser.close) over a
// minimal WebSocket server, and keeps its cookie jar in <user-data-dir>/fake-cookies.json so a test can "sign in" by writing it.
// Every launch appends its arguments to <user-data-dir>/fake-launches.jsonl.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const profile = (args.find((a) => a.startsWith("--user-data-dir=")) || "").slice("--user-data-dir=".length);
fs.mkdirSync(profile, { recursive: true });
const launchLog = path.join(profile, "fake-launches.jsonl");
const firstLaunch = !fs.existsSync(launchLog);
fs.appendFileSync(launchLog, `${JSON.stringify(args)}\n`);
const jar = path.join(profile, "fake-cookies.json");
const readJar = () => { try { return JSON.parse(fs.readFileSync(jar, "utf8")); } catch { return []; } };
const writeJar = (cookies) => fs.writeFileSync(jar, JSON.stringify(cookies));

function frame(text) {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

// the open tabs: what the browser was started with (its last argument), recorded in <user-data-dir>/fake-pages.json
const pages = [{ id: "t0", url: args.filter((a) => !a.startsWith("--")).pop() || "about:blank" }];
const writePages = () => fs.writeFileSync(path.join(profile, "fake-pages.json"), JSON.stringify(pages));
writePages();

function handle(message, socket) {
  const { id, method, params = {} } = JSON.parse(message);
  let result = {};
  if (method === "Storage.getCookies") result = { cookies: readJar() };
  else if (method === "Target.getTargets") result = { targetInfos: pages.map((p) => ({ targetId: p.id, type: "page", url: p.url })) };
  else if (method === "Target.createTarget") { const id = `t${pages.length + 1}`; pages.push({ id, url: params.url }); result = { targetId: id }; }
  else if (method === "Target.closeTarget") { const i = pages.findIndex((p) => p.id === params.targetId); if (i >= 0) pages.splice(i, 1); writePages(); }
  else if (method === "Target.attachToTarget") result = { sessionId: "s1" };
  else if (method === "Network.deleteCookies") writeJar(readJar().filter((c) => !(c.name === params.name && c.domain === params.domain)));
  else if (method === "Browser.close") { socket.write(frame(JSON.stringify({ id, result: {} }))); setTimeout(() => process.exit(0), 50); return; }
  if (method === "Target.createTarget") writePages();
  socket.write(frame(JSON.stringify({ id, result })));
}

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(total);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 1) handle(data.toString("utf8"), socket);
    }
  });
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/fake`);
});
// FAKE_BROWSER_QUIT_FIRST=1: like a real browser finishing a new profile's setup, the very first window quits on its own
if (firstLaunch && process.env.FAKE_BROWSER_QUIT_FIRST === "1" && !args.includes("--headless=new")) setTimeout(() => process.exit(0), 300);
