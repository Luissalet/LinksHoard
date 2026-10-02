// highlights_to_cards: highlights become Hypatia cards through the hub, once each; and links.highlight.added goes out on creation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers.js";
import { startFakeHub, until } from "./fake-hub.js";
import * as family from "../server/hoard-link.js";
import * as links from "../server/links.js";
import * as highlights from "../server/highlights.js";
import { db } from "../server/db.js";
import { highlightsToCards, cardOf, highlightRef } from "../server/cards.js";

let s, hub, a, b;
const added = [];
before(async () => {
  hub = await startFakeHub();
  s = await bootServer();
  family.configure({ app: "links", dataDir: s.dataDir, hub: hub.url });
  hub.state.tools["hypatia.cards_add"] = (args) => { added.push(args); return { deck: args.deck, count: args.cards.length, cards: args.cards.map((c, i) => ({ id: `q${added.length}-${i}`, existing: false })) }; };
  a = links.createLink({ url: "https://example.com/uno" }).link;
  b = links.createLink({ url: "https://blog.example.org/dos" }).link;
  links.applyFetchResult(a.id, { title: "El arte de leer", fetch_status: "ok", content_text: "Leer es conversar con los muertos. Lo que no se repasa se olvida." });
  links.applyFetchResult(b.id, { title: "Memoria y olvido", fetch_status: "ok" });
});
after(async () => {
  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  await s.stop();
  await hub.stop();
});

test("a highlight created over REST or by the agent is announced on the bus", async () => {
  const r = await s.call("POST", `/api/links/${a.id}/highlights`, { text: "Leer es conversar con los muertos", note: "cita para el ensayo" });
  assert.equal(r.status, 201);
  const ag = await s.agent("add_highlight", { id: a.id, text: "Lo que no se repasa se olvida" });
  assert.equal(ag.status, 200, JSON.stringify(ag.body));
  await until(() => hub.ofType("links.highlight.added").length === 2);
  const ev = hub.ofType("links.highlight.added");
  assert.deepEqual(ev[0].data, { highlight_id: r.body.id, link_id: a.id });
  assert.equal(ev[0].source, "links");
  assert.equal(ev[1].data.link_id, a.id);
});

test("the card: quote in front, note and article title behind, a reference back to the highlight", () => {
  const [h1] = highlights.listHighlights(a.id);
  const card = cardOf(h1, links.getLink(a.id));
  assert.equal(card.front, "Leer es conversar con los muertos");
  assert.equal(card.back, "cita para el ensayo\n\n— El arte de leer");
  assert.equal(card.source, "https://example.com/uno");
  assert.equal(card.source_ref, highlightRef(h1.id));
  assert.match(card.source_ref, /^hoard:\/\/links\/highlight\/[0-9a-f-]{36}$/);
  const [, h2] = highlights.listHighlights(a.id);
  assert.equal(cardOf(h2, links.getLink(a.id)).back, "— El arte de leer", "no note: only the title");
});

test("a pass sends what has not gone yet, in the deck Lecturas, and a second pass sends nothing", async () => {
  highlights.addHighlight(b.id, { text: "El olvido también es una forma de memoria", note: "" });
  const r = await highlightsToCards({});
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
  assert.equal(r.deck, "Lecturas");
  assert.equal(r.sent, 3);
  assert.equal(added.length, 1);
  assert.equal(added[0].deck, "Lecturas");
  assert.equal(added[0].cards.length, 3);
  assert.ok(added[0].cards.every((c) => c.front && c.back && c.source_ref.startsWith("hoard://links/highlight/")));
  const sent = db().prepare("SELECT COUNT(*) AS n FROM highlights WHERE card_sent_at IS NOT NULL AND card_deck = 'Lecturas'").get().n;
  assert.equal(sent, 3);

  const again = await highlightsToCards({});
  assert.equal(again.status, "nothing_new");
  assert.equal(again.sent, 0);
  assert.equal(again.skipped, 3);
  assert.equal(added.length, 1, "nothing was sent");

  highlights.addHighlight(a.id, { text: "Una cuarta frase subrayada" });
  const next = await highlightsToCards({});
  assert.equal(next.sent, 1);
  assert.equal(next.skipped, 3);
  assert.equal(added[1].cards.length, 1);
});

test("one link, one highlight, another deck, resend, and unknown targets", async () => {
  const onlyB = await highlightsToCards({ link_id: b.id, resend: true, deck: "Filosofía" });
  assert.equal(onlyB.sent, 1);
  assert.equal(onlyB.deck, "Filosofía");
  assert.equal(added.at(-1).deck, "Filosofía");
  assert.equal(added.at(-1).cards[0].source, "https://blog.example.org/dos");

  const byUrl = await highlightsToCards({ url: "https://example.com/uno", resend: true });
  assert.equal(byUrl.sent, 3);

  const [h] = highlights.listHighlights(b.id);
  const one = await s.call("POST", `/api/highlights/${h.id}/to-cards`, {});
  assert.equal(one.status, 200);
  assert.equal(one.body.sent, 1, "a single highlight asked for by hand goes even if it went before");
  assert.equal(added.at(-1).deck, "Lecturas");

  assert.equal((await highlightsToCards({ link_id: "nope" })).status, "unknown_link");
  assert.equal((await highlightsToCards({ url: "https://example.com/not-saved" })).status, "unknown_link");
  assert.equal((await s.call("POST", `/api/highlights/nope/to-cards`, {})).body.status, "unknown_highlight");
  assert.equal((await s.call("POST", `/api/links/nope/cards`, {})).status, 404);
});

test("since narrows by the date the highlight was saved", async () => {
  db().prepare("UPDATE highlights SET created_at = ? WHERE link_id = ?").run("2020-01-01T00:00:00.000Z", b.id);
  const recent = await highlightsToCards({ since: "2d", resend: true });
  assert.equal(recent.sent, 3, "only the highlights of link a are recent");
  const old = await highlightsToCards({ since: "2019-12-31", link_id: b.id, resend: true });
  assert.equal(old.sent, 1);
});

test("the agent tool and the REST routes report the same", async () => {
  const fresh = highlights.addHighlight(b.id, { text: "Otra más, para la herramienta" });
  const t = await s.agent("highlights_to_cards", {});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.ok, true);
  assert.equal(t.body.sent, 1);
  assert.equal(t.body.cards[0].highlight_id, fresh.id);
  const rest = await s.call("POST", `/api/links/${a.id}/cards`, { deck: "Otra", resend: true });
  assert.equal(rest.body.deck, "Otra");
  assert.equal(rest.body.sent, 3);
  const all = await s.call("POST", "/api/cards/from-highlights", {});
  assert.equal(all.body.status, "nothing_new");
  const list = await s.call("GET", `/api/links/${b.id}/highlights`);
  assert.ok(list.body.every((h) => h.card_sent_at), "the UI can tell which highlights went");
});

test("an older Hypatia that rejects source_ref still gets the cards, without the reference", async () => {
  const seen = [];
  hub.state.tools["hypatia.cards_add"] = (args) => {
    seen.push(args);
    if (args.cards.some((c) => "source_ref" in c)) return { __error: { status: 422, error: "cards.0.source_ref: Extra inputs are not permitted" } };
    return { count: args.cards.length };
  };
  const h = highlights.addHighlight(a.id, { text: "Para una Hypatia antigua" });
  const r = await highlightsToCards({ link_id: a.id });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(seen.length, 2);
  assert.ok(!("source_ref" in seen[1].cards[0]));
  assert.ok(db().prepare("SELECT card_sent_at FROM highlights WHERE id = ?").get(h.id).card_sent_at);
});

test("Hypatia failing, missing or the hub being down marks nothing as sent", async () => {
  const h = highlights.addHighlight(a.id, { text: "No debe marcarse como enviada" });
  const sentAt = () => db().prepare("SELECT card_sent_at AS at FROM highlights WHERE id = ?").get(h.id).at;

  hub.state.tools["hypatia.cards_add"] = () => ({ __error: { status: 500, error: "database is locked" } });
  const broken = await highlightsToCards({ link_id: a.id });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, "hypatia_error");
  assert.match(broken.error, /database is locked/);
  assert.equal(sentAt(), null);

  delete hub.state.tools["hypatia.cards_add"];
  const missing = await highlightsToCards({ link_id: a.id });
  assert.equal(missing.status, "hypatia_unavailable");
  assert.equal(sentAt(), null);

  family.configure({ app: "links", dataDir: s.dataDir, hub: "http://127.0.0.1:1" });
  const down = await highlightsToCards({ link_id: a.id });
  assert.equal(down.status, "hub_down");
  assert.equal(down.sent, 0);
  assert.equal(sentAt(), null);

  // and when everything is back, the same highlight goes
  family.configure({ app: "links", dataDir: s.dataDir, hub: hub.url });
  hub.state.tools["hypatia.cards_add"] = (args) => ({ count: args.cards.length });
  const back = await highlightsToCards({ link_id: a.id });
  assert.equal(back.sent, 1);
  assert.ok(sentAt());
});

test("more than 50 highlights go in several calls", async () => {
  const c = links.createLink({ url: "https://example.com/muchos" }).link;
  for (let i = 0; i < 120; i++) highlights.addHighlight(c.id, { text: `subrayado número ${i}` });
  const sizes = [];
  hub.state.tools["hypatia.cards_add"] = (args) => { sizes.push(args.cards.length); return { count: args.cards.length }; };
  const r = await highlightsToCards({ link_id: c.id });
  assert.equal(r.sent, 120);
  assert.deepEqual(sizes, [50, 50, 20]);
});
