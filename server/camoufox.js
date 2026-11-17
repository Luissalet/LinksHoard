// Camoufox: a second reader for posts that the Chromium profile of Links cannot get past (a login wall, a block of automated browsers).
//
// Camoufox is a Firefox build that does not look automated and keeps a persistent profile. It is optional: it is a Python package
// (`python -m pip install camoufox` and `python -m camoufox fetch`, which downloads the browser). When it is there, read_post tries it
// after the Chromium reader and gallery-dl have not got the post; the profile it uses is <data>/sessions/camoufox/<site>, and it is
// given the cookies of the session the person signed in with ("Iniciar sesión con…") so a site that wants an account sees one.
// When it is not installed nothing changes and the status says how to install it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, runCapture } from "./hoard-commons/media.js";
import { cookiesFileFor, camoufoxProfile, siteForUrl } from "./site-login.js";

export const INSTALL_COMMAND = "python -m pip install -U camoufox && python -m camoufox fetch";
const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "camoufox_read.py");
const PROBE = "import importlib.metadata as m; from camoufox.pkgman import camoufox_path; camoufox_path(); print(m.version('camoufox'))";
const PROBE_PACKAGE = "import importlib.metadata as m; print(m.version('camoufox'))";
const CACHE_MS = 60_000;
let cached = null;

const asCommand = (cmd) => (typeof cmd === "string" ? (/^node:/.test(cmd) ? { cmd: process.execPath, args: [cmd.slice(5)] } : { cmd, args: [] }) : cmd);

/** The Pythons to try: LINKS_CAMOUFOX_PYTHON, the app's PYTHON, then the ones on the PATH. */
export function pythonCandidates(env = process.env) {
  return [env.LINKS_CAMOUFOX_PYTHON, env.PYTHON, "python", "python3", "py"].filter((c, i, a) => c && a.indexOf(c) === i);
}

/** { found, browser, python, version, install, error }: found = the package is importable, browser = its browser was downloaded. */
export async function camoufoxStatus({ run = runCapture, candidates = pythonCandidates(), fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS && cached.key === candidates.join("|")) return cached.value;
  let value = { found: false, browser: false, python: "", version: "", install: INSTALL_COMMAND, error: "Camoufox no está instalado." };
  for (const candidate of candidates) {
    const command = asCommand(candidate);
    const r = await run(command, ["-c", PROBE], { timeoutMs: 25_000, lowPriority: false });
    if (r.code === 0 && r.stdout.trim()) { value = { found: true, browser: true, python: candidate, version: r.stdout.trim().split(/\r?\n/).pop(), install: INSTALL_COMMAND, error: "" }; break; }
    // the package without its browser: say so, and keep looking for a Python that has both
    const pkg = await run(command, ["-c", PROBE_PACKAGE], { timeoutMs: 25_000, lowPriority: false });
    if (pkg.code === 0 && pkg.stdout.trim() && !value.found) {
      value = { found: true, browser: false, python: candidate, version: pkg.stdout.trim().split(/\r?\n/).pop(), install: "python -m camoufox fetch", error: "Camoufox está instalado pero falta descargar su navegador." };
    }
  }
  cached = { at: Date.now(), key: candidates.join("|"), value };
  return value;
}

export function forgetCamoufox() { cached = null; }

/**
 * Open `url` with Camoufox and return what `script` (a JavaScript expression run in the page; see post-reader.extractScript) found,
 * or null when Camoufox is not there or the page never gave anything. The profile is the site's own under <data>/sessions/camoufox.
 */
export async function readWithCamoufox(url, { script, waitMs = 25_000, run = runProcess, status = camoufoxStatus, signal } = {}) {
  const st = await status();
  if (!st.found || !st.browser) return null;
  const site = siteForUrl(url);
  let host = "page";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* the caller checked the url */ }
  const profile = camoufoxProfile(site?.id || host);
  fs.mkdirSync(profile, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "links-camoufox-"));
  const requestFile = path.join(work, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ url, profile, cookies: cookiesFileFor(url) || "", script, wait_ms: waitMs, navigate_ms: 15_000 }), "utf8");
  const lines = [];
  try {
    await run(asCommand(st.python), [READER, requestFile], { signal, timeoutMs: waitMs + 90_000, lowPriority: false, onStdoutLine: (line) => { if (line.trim()) lines.push(line.trim()); } });
  } catch { return null; } finally { fs.rmSync(work, { recursive: true, force: true }); }
  // the answer is the last line that is a JSON object (the browser may print other things before it)
  const last = [...lines].reverse().find((l) => l.startsWith("{"));
  let answer = null;
  try { answer = last ? JSON.parse(last) : null; } catch { return null; }
  if (!answer?.ok || !answer.value || typeof answer.value !== "object") return null;
  return { ...answer.value, via: "camoufox" };
}
