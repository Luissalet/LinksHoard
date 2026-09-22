// Runs the API server (node --watch) and the Vite dev server together on
// coordinated ports, so the /api proxy always points at the right place.
import { spawn } from "node:child_process";
import { findAvailablePort, validPort } from "../server/port.js";

const apiPort = await findAvailablePort(validPort(process.env.LINKS_PORT || process.env.PORT, 5181));
const vitePort = await findAvailablePort(validPort(process.env.VITE_PORT, 5173));
const env = {
  ...process.env,
  PORT: String(apiPort),
  PORT_STRICT: "1",
  LINKS_API_PORT: String(apiPort),
  VITE_PORT: String(vitePort),
};
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const children = [
  spawn(process.execPath, ["--watch", "server/index.js"], { env, stdio: "inherit", windowsHide: true }),
  spawn(npx, ["vite"], { env, stdio: "inherit", shell: process.platform === "win32", windowsHide: true }),
];
const stop = () => { for (const child of children) child.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.once("exit", (code) => { stop(); process.exitCode = code || 0; });
console.log(`API en http://127.0.0.1:${apiPort} · UI en http://127.0.0.1:${vitePort}`);
