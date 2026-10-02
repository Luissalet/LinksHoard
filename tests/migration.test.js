// Upgrading a library made by an older version: saved links are re-keyed with the shared URL rules, watches start over.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempDir } from "./helpers.js";
import * as database from "../server/db.js";

test("migration 7 re-keys the saved links with the shared rules and leaves a key that is already taken alone", () => {
  const dir = tempDir();
  try {
    database.init(dir);
    const db = database.db();
    const insert = db.prepare("INSERT INTO links (id, url, url_original, site, saved_at) VALUES (?, ?, ?, ?, ?)");
    // what the previous version stored: a bare root with a slash, the LinkedIn job page as it was
    insert.run("a", "https://example.com/", "https://example.com/?utm_source=x", "example.com", "2026-01-01T00:00:00Z");
    insert.run("b", "https://www.linkedin.com/jobs/view/senior-dev-at-acme-3912345678", "https://www.linkedin.com/jobs/view/senior-dev-at-acme-3912345678/?trackingId=1", "linkedin.com", "2026-01-02T00:00:00Z");
    insert.run("c", "https://example.com/page", "https://example.com/page/", "example.com", "2026-01-03T00:00:00Z");
    insert.run("d", "https://example.com/older-key", "https://example.com/page/?utm_campaign=y", "example.com", "2026-01-04T00:00:00Z");
    db.prepare("INSERT INTO links (id, url, url_original, site, saved_at) VALUES ('e', 'https://other.org', 'https://other.org', 'other.org', '2026-01-05T00:00:00Z')").run();
    // go back to before migration 7
    db.exec("ALTER TABLE watches DROP COLUMN check_engine");
    db.prepare("DELETE FROM schema_version WHERE version = 7").run();
    database.close();

    database.init(dir);
    const rows = Object.fromEntries(database.db().prepare("SELECT id, url, site FROM links").all().map((r) => [r.id, r]));
    assert.equal(rows.a.url, "https://example.com");
    assert.equal(rows.b.url, "https://www.linkedin.com/jobs/view/3912345678");
    assert.equal(rows.b.site, "linkedin.com");
    assert.equal(rows.c.url, "https://example.com/page");
    // d would become https://example.com/page, which c already has: d keeps its key (nothing is merged or lost)
    assert.equal(rows.d.url, "https://example.com/older-key");
    assert.equal(rows.e.url, "https://other.org");
    assert.ok(database.db().prepare("SELECT check_engine FROM watches").all() !== null, "the engine column is back");
    assert.equal(database.db().prepare("SELECT MAX(version) AS v FROM schema_version").get().v, 7);
    database.close();
  } finally {
    try { database.close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
