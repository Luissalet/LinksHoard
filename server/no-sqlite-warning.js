// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature…"
// on every process start. It is expected and not actionable, so we filter
// only that one warning and forward everything else (deprecations, other
// experimental features, etc.) to Node's normal default handler.
// Must be imported first, before anything that loads node:sqlite (db.js).
const [defaultWarningListener] = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  if (defaultWarningListener) defaultWarningListener(warning);
  else console.warn(warning);
});
