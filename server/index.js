// Entry point: pick a port, open the database and serve API + UI on 127.0.0.1.
import "./no-sqlite-warning.js"; // must load before anything that imports node:sqlite
import { createApp, resolveDataDir } from "./app.js";
import { findAvailablePort, validPort } from "./port.js";
import { stop as stopFetcher } from "./fetcher.js";
import { stopScheduler } from "./watches.js";
import { shutdownMedia } from "./media.js";
import { close as closeDb } from "./db.js";
import { setPublicUrl } from "./public-url.js";
import { startBackground, stopBackground } from "./background.js";

const PREFERRED_PORT = validPort(process.env.LINKS_PORT || process.env.PORT, 5181);
const PORT = process.env.PORT_STRICT === "1" ? PREFERRED_PORT : await findAvailablePort(PREFERRED_PORT);
const dataDir = resolveDataDir();
const { app } = createApp({ dataDir, dataDirConfigured: !!process.env.LINKS_DATA_DIR });

const server = app.listen(PORT, "127.0.0.1", () => {
  if (PORT !== PREFERRED_PORT) console.log(`Puerto ${PREFERRED_PORT} ocupado; usando ${PORT}.`);
  console.log(`Links Hoard en http://127.0.0.1:${PORT} · datos en ${dataDir}`);
  setPublicUrl(`http://127.0.0.1:${PORT}`);
  // The daily "Para leer hoy" line for the family digest (LINKS_RESURFACE=0 turns it off).
  if (startBackground()) console.log("Para leer hoy: un aviso al día, a partir de las 08:00.");
});
server.on("error", (error) => {
  console.error(`No se pudo iniciar Links Hoard: ${error.message}`);
  process.exitCode = 1;
});

// Graceful shutdown: stop taking new background fetches, let in-flight ones
// finish writing (or time out) while the database is still open, then close
// the HTTP server and the database. Without this a fetch can still be
// running when the process exits and throw against a closed connection.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Cerrando Links Hoard (${signal})…`);
  const forceExit = setTimeout(() => process.exit(0), 15000);
  forceExit.unref();
  stopScheduler();
  stopBackground();
  await shutdownMedia();
  await stopFetcher();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
