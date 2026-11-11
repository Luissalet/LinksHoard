import test from "node:test";
import assert from "node:assert/strict";
import { installAppDock } from "../client/src/app-dock.js";

test("queued Links tools resolve unique records, filter routes and refresh without remounting", async () => {
  const rows = [{ id: "a /1", title: "Árbol" }, { id: "b", title: "Arbol" }];
  let refreshed = 0, events = 0;
  const target = { location: { hash: "#/todo" }, document: { querySelector: () => null }, dispatchEvent: () => events++ };
  const dispose = installAppDock({ api: { links: { get: async (id) => rows.find((r) => r.id === id), list: async () => ({ items: rows }) } },
    refresh: async () => refreshed++, pages: ["todo", "videos"] }, target);
  const queued = target.HoardApp.q;
  const tools = new Map(queued.filter(([method]) => method === "registerTool").map(([, name, definition, handler]) => [name, { definition, handler }]));
  assert.equal(tools.size, 3);
  const cursor = { to: async () => {} };
  const open = tools.get("links_open").handler;
  await assert.rejects(open({ title: "árbol" }, { cursor }), (e) => e.code === "ambiguous" && e.candidates.length === 2);
  await assert.rejects(open({ title: "missing" }, { cursor }), (e) => e.code === "not_found");
  await assert.rejects(open({}, { cursor }), (e) => e.code === "bad_args");
  await open({ id: "a /1" }, { cursor });
  assert.equal(target.location.hash, "#/link/a%20%2F1");
  const context = queued.find(([method]) => method === "setContext")[1];
  assert.equal(context().focus.id, "a /1");
  await tools.get("links_filter").handler({ q: "a & b", tag: "3D", view: "favoritos" }, { cursor });
  assert.equal(target.location.hash, "#/favoritos?q=a+%26+b&tag=3D");
  const changed = queued.find(([method]) => method === "onChanged")[1];
  await changed(); assert.equal(refreshed, 1); assert.equal(events, 1);
  dispose(); await changed(); assert.equal(refreshed, 1);
  assert.equal(tools.get("links_view").definition.inputSchema.additionalProperties, false);
});
