// MCP stdio bridge. It never opens the database: every call is proxied to the
// running app (POST /api/agent/call) with the token from <DATA_DIR>/mcp-token.
import "./no-sqlite-warning.js"; // must load before anything that imports node:sqlite (agent-tools.js -> links.js -> db.js)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, AGENT_INSTRUCTIONS } from "./agent-tools.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = createRequire(import.meta.url)("../package.json");
const base = process.env.LINKS_URL || `http://127.0.0.1:${process.env.LINKS_PORT || process.env.PORT || 5181}`;
const parsed = new URL(base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.protocol !== "http:")
  throw Error("El puente MCP solo se conecta al servidor local.");
const tokenFile = process.env.LINKS_TOKEN_FILE
  || path.join(process.env.LINKS_DATA_DIR || path.join(root, "data"), "mcp-token");

const server = new McpServer({ name: "links-hoard", version }, { instructions: AGENT_INSTRUCTIONS });
for (const tool of TOOLS)
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations },
    async (args) => {
      try {
        const token = process.env.LINKS_TOKEN || fs.readFileSync(tokenFile, "utf8").trim();
        const response = await fetch(new URL("/api/agent/call", base), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: tool.name, arguments: args }),
          signal: AbortSignal.timeout(90000),
        });
        const body = await response.json();
        if (!response.ok) throw Error(body.error || `Error ${response.status}`);
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      } catch (e) {
        const offline = e.code === "ENOENT" || e.message === "fetch failed";
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({
            error: offline ? "Abre Links Hoard (npm start) para acceder a tus datos." : e.message,
          }) }],
        };
      }
    },
  );
await server.connect(new StdioServerTransport());
