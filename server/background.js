// Background passes: the daily "Para leer hoy" digest line. LINKS_RESURFACE=0 turns it off.
// The loop itself (no overlapping passes, a failing pass logged and the loop kept, timers that do not keep the process alive) is the
// shared startBackground of hoard-commons/server.js.
import { isOpen } from "./db.js";
import { resurfaceDigest } from "./resurface.js";
import { startBackground as startLoop, envFlag } from "./hoard-commons/server.js";

const EVERY_MS = 15 * 60_000;
const FIRST_MS = 20_000;
let loop = null;

export const resurfaceAutoEnabled = (env = process.env) => envFlag("LINKS_RESURFACE", true, env);

async function tick() {
  if (!isOpen()) return;
  await resurfaceDigest();
}

export function startBackground() {
  stopBackground();
  loop = startLoop({ name: "Para leer hoy", intervalMs: EVERY_MS, firstDelayMs: FIRST_MS, tick, envFlag: "LINKS_RESURFACE" });
  return loop.enabled;
}

export function stopBackground() {
  loop?.stop();
  loop = null;
}
