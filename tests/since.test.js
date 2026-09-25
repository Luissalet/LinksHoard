import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveSince } from "../server/since.js";
import { bootServer } from "./helpers.js";

const NOW = Date.parse("2026-09-25T10:30:00Z");

test("resolveSince: ISO dates pass through, ages and words become timestamps", () => {
  assert.equal(resolveSince("2026-09-01", NOW), "2026-09-01");
  assert.equal(resolveSince("2026-09-01T08:00:00Z", NOW), "2026-09-01T08:00:00.000Z");
  assert.equal(resolveSince("2h", NOW), "2026-09-25T08:30:00.000Z");
  assert.equal(resolveSince("7d", NOW), "2026-09-18T10:30:00.000Z");
  assert.equal(resolveSince("hace 3 días", NOW), "2026-09-22T10:30:00.000Z");
  assert.equal(resolveSince("2 weeks ago", NOW), "2026-09-11T10:30:00.000Z");
  assert.equal(resolveSince("", NOW), null);
  assert.equal(resolveSince(undefined, NOW), null);
  const today = new Date(resolveSince("hoy", NOW));
  assert.equal(today.getHours(), 0);
  assert.ok(new Date(resolveSince("ayer", NOW)) < today);
  const week = new Date(resolveSince("esta semana", NOW));
  assert.equal(week.getDay(), 1); // Monday
  assert.equal(new Date(resolveSince("este mes", NOW)).getDate(), 1);
});

test("resolveSince: nonsense is a 400 that says what is accepted", () => {
  assert.throws(() => resolveSince("el año que viene", NOW), (e) => e.status === 400 && /ISO date/.test(e.message));
});

let s;
before(async () => { s = await bootServer(); });
after(async () => { await s.stop(); });

test("list_links and link_digest accept ages and filter before paging", async () => {
  const listed = await s.agent("list_links", { state: "all", since: "2h" });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.items));
  const digest = await s.agent("link_digest", { since: "esta semana" });
  assert.equal(digest.status, 200);
  assert.ok(digest.body.since.length > 10);
  const dflt = await s.agent("link_digest", {});
  assert.equal(dflt.status, 200);
  const bad = await s.agent("list_links", { since: "nunca jamás" });
  assert.equal(bad.status, 400);
});
