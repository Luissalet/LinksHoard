import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHtml, kindFromResponse, excerptOf, wordCount } from "../server/extract.js";
import { FIXTURE_ARTICLE, FIXTURE_WIKI } from "./helpers.js";

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

test("extractHtml on a Wikipedia-like page: infobox/navbox/references/toc stripped, tables stay readable", () => {
  const out = extractHtml(FIXTURE_WIKI, "https://es.wikipedia.org/wiki/Jorge_Luis_Borges");

  // Boilerplate that used to leak into the extracted text is gone.
  assert.doesNotMatch(out.contentText, /Información personal/);
  assert.doesNotMatch(out.contentText, /Nombre de nacimiento/);
  assert.doesNotMatch(out.contentText, /Retrato de Borges/);
  assert.doesNotMatch(out.contentText, /Enlaces relacionados de la barra lateral/);
  assert.doesNotMatch(out.contentText, /Contenido\s*\n?\s*1 Biografía/); // ToC
  assert.doesNotMatch(out.contentText, /\[editar\]/);
  assert.doesNotMatch(out.contentText, /\[1\]|\[2\]|\[3\]/); // reference markers
  assert.doesNotMatch(out.contentText, /Plantilla Jorge Luis Borges/); // navbox title
  assert.doesNotMatch(out.contentText, /El libro de arena/); // navbox-only link

  // The real in-article table (not the infobox) survives, with cells separated by spaces.
  assert.match(out.contentText, /Obra Año/);
  assert.match(out.contentText, /Ficciones 1944/);
  assert.match(out.contentText, /El Aleph 1949/);

  // No two words are glued together across cells or adjacent blocks anywhere in the text.
  const glued = [
    "hígadoSepultura", "argentinaReligión", "RelosCementerio", "1899Buenos",
    "1986Ginebra", "AñoFicciones", "1944ElAleph", "ObraAño",
  ];
  for (const bad of glued) assert.doesNotMatch(out.contentText, new RegExp(bad), `"${bad}" must not appear glued`);
  // General check: no lowercase-to-uppercase run-on across what were separate cells/rows.
  assert.doesNotMatch(out.contentText, /[a-záéíóúñ]{3,}[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,}/, "no glued word boundary");

  // The excerpt is the lead paragraph, not an infobox row.
  const excerpt = excerptOf(out.contentText);
  assert.match(excerpt, /^Jorge Luis Borges \(Buenos Aires, 24 de agosto de 1899-Ginebra/);
  assert.match(excerpt, /escritor, poeta, ensayista y traductor argentino/);
  assert.doesNotMatch(excerpt, /Información personal/);
  assert.doesNotMatch(excerpt, /Nombre de nacimiento/);
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
  // No line has sentence punctuation, so it falls back to the plain first 300 chars.
  assert.equal(excerptOf("a".repeat(400)), "a".repeat(300));
  // A qualifying "paragraph" (>= 80 chars, has sentence punctuation) that is itself
  // over max is truncated with an ellipsis.
  const longSentence = `This is a long single-line sentence with punctuation. ${"word ".repeat(80)}`;
  const excerpt = excerptOf(longSentence, 100);
  assert.ok(excerpt.endsWith("…"));
  assert.equal(excerpt.length, 101);
  assert.equal(wordCount("one two three"), 3);
  assert.equal(wordCount(""), 0);
});
