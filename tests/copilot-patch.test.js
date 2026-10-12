import test from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers.js";
import * as links from "../server/links.js";

test("manual notes and tag deltas preserve native agent changes", async () => {
  process.env.LINKS_WATCHES = "0";
  const s = await bootServer();
  try {
    const saved = links.createLink({ url: "https://example.com/copilot394", tags: ["initial"] }).link;
    links.updateLink(saved.id, { title: "Changed by the agent", tags: ["initial", "agent"], favorite: true });
    const note = await s.call("PATCH", `/api/links/${saved.id}`, { notes: "Manual draft" });
    assert.equal(note.status, 200);
    assert.equal(note.body.title, "Changed by the agent");
    assert.equal(note.body.favorite, true);
    const native = await s.agent("edit_link", { id: saved.id, title: "Native edited title", tags_add: ["native"] });
    assert.equal(native.status, 200);
    assert.equal(native.body.notes, "Manual draft");
    assert.deepEqual(native.body.tags, ["initial", "agent", "native"]);
    const add = await s.call("PATCH", `/api/links/${saved.id}`, { tags_add: ["manual"] });
    assert.deepEqual(add.body.tags, ["initial", "agent", "native", "manual"]);
    const remove = await s.call("PATCH", `/api/links/${saved.id}`, { tags_remove: ["initial"] });
    assert.deepEqual(remove.body.tags, ["agent", "native", "manual"]);
    assert.equal(remove.body.notes, "Manual draft");
    const legacy = await s.call("PATCH", `/api/links/${saved.id}`, { tags: ["replacement"] });
    assert.deepEqual(legacy.body.tags, ["replacement"]);
  } finally { await s.stop(); }
});
