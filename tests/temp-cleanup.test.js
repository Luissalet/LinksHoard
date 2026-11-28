import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("temporary fixtures are removed after a failed test", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "links-failure-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const helper = new URL("./helpers.js", import.meta.url).href;
  const env = { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { test } from "node:test";
    import fs from "node:fs";
    import path from "node:path";
    import { tempDir } from ${JSON.stringify(helper)};
    test("fails after writing temporary fixture", (t) => {
      const dir = tempDir(t);
      fs.writeFileSync(path.join(dir, "fixture.txt"), "synthetic data");
      fs.writeFileSync("fixture-path.txt", dir);
      throw new Error("forced fixture failure");
    });
  `], { cwd: parent, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /forced fixture failure/);
  const dir = fs.readFileSync(path.join(parent, "fixture-path.txt"), "utf8");
  assert.equal(path.dirname(dir), parent);
  assert.equal(fs.existsSync(dir), false, "the failed test still owns a temporary directory");
});
