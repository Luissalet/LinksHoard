// Builds the Express app. server/index.js boots it; tests call createApp()
// with a temporary data directory and listen on a free port.
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { init as initDb } from "./db.js";
import { installRoutes } from "./routes.js";
import { installAgentRoutes, loadToken } from "./agent-routes.js";
import * as family from "./hoard-link.js";
import { startScheduler } from "./watches.js";
import { installMediaRoutes } from "./media-routes.js";
import { initMedia } from "./media.js";
import { createGuard, installSpa, installErrorHandlers } from "./hoard-commons/express.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export const ROOT = path.join(__dirname, "..");

export function resolveDataDir(env = process.env) {
  return env.LINKS_DATA_DIR || path.join(ROOT, "data");
}

export function createApp({ dataDir, dataDirConfigured = false, serveStatic = true, allowedHosts = process.env.LINKS_ALLOWED_HOSTS } = {}) {
  initDb(dataDir);
  const token = loadToken(dataDir);
  // Hoard Link 0.4: this app on the family bus (agent.call events, calls to
  // siblings through the hub, the hoard_link block in /api/health).
  family.configure({ app: "links", dataDir });
  // Watches are checked every minute for the ones whose interval has passed (LINKS_WATCHES=0 turns it off).
  if (process.env.LINKS_WATCHES !== "0") startScheduler();
  // Media downloads: fix rows left by a previous run and re-queue the ones that never started.
  initMedia();

  const app = express();
  app.disable("x-powered-by");
  app.use(createGuard({ allowedHosts }));
  app.use(express.json({ limit: "10mb" }));
  installRoutes(app, { version, dataDirConfigured });
  installMediaRoutes(app);
  installAgentRoutes(app, { token });
  const DIST = path.join(ROOT, "dist");
  if (serveStatic && fs.existsSync(DIST)) installSpa(app, DIST, { express });
  else app.all(/^\/api(\/.*)?$/, (req, res) => res.status(404).json({ error: "Ruta no encontrada.", code: "not_found" }));
  installErrorHandlers(app);
  return { app, token, version };
}
