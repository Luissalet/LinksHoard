// /api/agent/* — the bridge used by server/mcp.js and by the family hub. The two routes (tool list and call, Bearer token, result cap,
// one error envelope, the agent.call audit event) are makeAgentRoutes of hoard-commons/express.js; the token file is the shared
// readOrCreateToken, so it stays the same across restarts and a bridge that is already running keeps working.
import path from "node:path";
import { z } from "zod";
import { TOOLS, AGENT_INSTRUCTIONS } from "./agent-tools.js";
import { makeAgentRoutes } from "./hoard-commons/express.js";
import { readOrCreateToken } from "./hoard-commons/server.js";
import * as family from "./hoard-link.js";

/** The bearer token of this data folder: <DATA_DIR>/mcp-token, created once and then kept. */
export const loadToken = (dataDir) => readOrCreateToken(path.join(dataDir, "mcp-token"));

export function installAgentRoutes(app, { token }) {
  makeAgentRoutes({ app: "links", tools: TOOLS, z, token, instructions: AGENT_INSTRUCTIONS, recordCall: family.recordCall }).install(app);
}
