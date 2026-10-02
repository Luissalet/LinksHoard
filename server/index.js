// Entry point: pick a port, open the database and serve API + UI on 127.0.0.1. Listening, the clean shutdown (SIGINT / SIGTERM) and the
// forced exit after 15 s are runServer of hoard-commons/express.js.
import "./no-sqlite-warning.js"; // must load before anything that imports node:sqlite
import { createApp, resolveDataDir } from "./app.js";
import { runServer } from "./hoard-commons/express.js";
import { findAvailablePort, validPort, envFlag } from "./hoard-commons/server.js";
import { stop as stopFetcher } from "./fetcher.js";
import { stopScheduler } from "./watches.js";
import { shutdownMedia } from "./media.js";
import { close as closeDb } from "./db.js";
import { setPublicUrl } from "./public-url.js";
import { startBackground, stopBackground } from "./background.js";

const PREFERRED_PORT = validPort(process.env.LINKS_PORT || process.env.PORT, 5181);
const PORT = envFlag("PORT_STRICT", false) ? PREFERRED_PORT : await findAvailablePort(PREFERRED_PORT, { span: 100 });
const dataDir = resolveDataDir();

try {
  const { port } = await runServer({
    service: "Links Hoard",
    createApp: () => createApp({ dataDir, dataDirConfigured: !!process.env.LINKS_DATA_DIR }),
    port: PORT,
    // Graceful shutdown: stop taking new background work, let in-flight fetches and downloads finish writing (or time out) while the
    // database is still open, then close it. Without this a fetch can still be running when the process exits and throw against a
    // closed connection.
    onShutdown: async () => {
      stopScheduler();
      stopBackground();
      await shutdownMedia();
      await stopFetcher();
    },
    exit: (code) => { closeDb(); process.exit(code); },
  });
  if (port !== PREFERRED_PORT) console.log(`Puerto ${PREFERRED_PORT} ocupado; usando ${port}.`);
  console.log(`Links Hoard en http://127.0.0.1:${port} · datos en ${dataDir}`);
  setPublicUrl(`http://127.0.0.1:${port}`);
  // The daily "Para leer hoy" line for the family digest (LINKS_RESURFACE=0 turns it off).
  if (startBackground()) console.log("Para leer hoy: un aviso al día, a partir de las 08:00.");
} catch (error) {
  console.error(`No se pudo iniciar Links Hoard: ${error.message}`);
  process.exitCode = 1;
}
