import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHtml, kindFromResponse, excerptOf, wordCount } from "../server/extract.js";
import { FIXTURE_ARTICLE } from "./helpers.js";

test("extractHtml pulls the article title/byline/text via Readability, skipping nav/footer chrome", () => {
  const out = extractHtml(FIXTURE_ARTICLE, "https://fixture.test/article");
  assert.equal(out.title, "The Real Article Title");
  assert.match(out.contentText, /fixture body text/);
  assert.doesNotMatch(out.contentText, /Copyright fixture footer/);
  assert.equal(out.description, "A short fixture description.");
});

test("extractHtml falls back to title + meta description + stripped body for thin pages", () => {
  const html = `<html><head><title>Thin Page</title><meta name="description" content="Thin desc."></head><body><p>Too short.</p></body></html>`;
  const out = extractHtml(html, "https://fixture.test/thin");
  assert.equal(out.title, "Thin Page");
  assert.equal(out.description, "Thin desc.");
  assert.match(out.contentText, /Too short/);
});

test("kindFromResponse classifies by content-type and extension", () => {
  assert.equal(kindFromResponse("https://x.test/a.pdf", ""), "pdf");
  assert.equal(kindFromResponse("https://x.test/a", "application/pdf"), "pdf");
  assert.equal(kindFromResponse("https://x.test/a.jpg", "image/jpeg"), "image");
  assert.equal(kindFromResponse("https://youtube.com/watch?v=1", "text/html"), "video");
  assert.equal(kindFromResponse("https://x.test/a", "text/html; charset=utf-8"), "article");
  assert.equal(kindFromResponse("https://x.test/a", ""), "other");
});

test("excerptOf and wordCount", () => {
  assert.equal(excerptOf("short"), "short");
  assert.equal(excerptOf("a".repeat(400)).length, 301);
  assert.equal(wordCount("one two three"), 3);
  assert.equal(wordCount(""), 0);
});
