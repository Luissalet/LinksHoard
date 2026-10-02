// The stdio MCP bridge end to end: a real client spawns server/mcp.js, which
// proxies to the in-process app that runs the fake yt-dlp from media-fakes.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bootServer, tempDir } from "./helpers.js";
import { installFakes } from "./media-fakes.js";
import { callTimeoutMs, postJson } from "../server/bridge-call.js";
import { resetToolsCache } from "../server/media.js";

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "mcp.js");
const ENV_KEYS = ["LINKS_YTDLP", "LINKS_GALLERYDL", "LINKS_FFMPEG", "PYTHON", "FAKE_DIR", "FAKE_LOG", "LINKS_MEDIA_DIR", "LINKS_MEDIA_SIBLING_DIR", "LINKS_MEDIA_AUTO_UPDATE"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let s, client, tmp, mediaDir;
before(async () => {
  tmp = tempDir();
  mediaDir = path.join(tmp, "descargas");
  Object.assign(process.env, installFakes(path.join(tmp, "fakes")).env, { LINKS_MEDIA_DIR: mediaDir });
  resetToolsCache();
  s = await bootServer();
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: { ...process.env, LINKS_URL: s.base, LINKS_TOKEN_FILE: path.join(s.dataDir, "mcp-token") },
  }));
});
after(async () => {
  await client.close();
  await s.stop();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetToolsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

test("the bridge lists the media tools with their descriptions and input schemas", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["media_download", "media_status", "media_cancel", "media_retry", "media_probe", "media_info", "media_subtitles", "media_audio_for_asr", "media_tools", "media_delete"]) assert.ok(names.includes(n), n);
  const dl = tools.find((t) => t.name === "media_download");
  assert.match(dl.description, /descárgame esto/);
  assert.deepEqual(dl.inputSchema.properties.format.enum, ["auto", "video", "audio", "image"]);
  assert.ok(dl.inputSchema.required.includes("url"));
});

test("media_download through MCP returns the file path, and failures come back as ok: false", async () => {
  const ok = await call("media_download", { url: "https://www.youtube.com/video/bridge1", save_link: false });
  assert.equal(ok.isError, false);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.files[0].path, path.join(mediaDir, "Título bridge1 [bridge1].mp4"));
  assert.ok(fs.existsSync(ok.body.files[0].path));
  const status = await call("media_status", { id: ok.body.id });
  assert.equal(status.body.status, "done");
  const bad = await call("media_download", { url: "https://www.youtube.com/gone/bridge2" });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /no está disponible/);
  const invalid = await call("media_download", { url: "ftp://nope" });
  assert.equal(invalid.isError, true);
});

test("the bridge waits as long as the call asks for, and says when the app is closed", async () => {
  assert.equal(callTimeoutMs("media_download", { timeout_s: 600 }), 630_000);
  assert.equal(callTimeoutMs("media_download", { wait: false }), 90_000);
  assert.equal(callTimeoutMs("media_retry", {}), 180_000);
  assert.equal(callTimeoutMs("media_status", { id: "x", wait_s: 60 }), 90_000);
  assert.equal(callTimeoutMs("media_tools", { update: true }), 360_000);
  assert.equal(callTimeoutMs("list_links", {}), 90_000);
  const unauthorised = await postJson(s.base, "/api/agent/call", { name: "list_links", arguments: {} }, { token: "nope" });
  assert.equal(unauthorised.status, 401);
  assert.equal(unauthorised.ok, false);
  await assert.rejects(postJson("http://127.0.0.1:1", "/api/agent/call", {}), (e) => e.code === "ECONNREFUSED");
});
