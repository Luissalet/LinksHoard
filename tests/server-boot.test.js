// The real entry point (server/index.js): it finds a free port, serves, keeps the token across restarts and shuts down cleanly on SIGTERM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "index.js");

const start = (dataDir, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, LINKS_DATA_DIR: dataDir, LINKS_PORT: "5391", LINKS_WATCHES: "0", LINKS_RESURFACE: "0", LINKS_MEDIA_DIR: path.join(dataDir, "media"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no start: ${out}`)); }, 15_000);
  child.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/en http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), out: () => out }); }
  });
  child.stderr.on("data", (d) => { out += d; });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)); });
});

const stop = (child) => new Promise((resolve) => {
  child.removeAllListeners("exit");
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.kill("SIGTERM");
});

test("the server starts, keeps its token across restarts and exits 0 on SIGTERM", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-boot-"));
  try {
    const one = await start(dir);
    const health = await (await fetch(`http://127.0.0.1:${one.port}/api/health`)).json();
    assert.equal(health.ok ?? true, true);
    const token = fs.readFileSync(path.join(dir, "mcp-token"), "utf8").trim();
    assert.ok(token.length >= 32);
    const gone = await stop(one.child);
    assert.equal(gone.code, 0, one.out());
    assert.match(one.out(), /Closing Links Hoard \(SIGTERM\)/);

    const two = await start(dir);
    assert.equal(fs.readFileSync(path.join(dir, "mcp-token"), "utf8").trim(), token, "the token survives a restart");
    const ok = await fetch(`http://127.0.0.1:${two.port}/api/agent/call`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "list_tags", arguments: {} }),
    });
    assert.equal(ok.status, 200);
    await stop(two.child);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when the preferred port is taken the next free one is used and said", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-boot-"));
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(5392, "127.0.0.1", r));
  try {
    const run = await start(dir, { LINKS_PORT: "5392" });
    assert.ok(run.port > 5392);
    assert.match(run.out(), /Puerto 5392 ocupado/);
    await stop(run.child);
  } finally {
    await new Promise((r) => blocker.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
