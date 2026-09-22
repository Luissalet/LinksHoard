import { spawn } from "node:child_process";
import { findAvailablePort, validPort } from "../server/port.js";

const port = await findAvailablePort(validPort(process.env.LINKS_PORT || process.env.PORT, 5181));
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], {
  env: { ...process.env, PORT: String(port), PORT_STRICT: "1" },
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    if (response.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(`Abriendo ${url}`);
if (process.platform === "win32") {
  spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code || 0)));
