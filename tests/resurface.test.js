// resurface: "Para leer hoy" picks, the same list all day, the cooldown, and the daily digest line.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers.js";
import { startFakeHub, until } from "./fake-hub.js";
import * as family from "../server/hoard-link.js";
import * as links from "../server/links.js";
import * as highlights from "../server/highlights.js";
import { db, getSetting, setSetting } from "../server/db.js";
import { resurface, candidates, resurfaceDigest, localDay, resurfaceSettings } from "../server/resurface.js";
import { setPublicUrl } from "../server/public-url.js";
import { startBackground, stopBackground, resurfaceAutoEnabled } from "../server/background.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 2, 9, 30); // 2 Oct 2026, 09:30 local
const ago = (d, at = NOW) => new Date(at.getTime() - d * DAY).toISOString();

let s, hub, n = 0;
/** A saved, fetched link; `saved` days ago, optionally read `read` days ago. */
function make({ saved = 10, read = null, favorite = false, tags = [], source = "manual", archived = false, hl = 0, status = "ok", title } = {}) {
  n += 1;
  const link = links.createLink({ url: `https://example.com/p${n}`, tags, source }).link;
  db().prepare("UPDATE links SET saved_at = ?, read_at = ?, favorite = ?, archived = ?, fetch_status = ?, title = ? WHERE id = ?")
    .run(ago(saved), read === null ? null : ago(read), favorite ? 1 : 0, archived ? 1 : 0, status, title || `Artículo ${n}`, link.id);
  for (let i = 0; i < hl; i++) highlights.addHighlight(link.id, { text: `frase ${i} del artículo ${n}` });
  return link.id;
}
const reset = () => {
  db().prepare("DELETE FROM highlights").run();
  db().prepare("DELETE FROM links").run();
  db().prepare("DELETE FROM settings WHERE key LIKE 'resurface%'").run();
};

before(async () => {
  hub = await startFakeHub();
  s = await bootServer();
  family.configure({ app: "links", dataDir: s.dataDir, hub: hub.url });
});
after(async () => {
  stopBackground();
  setPublicUrl("");
  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  await s.stop();
  await hub.stop();
});
beforeEach(() => { reset(); hub.state.events.length = 0; hub.state.emitStatus = 200; });

test("only unread links of at least two days, fetched, not archived and not download records are candidates", () => {
  const ok = make({ saved: 5 });
  make({ saved: 1 });                    // too recent
  make({ saved: 30, archived: true });
  make({ saved: 30, status: "failed" });
  make({ saved: 30, status: "pending" });
  make({ saved: 30, source: "download", tags: ["descarga"] });
  make({ saved: 30, read: 20 });         // read, no highlights: nothing to re-read
  const got = candidates(NOW).map((c) => c.link.id);
  assert.deepEqual(got, [ok]);
});

test("older first, with favourites, highlights and tags the user reads weighing more", () => {
  const old = make({ saved: 60 });
  const mid = make({ saved: 20 });
  const fav = make({ saved: 15, favorite: true });                 // 15 + 40
  const marked = make({ saved: 12, hl: 2 });                       // 12 + 20
  make({ saved: 40, read: 35, tags: ["ia"] });                     // a read link that makes "ia" a topic they read
  make({ saved: 40, read: 36, tags: ["ia"] });
  const topic = make({ saved: 18, tags: ["ia"] });                 // 18 + 8
  const order = candidates(NOW).map((c) => c.link.id);
  // scores: old 60, favourite 15+40, highlights 12+20, topic 18+8, mid 20
  assert.deepEqual(order, [old, fav, marked, topic, mid]);
  const reasons = Object.fromEntries(candidates(NOW).map((c) => [c.link.id, c.reason]));
  assert.match(reasons[old], /^Sin leer desde hace 60 días$/);
  assert.match(reasons[fav], /^Favorito sin leer desde hace 15 días$/);
  assert.match(reasons[marked], /2 subrayados/);
});

test("a link read two weeks ago with highlights comes back to be re-read, after the unread ones", () => {
  const unread = make({ saved: 30 });
  const reread = make({ saved: 90, read: 20, hl: 1 });
  make({ saved: 90, read: 5, hl: 3 });  // read too recently
  const c = candidates(NOW);
  assert.deepEqual(c.map((x) => x.link.id), [unread, reread]);
  assert.match(c[1].reason, /^Para releer: 1 subrayado, leído hace 20 días$/);
});

test("the same list all day; read ones drop out; a bigger count tops it up; tomorrow brings others", () => {
  const ids = [60, 50, 40, 30, 20].map((saved) => make({ saved }));
  const first = resurface(3, NOW);
  assert.equal(first.day, "2026-10-02");
  assert.deepEqual(first.items.map((i) => i.id), ids.slice(0, 3));
  assert.equal(first.picked_now, 3);
  assert.ok(first.items.every((i) => i.title && i.url && i.reason));

  const later = resurface(3, new Date(NOW.getTime() + 5 * 3600_000));
  assert.deepEqual(later.items.map((i) => i.id), ids.slice(0, 3));
  assert.equal(later.picked_now, 0);

  links.markRead(ids[0], true);
  const afterRead = resurface(3, NOW);
  assert.deepEqual(afterRead.items.map((i) => i.id), ids.slice(1, 3), "what was read is done for today, and the list is not refilled");

  const more = resurface(4, NOW);
  assert.deepEqual(more.items.map((i) => i.id), [ids[1], ids[2], ids[3]]);

  const tomorrow = new Date(NOW.getTime() + DAY);
  const next = resurface(3, tomorrow);
  assert.equal(next.day, "2026-10-03");
  assert.deepEqual(next.items.map((i) => i.id), [ids[4]], "ids[1..3] were shown yesterday: not again within 14 days; ids[0] is read");
});

test("never the same link twice in 14 days, then it can come back", () => {
  const only = make({ saved: 90 });
  assert.deepEqual(resurface(3, NOW).items.map((i) => i.id), [only]);
  for (const d of [1, 7, 13]) assert.deepEqual(resurface(3, new Date(NOW.getTime() + d * DAY)).items, [], `day +${d}`);
  assert.deepEqual(resurface(3, new Date(NOW.getTime() + 14 * DAY)).items.map((i) => i.id), [only]);
});

test("a re-read waits 30 days", () => {
  const id = make({ saved: 200, read: 100, hl: 2 });
  assert.equal(resurface(1, NOW).items[0].id, id);
  assert.deepEqual(resurface(1, new Date(NOW.getTime() + 29 * DAY)).items, []);
  assert.equal(resurface(1, new Date(NOW.getTime() + 30 * DAY)).items[0].id, id);
});

test("an archived or deleted pick leaves today's list", () => {
  const [a, b] = [make({ saved: 50 }), make({ saved: 40 })];
  assert.equal(resurface(2, NOW).items.length, 2);
  links.setArchived(a, true);
  assert.deepEqual(resurface(2, NOW).items.map((i) => i.id), [b]);
  links.deleteLink(b);
  assert.deepEqual(resurface(2, NOW).items, []);
});

test("the tool, the REST route and the setting agree", async () => {
  const ids = [50, 40, 30, 20].map((saved) => make({ saved, title: `Lectura ${saved}` }));
  const t = await s.agent("resurface", { count: 2 });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.items.length, 2);
  assert.deepEqual(t.body.items.map((i) => i.id), ids.slice(0, 2));
  assert.equal(t.body.items[0].title, "Lectura 50");
  const rest = await s.call("GET", "/api/resurface?count=2");
  assert.deepEqual(rest.body.items.map((i) => i.id), ids.slice(0, 2));
  const dflt = await s.agent("resurface", {});
  assert.equal(dflt.body.count, 3, "the default is the setting");
  assert.equal((await s.agent("resurface", { count: 0 })).status, 400);
  assert.equal((await s.agent("resurface", { count: 11 })).status, 400);

  assert.deepEqual((await s.call("GET", "/api/settings")).body, { resurface: { digest: true, count: 3 } });
  const saved = await s.call("POST", "/api/settings", { resurface: { digest: false, count: 5 } });
  assert.deepEqual(saved.body, { resurface: { digest: false, count: 5 } });
  assert.equal((await s.call("POST", "/api/settings", { resurface: { count: 50 } })).status, 400);
  assert.equal(resurfaceSettings().count, 5);
  const viaRoute = await s.call("GET", "/api/resurface");
  assert.equal(viaRoute.body.count, 5, "the route uses the saved count");
});

test("the daily digest: nothing before 08:00, one event from then on, once a day, and only when there is something to read", async () => {
  setPublicUrl("http://127.0.0.1:5181");
  const ids = [50, 40, 30].map((saved) => make({ saved, title: `Lectura ${saved}` }));
  const early = new Date(2026, 9, 2, 7, 59);
  assert.equal(await resurfaceDigest({ at: early }), 0);
  assert.equal(hub.ofType("digest.item").length, 0);

  assert.equal(await resurfaceDigest({ at: NOW }), 3);
  const [ev] = hub.ofType("digest.item");
  assert.equal(ev.source, "links");
  assert.equal(ev.data.watch, "links");
  assert.equal(ev.data.kind, "resurface");
  assert.equal(ev.data.url, "http://127.0.0.1:5181/#/bandeja");
  assert.equal(ev.data.title, "Para leer hoy (3): Lectura 50 · Lectura 40 · Lectura 30");
  assert.deepEqual(ev.data.items.map((i) => i.link_id), ids);
  assert.ok(ev.data.items.every((i) => i.url.startsWith("https://example.com/") && i.reason));

  assert.equal(await resurfaceDigest({ at: new Date(2026, 9, 2, 20, 0) }), 0, "once per day");
  assert.equal(hub.ofType("digest.item").length, 1);

  // tomorrow: nothing new to read (all three were shown) => no event, and the day is not retried all day
  const tomorrow = new Date(NOW.getTime() + DAY);
  assert.equal(await resurfaceDigest({ at: tomorrow }), 0);
  assert.equal(hub.ofType("digest.item").length, 1);
  assert.equal(getSetting("resurface_digest_day"), localDay(tomorrow));
});

test("a digest the hub did not take is tried again, and the setting turns it off", async () => {
  make({ saved: 30 });
  hub.state.emitStatus = 503;
  assert.equal(await resurfaceDigest({ at: NOW }), 0);
  assert.equal(getSetting("resurface_digest_day", ""), "", "not remembered as sent");
  hub.state.emitStatus = 200;
  assert.equal(await resurfaceDigest({ at: new Date(NOW.getTime() + 15 * 60_000) }), 1, "same links as the first try");
  assert.equal(hub.ofType("digest.item").length, 1);

  setSetting("resurface_digest_day", "");
  hub.state.events.length = 0;
  setSetting("resurface_digest", false);
  assert.equal(await resurfaceDigest({ at: new Date(NOW.getTime() + DAY) }), 0);
  assert.equal(hub.ofType("digest.item").length, 0);
});

test("the hub being down costs nothing and sends nothing", async () => {
  make({ saved: 30 });
  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  assert.equal(await resurfaceDigest({ at: NOW }), 0);
  family.configure({ app: "links", dataDir: s.dataDir, hub: hub.url });
  assert.equal(await resurfaceDigest({ at: NOW }), 1);
});

test("the background pass is on unless LINKS_RESURFACE=0", () => {
  assert.equal(resurfaceAutoEnabled({}), true);
  assert.equal(resurfaceAutoEnabled({ LINKS_RESURFACE: "0" }), false);
  assert.equal(resurfaceAutoEnabled({ LINKS_RESURFACE: "off" }), false);
  process.env.LINKS_RESURFACE = "0";
  assert.equal(startBackground(), false);
  delete process.env.LINKS_RESURFACE;
  assert.equal(startBackground(), true);
  stopBackground();
});
