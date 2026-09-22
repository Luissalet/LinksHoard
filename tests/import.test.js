import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers.js";

let s;
before(async () => { s = await bootServer(); });
after(async () => { await s.stop(); });

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><A HREF="https://a.test/one" ADD_DATE="1">One</A>
  <DT><A HREF="https://a.test/two?utm_source=x" ADD_DATE="2">Two</A>
  <DT><A HREF="javascript:alert(1)">Bad</A>
</DL><p>
`;

const URL_LIST = `https://a.test/two
https://b.test/three
not a url
https://b.test/three
`;

test("import parses Netscape bookmarks HTML, skips invalid hrefs", async () => {
  const out = await s.call("POST", "/api/import", { format: "netscape", content: NETSCAPE, tags: ["import"] });
  assert.equal(out.status, 201);
  assert.equal(out.body.found, 2);
  assert.equal(out.body.added, 2);
  assert.equal(out.body.skipped, 0);
});

test("import parses a plain URL list, dedupes within the batch and against existing links", async () => {
  const out = await s.call("POST", "/api/import", { format: "urls", content: URL_LIST });
  assert.equal(out.status, 201);
  // "https://a.test/two" already exists (from the Netscape import above, tracking param stripped).
  // "https://b.test/three" appears twice in the list -> second is idempotent (existing: true) -> counted as skipped.
  assert.equal(out.body.found, 3);
  assert.equal(out.body.added, 1);
  assert.equal(out.body.skipped, 2);
});

test("imported links carry source=import and the given tags", async () => {
  const list = await s.call("GET", "/api/links?state=all&tag=import");
  assert.ok(list.body.total >= 2);
  assert.ok(list.body.items.every((l) => l.source === "import"));
});

test("import rejects an unknown format", async () => {
  const out = await s.call("POST", "/api/import", { format: "csv", content: "x" });
  assert.equal(out.status, 400);
});
