// Background passes: the daily "Para leer hoy" digest line. LINKS_RESURFACE=0 turns it off.
import { isOpen } from "./db.js";
import { resurfaceDigest } from "./resurface.js";

const EVERY_MS = 15 * 60_000;
const FIRST_MS = 20_000;
let timers = [];

export const resurfaceAutoEnabled = (env = process.env) => !["0", "false", "no", "off"].includes(String(env.LINKS_RESURFACE ?? "1").trim().toLowerCase());

async function tick() {
  if (!isOpen()) return;
  try { await resurfaceDigest(); } catch (error) { console.error(`Para leer hoy: ${error.message}`); }
}

export function startBackground() {
  stopBackground();
  if (!resurfaceAutoEnabled()) return false;
  const first = setTimeout(tick, FIRST_MS);
  const loop = setInterval(tick, EVERY_MS);
  first.unref?.(); loop.unref?.();
  timers = [first, loop];
  return true;
}

export function stopBackground() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
}
