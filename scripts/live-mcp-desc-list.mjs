// Live tools/list for #309: boot the worktree server + MCP stdio and check media_download.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "../tests/helpers.js";

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "mcp.js");

const s = await bootServer();
const client = new Client({ name: "task-309-live", version: "1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [MCP],
  env: { ...process.env, LINKS_URL: s.base, LINKS_TOKEN_FILE: path.join(s.dataDir, "mcp-token") },
}));
try {
  const { tools } = await client.listTools();
  const oversized = tools.filter((t) => (t.description || "").length > 1000).map((t) => `${t.name}:${t.description.length}`);
  if (oversized.length) throw new Error(`oversized: ${oversized.join(", ")}`);
  const dl = tools.find((t) => t.name === "media_download");
  if (!dl) throw new Error("media_download missing");
  const chars = dl.description.length;
  const tokens = Math.ceil(chars / 3);
  if (chars > 750 || tokens > 250) throw new Error(`media_download ${chars} chars ~${tokens} tokens`);
  if (!/descárgame esto/.test(dl.description)) throw new Error("missing synonym");
  console.log(`PASS live tools/list: ${tools.length} tools, media_download ${chars} chars (~${tokens} tokens)`);
} finally {
  await client.close();
  await s.stop();
}
