// Entry point: pick a port, open the database and serve API + UI on 127.0.0.1.
import { createApp, resolveDataDir } from "./app.js";
import { findAvailablePort, validPort } from "./port.js";

const PREFERRED_PORT = validPort(process.env.LINKS_PORT || process.env.PORT, 5181);
const PORT = process.env.PORT_STRICT === "1" ? PREFERRED_PORT : await findAvailablePort(PREFERRED_PORT);
const dataDir = resolveDataDir();
const { app } = createApp({ dataDir, dataDirConfigured: !!process.env.LINKS_DATA_DIR });

const server = app.listen(PORT, "127.0.0.1", () => {
  if (PORT !== PREFERRED_PORT) console.log(`Puerto ${PREFERRED_PORT} ocupado; usando ${PORT}.`);
  console.log(`Links Hoard en http://127.0.0.1:${PORT} · datos en ${dataDir}`);
});
server.on("error", (error) => {
  console.error(`No se pudo iniciar Links Hoard: ${error.message}`);
  process.exitCode = 1;
});
