// Background passes: the daily "Para leer hoy" digest line, and the video insight sweep (retries, new videos). LINKS_RESURFACE=0 and
// LINKS_VIDEO=0 turn them off.
// The loop itself (no overlapping passes, a failing pass logged and the loop kept, timers that do not keep the process alive) is the
// shared startBackground of hoard-commons/server.js.
import { isOpen } from "./db.js";
import { resurfaceDigest } from "./resurface.js";
import { sweepVideo } from "./videoinsight.js";
import { startBackground as startLoop, envFlag } from "./hoard-commons/server.js";

const EVERY_MS = 15 * 60_000;
const FIRST_MS = 20_000;
const VIDEO_EVERY_MS = 60_000;
const VIDEO_FIRST_MS = 30_000;
let loop = null;
let videoLoop = null;

export const resurfaceAutoEnabled = (env = process.env) => envFlag("LINKS_RESURFACE", true, env);

async function tick() {
  if (!isOpen()) return;
  await resurfaceDigest();
}

async function videoTick() {
  if (!isOpen()) return;
  await sweepVideo();
}

export function startBackground() {
  stopBackground();
  loop = startLoop({ name: "Para leer hoy", intervalMs: EVERY_MS, firstDelayMs: FIRST_MS, tick, envFlag: "LINKS_RESURFACE" });
  videoLoop = startLoop({ name: "Vídeos", intervalMs: VIDEO_EVERY_MS, firstDelayMs: VIDEO_FIRST_MS, tick: videoTick, envFlag: "LINKS_VIDEO" });
  return loop.enabled;
}

export function stopBackground() {
  loop?.stop();
  loop = null;
  videoLoop?.stop();
  videoLoop = null;
}