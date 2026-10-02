// MCP stdio bridge. It never opens the database: every call is proxied to the running app (POST /api/agent/call) with the token from
// <DATA_DIR>/mcp-token. The proxying, the per-call timeout, the heartbeat for long calls, the "app is closed" message and the
// outcome_unknown answer for a change that may have been applied are createBridge of hoard-commons/express.js.
import "./no-sqlite-warning.js"; // must load before anything that imports node:sqlite (agent-tools.js -> links.js -> db.js)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, AGENT_INSTRUCTIONS, callTimeoutMs } from "./agent-tools.js";
import { createBridge } from "./hoard-commons/express.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = createRequire(import.meta.url)("../package.json");
const base = process.env.LINKS_URL || `http://127.0.0.1:${process.env.LINKS_PORT || process.env.PORT || 5181}`;
const tokenFile = process.env.LINKS_TOKEN_FILE
  || path.join(process.env.LINKS_DATA_DIR || path.join(root, "data"), "mcp-token");

const bridge = createBridge({
  app: "links", service: "links-hoard", version, McpServer, StdioServerTransport,
  tools: TOOLS, instructions: AGENT_INSTRUCTIONS, baseUrl: base, token: process.env.LINKS_TOKEN || "", tokenFile, callTimeoutMs,
  messages: {
    title: "Links Hoard",
    offline: "Abre Links Hoard (npm start) para acceder a tus datos.",
    noToken: `Links Hoard está abierto, pero este puente no tiene su token (${tokenFile}).`,
    tokenRefused: `Links Hoard rechazó el token de este puente (${tokenFile}): es de otra carpeta de datos.`,
    outcomeUnknown: "No llegó respuesta. Puede que el cambio se haya aplicado: consulta el estado actual antes de repetirlo.",
  },
});
await bridge.start();
