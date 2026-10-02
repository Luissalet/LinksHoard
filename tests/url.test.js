import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, siteOf, isValidUrl } from "../server/url.js";

test("normalizeUrl strips tracking params, fragment and trailing slash, lowercases host", () => {
  assert.equal(
    normalizeUrl("https://Example.COM/foo/?utm_source=x&utm_medium=y&b=2&a=1&fbclid=zzz#section/"),
    "https://example.com/foo?a=1&b=2",
  );
  // the shared rule: the bare root has no slash, whatever was typed
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeUrl("HTTP://EXAMPLE.COM/PATH/"), "http://example.com/PATH");
});

test("normalizeUrl rejects non-http(s) and garbage", () => {
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("ftp://example.com/file"), null);
  assert.equal(normalizeUrl(""), null);
});

test("normalizeUrl is stable: normalizing twice gives the same result", () => {
  const once = normalizeUrl("https://example.com/a?gclid=1&x=2");
  assert.equal(normalizeUrl(once), once);
});

test("siteOf strips www.", () => {
  assert.equal(siteOf("https://www.example.com/a"), "example.com");
  assert.equal(siteOf("https://sub.example.com/a"), "sub.example.com");
});

test("isValidUrl", () => {
  assert.equal(isValidUrl("https://example.com"), true);
  assert.equal(isValidUrl("nope"), false);
});

test("the shared rules: more tracking parameters, default ports, the LinkedIn job id, ref kept except on a few sites", () => {
  assert.equal(normalizeUrl("https://example.com:443/a?mc_cid=1&_hsenc=2&trk=3&keep=1"), "https://example.com/a?keep=1");
  assert.equal(normalizeUrl("https://www.linkedin.com/jobs/view/senior-dev-at-acme-3912345678/?refId=x&trackingId=y"), "https://www.linkedin.com/jobs/view/3912345678");
  assert.equal(normalizeUrl("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3912345678"), "https://www.linkedin.com/jobs/view/3912345678");
  assert.equal(normalizeUrl("https://example.com/p?ref=main"), "https://example.com/p?ref=main");
  assert.equal(normalizeUrl("https://www.producthunt.com/posts/x?ref=newsletter"), "https://www.producthunt.com/posts/x");
  // a scheme-less host is accepted and gets https
  assert.equal(normalizeUrl("Example.com/Page/"), "https://example.com/Page");
});
