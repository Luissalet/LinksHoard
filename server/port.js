import net from "node:net";

export function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function canListen(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export async function findAvailablePort(preferred, options = {}) {
  const host = options.host || "127.0.0.1";
  const attempts = options.attempts || 100;
  const first = validPort(preferred, 5180);
  for (let offset = 0; offset < attempts && first + offset <= 65535; offset++) {
    const port = first + offset;
    if (await canListen(port, host)) return port;
  }
  throw new Error(`No hay ningún puerto libre entre ${first} y ${Math.min(65535, first + attempts - 1)}.`);
}
