# Plegar: a saved text at five levels

Spanish summary below.

Any saved text with extracted content (a web page, a PDF, a DOCX or EPUB, an arXiv paper) can be read at five levels of detail, from the whole text down to a map of its themes. Levels 1 and 2 are literal and computed from the saved extraction every time; levels 3 to 5 are written by the Hub's language model once per text version and language and kept with the link. Literal and generated material never mix: every generated item points at the paragraph it comes from.

| Level | Name | What it is | Made by |
| --- | --- | --- | --- |
| 1 | `full` | The whole text, paragraph by paragraph | the extraction |
| 2 | `sentences` | Per section, the sentences that carry most of the text's vocabulary (1-5 each), verbatim, with offsets | this app, no model |
| 3 | `key` | Per section, the key idea and why it matters, anchored to its supporting paragraph | the Hub model |
| 4 | `lines` | One line per section | the Hub model |
| 5 | `theme` | Two to eight themes, each a short title, a summary and the sections it covers | the Hub model |

## Sections

A text is cut by its headings when it has them: numbered headings (`2.1 Method`), a reference list (`References`, `Bibliografía`…) and short unpunctuated lines followed by a longer paragraph. Lines that are mostly symbols or numbers (formulas, table headers) are not headings. A text without at least two headings is cut every ~600 words at paragraph ends. A heading with almost nothing under it joins the next section, a section over 2,500 words is split into parts and there are at most 40 sections. The reference list is kept as a section of its own and never sent to the model.

## Documents

- **PDF** (bundled pdf.js through `unpdf`, no native modules): text items grouped into lines; a new paragraph on a vertical gap wider than 1.45 line spacings or a change of font size; a word split by a hyphen at a line end joined again; rotated text in the margins, bare page numbers and lines repeated on half the pages (running heads and feet) dropped.
- **DOCX**: the paragraphs of `word/document.xml`, title and author from `docProps/core.xml`.
- **EPUB**: the chapters in spine order through the same extraction as web pages, title, author and language from the OPF.
- **arXiv**: an `arxiv.org/abs/<id>` (or `/html/<id>`) link takes title and authors from the abstract page and the text from `arxiv.org/pdf/<id>`.

A document that cannot be read is still saved by its file name, with the reason in its description. Documents up to 40 MB are read.

## The fold document

`GET /api/links/:id/fold?lang=es` (`&download=1` to save it) returns the fold in an open JSON format:

```json
{
  "format": "links-fold", "format_version": 1,
  "link": { "id": "…", "url": "…", "title": "…", "site": "…", "kind": "pdf", "lang": "en" },
  "source_version": "<sha256 of the saved text>", "lang": "es",
  "levels": [{ "level": 1, "name": "full", "label": "Completo", "generated": false, "tokens": 9470 }, "…"],
  "generation": { "status": "done", "model": "…", "progress": { "done": 3, "total": 9 } },
  "paragraphs": [{ "id": "p-<version>-12", "index": 12, "text": "…", "start": 4031, "end": 4410 }],
  "sections": [{
    "id": "s3", "index": 3, "title": "2 Background", "title_generated": false, "heading_paragraph_id": "p-…-38",
    "paragraph_ids": ["p-…-38", "p-…-39"], "words": 258, "references": false,
    "sentences": [{ "text": "…", "paragraph_id": "p-…-39", "start": 4100, "end": 4290 }],
    "key": { "idea": "…", "why": "…", "paragraph_id": "p-…-39" },
    "line": "…",
    "notes": [{ "highlight_id": "…", "text": "…", "note": "…", "paragraph_id": "p-…-39" }]
  }],
  "themes": [{ "id": "t1", "title": "…", "summary": "…", "section_ids": ["s1", "s2"] }],
  "loose_notes": []
}
```

Offsets are JavaScript UTF-16 indices into the saved text, the same paragraph ids as the reader and `read_link_paragraphs`. `tokens` is an estimate (characters / 4) of what reading each level costs. `generation.status` is `none`, `running`, `done`, `partial`, `failed`, `interrupted` or `stale` (the text changed after the levels were written).

## Notes

A highlight (with or without a note) belongs to the paragraph that contains it, so it shows next to that passage at every level: under its section at levels 2 and 3, as a count at levels 4 and 5. **+ nota** on any item saves a highlight of that passage with the note.

## Generation

`POST /api/links/:id/fold {lang?, force?, wait_s?}` starts or resumes the generated levels and waits up to `wait_s` seconds (0-600). Sections go to the model in batches of about 8,000 characters (up to 5,000 per section), three batches at a time, with reasoning off; then one call builds the theme map from the section lines. What a batch writes is saved at once: a timeout or a missing model leaves the fold `partial`, and asking again sends only the sections still missing. `force` writes everything again. Folds of different links run one after another.

## Bilingual reading

`POST /api/links/:id/translate {lang, offset?, limit?, translate?}` returns paragraphs `offset..offset+limit` (at most 200) as pairs `{ paragraph_id, index, original, translation }`, translating first the ones not stored yet (batches of about 3,000 characters, three at a time). `translate: false` only reads what is stored. `GET /api/links/:id/translations` lists the languages stored for the current text. Languages: `es`, `en`, `fr`, `de`, `it`, `pt`, `ca`, `gl`, `eu`, `nl`, `ja`, `zh`. The reader translates in steps of 20 paragraphs and shows each translation under its paragraph as it arrives; a translation can be selected and copied but is never saved as a highlight.

## Browser extension

`extension/` is a Manifest V3 extension for Chromium browsers (Chrome, Brave, Edge). Load it from the extensions page with developer mode on (**Load unpacked**). The toolbar button (or Alt+Shift+L):

1. reads the current tab: the rendered HTML of a page, as it shows with your session, or the bytes of the PDF, DOCX or EPUB it has open, fetched with your cookies;
2. opens a Links tab and hands the content to `POST /api/capture` from there, so the app receives it as a same-origin request;
3. shows the saved link folded at level 2.

The link is saved (or updated) with that content and is not fetched again from the server, which would see the signed-out page. The extension's options set the address of Links (default `http://127.0.0.1:5181`).

`POST /api/capture {url, title?, html? | data_base64?, content_type?, tags?}` accepts up to 64 MB.

## Interfaces

- App: the **Plegar** bar of the reader (slider, buttons 1-5, keys 1-5, `+` more detail, `-` less detail, language of the generated levels) and the **Traducción** bar at level 1. `#/link/<id>?fold=3` opens a link at a level.
- MCP: `fold_link` (start/resume, status, sections, tokens per level), `fold_read` (`level` 1-5 or its name, `section`, `from_section` to page level 1, `lang`; markdown with `[¶n]` paragraph marks), `translate_link` (pairs, `missing`, `next_offset`).
- REST: `GET|POST /api/links/:id/fold`, `GET /api/links/:id/fold/read?level=&section=&from_section=&lang=`, `POST /api/links/:id/translate`, `GET /api/links/:id/translations`, `POST /api/capture`.

---

## En español

Plegar lee cualquier texto guardado (web, PDF, DOCX, EPUB, artículo de arXiv) en cinco niveles: completo, frases clave literales, idea clave y por qué de cada sección, una línea por sección y mapa de temas. Los dos primeros salen del texto sin modelo; los otros tres los escribe una vez el modelo de las Sparks a través del Hub y quedan guardados por versión del texto e idioma. Se cambia de nivel con el deslizador o las teclas 1-5, + y −; cada elemento abre su párrafo en el texto completo o en la página original, y las notas siguen con su pasaje en todos los niveles. El plegado se descarga como JSON abierto (`links-fold`). La traducción bilingüe muestra cada párrafo con su traducción debajo y la guarda por idioma. La extensión de `extension/` (Brave, Chrome, Edge) manda la pestaña tal como la ves, con tu sesión, y la abre plegada. Los agentes leen nivel a nivel con `fold_link`, `fold_read` y `translate_link`.
