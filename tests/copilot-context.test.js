import test from "node:test";
import assert from "node:assert/strict";
import { linksContext, changedFields, refreshDraft } from "../client/src/hoard-copilot.js";

test("reader resolves the native link and only a current paragraph", async () => {
  const link = { id: "native42", title: "Current title", article_source: { version: "v2", paragraphs: [{ id: "p2" }] } };
  const out = await linksContext({ route: "link/native42?paragraph=p2&version=v2", getLink: async id => { assert.equal(id, link.id); return link; },
    editor: { notes: "Unsent note", notes_dirty: true }, selection: "Selected saved text" });
  assert.equal(out.project.external_project_id, link.id);
  assert.deepEqual(out.active_objects, [{ kind: "link", object_id: link.id }, { kind: "paragraph", object_id: "p2" }]);
  assert.equal(out.view.editor.notes, "Unsent note");
  assert.equal(out.selection.text, "Selected saved text");
  const stale = await linksContext({ route: "link/native42?paragraph=p2&version=v1", getLink: async () => link });
  assert.equal(stale.active_objects.length, 1);
});

test("new and app views never look up an invented object", async () => {
  for (const route of ["link/new", "vigia", "descargas", "bandeja"]) {
    const out = await linksContext({ route, getLink: async () => assert.fail("No native object to read"), forms: [{ label: "URL", value: "unsaved URL" }] });
    assert.equal(out.project, undefined);
    assert.deepEqual(out.active_objects, []);
    assert.equal(out.view.forms[0].value, "unsaved URL");
  }
});

test("deleted link has no object while upstream failures remain visible", async () => {
  const out = await linksContext({ route: "link/missing", getLink: async () => { throw Object.assign(new Error("Missing"), { status: 404 }); } });
  assert.equal(out.project, undefined);
  assert.deepEqual(out.active_objects, []);
  await assert.rejects(linksContext({ route: "link/42", getLink: async () => { throw Object.assign(new Error("Offline"), { status: 503 }); } }), /Offline/);
});

test("settings send only changed fields and refresh preserves edits typed while waiting", () => {
  const before = { dir: "", cookies_file: "", auto_update: true };
  const draft = { ...before, dir: "D:/QA/downloads" };
  const latest = { ...before, auto_update: false };
  assert.deepEqual(changedFields(before, draft), { dir: "D:/QA/downloads" });
  assert.deepEqual(refreshDraft(before, draft, latest), { ...latest, dir: draft.dir });
  assert.deepEqual(refreshDraft(null, draft, latest), latest);
});
