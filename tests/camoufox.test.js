// Camoufox, the optional second reader of posts: finding it, the request it is given and what it answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { camoufoxStatus, readWithCamoufox, pythonCandidates, forgetCamoufox, INSTALL_COMMAND } from "../server/camoufox.js";

const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "links-cf-"));
process.env.LINKS_SESSIONS_DIR = sessions;

test("the Pythons tried are the explicit one, the app's, then the ones on the PATH, without repeats", () => {
  assert.deepEqual(pythonCandidates({ LINKS_CAMOUFOX_PYTHON: "/a/py", PYTHON: "/a/py" }), ["/a/py", "python", "python3", "py"]);
  assert.deepEqual(pythonCandidates({ PYTHON: "/b/py" }), ["/b/py", "python", "python3", "py"]);
  assert.deepEqual(pythonCandidates({}), ["python", "python3", "py"]);
});

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
const bad = { code: 1, stdout: "", stderr: "ModuleNotFoundError" };

test("the status says whether Camoufox and its browser are there, and how to get them", async () => {
  forgetCamoufox();
  const none = await camoufoxStatus({ run: async () => bad, candidates: ["python"], fresh: true });
  assert.equal(none.found, false);
  assert.equal(none.install, INSTALL_COMMAND);
  assert.match(none.error, /no está instalado/);

  // the second probe (the package alone) answers when the browser was never downloaded
  let n = 0;
  const half = await camoufoxStatus({ run: async () => (++n % 2 ? bad : ok("0.5.9\n")), candidates: ["python"], fresh: true });
  assert.equal(half.found, true);
  assert.equal(half.browser, false);
  assert.equal(half.install, "python -m camoufox fetch");

  const full = await camoufoxStatus({ run: async () => ok("0.5.9\n"), candidates: ["python-a", "python-b"], fresh: true });
  assert.deepEqual([full.found, full.browser, full.python, full.version], [true, true, "python-a", "0.5.9"]);
  forgetCamoufox();
});

const READY = async () => ({ found: true, browser: true, python: "python", version: "0.5.9" });

test("a read gives Camoufox the page, the script and a profile of the site under the sessions folder, and returns what it found", async () => {
  const seen = [];
  const run = async (command, args, o) => {
    const request = JSON.parse(fs.readFileSync(args[1], "utf8"));
    seen.push({ command, args, request, timeoutMs: o.timeoutMs });
    o.onStdoutLine("Warning: something printed by the browser");
    o.onStdoutLine(JSON.stringify({ ok: true, value: { text: "Hola", author: "ann", links: [] }, final_url: request.url, cookies: 3 }));
    return { code: 0, stdout: "", stderr: "" };
  };
  const got = await readWithCamoufox("https://www.instagram.com/p/abc/", { script: "(() => 1)()", waitMs: 5000, run, status: READY });
  assert.deepEqual(got, { text: "Hola", author: "ann", links: [], via: "camoufox" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].request.url, "https://www.instagram.com/p/abc/");
  assert.equal(seen[0].request.script, "(() => 1)()");
  assert.equal(seen[0].request.wait_ms, 5000);
  assert.equal(seen[0].request.profile, path.join(sessions, "camoufox", "instagram"));
  assert.ok(fs.existsSync(seen[0].request.profile), "the profile folder is made");
  assert.match(seen[0].args[0], /camoufox_read\.py$/);
  assert.ok(seen[0].timeoutMs > 5000);
  assert.equal(fs.existsSync(seen[0].args[1]), false, "the request file does not stay behind");

  // a site Links has no login for gets a profile named after its host
  await readWithCamoufox("https://blog.example.org/post", { script: "1", run, status: READY });
  assert.equal(seen[1].request.profile, path.join(sessions, "camoufox", "blog-example-org"));
});

test("when Camoufox is missing, fails, or finds nothing, the answer is null and nothing throws", async () => {
  const never = async () => { throw new Error("must not run"); };
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: never, status: async () => ({ found: false, browser: false }) }), null);
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: never, status: async () => ({ found: true, browser: false }) }), null);
  const line = (o) => async (_c, _a, opts) => { opts.onStdoutLine(typeof o === "string" ? o : JSON.stringify(o)); return { code: 0, stdout: "", stderr: "" }; };
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: line({ ok: false, error: "boom" }), status: READY }), null);
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: line({ ok: true, value: null }), status: READY }), null);
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: line("not json"), status: READY }), null);
  assert.equal(await readWithCamoufox("https://x.com/a/status/1", { script: "1", run: async () => { throw new Error("spawn failed"); }, status: READY }), null);
});

const python = ["python", "python3"].find((p) => spawnSync(p, ["--version"], { windowsHide: true }).status === 0);
const hasPackage = python && spawnSync(python, ["-c", "import camoufox"], { windowsHide: true }).status === 0;

test("the Python reader answers with one JSON line even when Camoufox is not installed", { skip: !python || hasPackage ? "needs a Python without camoufox" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-cf-req-"));
  try {
    const req = path.join(dir, "request.json");
    fs.writeFileSync(req, JSON.stringify({ url: "https://example.com/", profile: path.join(dir, "p"), script: "1" }));
    const r = spawnSync(python, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "camoufox_read.py"), req], { windowsHide: true, encoding: "utf8" });
    assert.equal(r.status, 3);
    const answer = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    assert.equal(answer.ok, false);
    assert.equal(answer.missing, "camoufox");
    const bad = spawnSync(python, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "camoufox_read.py"), path.join(dir, "nope.json")], { windowsHide: true, encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout.trim()).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
