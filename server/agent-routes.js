// /api/agent/* — the bridge used by server/mcp.js. A random token is written
// to <DATA_DIR>/mcp-token at startup; every call must carry it as Bearer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { TOOLS, AGENT_INSTRUCTIONS, callTool } from "./agent-tools.js";
import * as family from "./hoard-link.js";

export function writeToken(dataDir) {
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "mcp-token"), token, { mode: 0o600 });
  return token;
}

export function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    annotations: t.annotations,
    inputSchema: z.toJSONSchema(t.schema, { io: "input" }),
  }));
}

export function installAgentRoutes(app, { token }) {
  app.get("/api/agent/tools", (req, res) => {
    res.json({ instructions: AGENT_INSTRUCTIONS, tools: toolCatalog() });
  });

  // family.recordAgentRoute: one agent.call event per call on the hub's bus.
  app.post("/api/agent/call", family.recordAgentRoute(async (req, res) => {
    const header = req.headers.authorization || "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return res.status(401).json({ error: "Token MCP no válido." });
    const { name, arguments: args } = req.body || {};
    if (typeof name !== "string") return res.status(400).json({ error: "Falta el nombre de la herramienta." });
    try {
      res.json(await callTool(name, args));
    } catch (error) {
      const status = error.status || (error.issues ? 400 : 500);
      const message = error.issues
        ? error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
        : error.message;
      res.status(status).json({ error: message });
    }
  }));
}
