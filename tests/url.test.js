import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, siteOf, isValidUrl } from "../server/url.js";

test("normalizeUrl strips tracking params, fragment and trailing slash, lowercases host", () => {
  assert.equal(
    normalizeUrl("https://Example.COM/foo/?utm_source=x&utm_medium=y&b=2&a=1&fbclid=zzz#section/"),
    "https://example.com/foo?a=1&b=2",
  );
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
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
