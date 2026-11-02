import { test } from "node:test";
import assert from "node:assert/strict";
import { readPost, resolveShort, galleryPost, PostError } from "../server/post-reader.js";

process.env.LINKS_POST_WAIT_MS = "2000";

const fakeBrowser = (values) => {
  let i = 0;
  const calls = [];
  const c = {
    async send(method, params) {
      calls.push(method);
      if (method === "Target.createTarget") return { targetId: "t1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Runtime.evaluate") return { result: { value: values[Math.min(i++, values.length - 1)] } };
      return {};
    },
  };
  return { headless: (fn) => fn("ws://x"), cdp: (_ws, fn) => fn(c), gallery: async () => null, calls };
};

test("reads the post and resolves short links, dropping the site's own links", async () => {
  const b = fakeBrowser([null, { text: "Look: github.com/owner/repo", author: "Ann @ann", links: [
    { href: "https://t.co/abc", text: "github.com/owner/repo" }, { href: "https://x.com/ann", text: "Ann" }] }]);
  const out = await readPost({ url: "https://x.com/ann/status/1" }, { ...b, resolver: async (h) => h === "https://t.co/abc" ? "https://github.com/owner/repo" : h });
  assert.equal(out.site, "x");
  assert.equal(out.text, "Look: github.com/owner/repo");
  assert.deepEqual(out.links.map((l) => l.href), ["https://github.com/owner/repo"]);
  assert.ok(b.calls.includes("Target.closeTarget"));
});

test("a login wall names the site to sign in to", async () => {
  const b = fakeBrowser([{ wall: true }]);
  await assert.rejects(readPost({ url: "https://www.instagram.com/p/xyz/" }, b), (e) => e instanceof PostError && e.code === "LOGIN_NEEDED" && e.site === "instagram");
});

test("bad URLs are refused before opening anything", async () => {
  await assert.rejects(readPost({ url: "x.com/a" }, fakeBrowser([])), (e) => e.code === "BAD_URL");
});

test("short links follow redirects without leaving other hosts alone", async () => {
  const fetchImpl = async (u) => ({ headers: { get: () => (u === "https://t.co/a" ? "https://bit.ly/b" : u === "https://bit.ly/b" ? "https://example.com/x" : null) } });
  assert.equal(await resolveShort("https://t.co/a", { fetchImpl }), "https://example.com/x");
  assert.equal(await resolveShort("https://github.com/a/b", { fetchImpl }), "https://github.com/a/b");
});

test("a browser error page is never taken as the post", async () => {
  const b = fakeBrowser([{ error: "HTTP ERROR 403" }]);
  await assert.rejects(readPost({ url: "https://x.com/a/status/9" }, b), (e) => e instanceof PostError && e.code === "REFUSED" && /403/.test(e.message));
});

test("when the page refuses, the signed-in gallery-dl reading is used", async () => {
  const b = { ...fakeBrowser([{ error: "HTTP ERROR 403" }]), gallery: async () => ({ text: "Try github.com/a/b https://t.co/z", author: "ann", links: [{ href: "https://t.co/z" }], via: "gallery-dl" }) };
  const out = await readPost({ url: "https://x.com/ann/status/2" }, { ...b, resolver: async (h) => (h === "https://t.co/z" ? "https://example.org/post" : h) });
  assert.equal(out.via, "gallery-dl");
  assert.match(out.text, /github\.com\/a\/b/);
  assert.deepEqual(out.links.map((l) => l.href), ["https://example.org/post"]);
});

test("gallery-dl reading needs the session and the tool, and reads the post metadata", async () => {
  assert.equal(await galleryPost("https://x.com/a/status/1", { cookiesFor: () => "" }), null);
  const out = await galleryPost("https://x.com/a/status/1", {
    cookiesFor: () => "C:/cookies.txt", resolve: async () => ({ found: true, command: "gallery-dl" }),
    run: async (_cmd, args) => { assert.ok(args.includes("--cookies") && args.includes("text-tweets=true")); return { stdout: JSON.stringify([[2, { content: "Hello https://github.com/x/y", author: { name: "ann" } }]]) }; },
  });
  assert.equal(out.author, "ann");
  assert.deepEqual(out.links.map((l) => l.href), ["https://github.com/x/y"]);
});
