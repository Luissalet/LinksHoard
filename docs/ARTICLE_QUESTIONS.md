# Questions with paragraph citations

Open a saved article and use **Preguntar al artículo**. The Hub's configured
language model receives the question and the saved extraction. Each returned
answer sentence has one or more links to its source paragraphs. Clicking a
link scrolls to, focuses and highlights that paragraph; the link also works
after reloading the page. The article text, whitespace and existing highlight
controls remain intact.

The application checks that every paragraph ID exists in the supplied context
and that every quote occurs verbatim inside it. Sentences with invalid citations
are omitted, with a visible notice. This checks textual provenance, **not whether
the model's interpretation follows logically from the quote**. Read the paragraph
to assess the answer. The title and URL alone are never used as evidence.

## API and MCP

- `GET /api/links/:id` includes `article_source`: the SHA-256 content version
  and paragraphs with `id`, `index`, `text`, `start`, `end`, and `reader_url`.
- `POST /api/links/:id/ask` accepts `{"question":"¿Qué horario tiene?"}`.
- MCP `ask_link` accepts a saved `id` or `url` and `question`.
- MCP `read_link_paragraphs` accepts `id` or `url`, `offset` (paragraph index,
  starting at zero) and `limit` (1–100, default 30). It returns whole paragraphs,
  the source version and whether more paragraphs remain.

Successful question results return `sentences`, each containing `text` and
`citations`. A citation has an exact `quote`, `paragraph_id`, one-based
`paragraph_index`, `start`, `end` and a relative `reader_url`. Offsets are
JavaScript UTF-16 indices into the unmodified `content_text`. Each nonblank line
in the saved extraction is a paragraph, following the existing extractor's
block-per-line convention. Repeated identical paragraphs receive distinct IDs.
Any content change invalidates the earlier IDs, including whitespace changes.
Title, notes or read-state changes do not change the content version.

The answer status is `answered`, `partial_answer` (some invalid citations were
omitted), `unsupported`, `invalid_answer`, `text_unavailable`, `source_changed`,
or the Hub error such as `no_model`, `hub_down` or `timeout`. Unavailable answers
have `ok:false` and no answer sentences. Unknown links return HTTP 404; invalid
questions return HTTP 400. Business outcomes use HTTP 200, including through
the existing authenticated agent-call route and stdio MCP bridge.

## Limits and data

The input question is 1–2000 characters. At most 60,000 characters of saved
paragraph text are sent, in reading order; a paragraph can be cut at this limit.
`coverage` states whether this is partial, how much text and how many paragraphs
were supplied. Quotes are checked against **only the supplied portion**, so the
omitted tail cannot receive an apparently checked citation. No model context
size or universal answer quality is promised. Up to 20 answer sentences and
eight citations per sentence are accepted. The Hub request has a 90-second
timeout plus five seconds of transport grace; MCP allows 105 seconds.

A refetch or deletion during an answer returns `source_changed` without old
citations. A reader whose version differs from the answer asks for a reload.
Navigating to another article discards that view's pending result. Questions
and answers are transient in the current reader, not stored as notes or saved
highlights; they disappear on reload. The query neither retrieves a new page,
starts a media download nor edits the library. It uses `family.chat` and the
Hub's current model configuration without modifying the vendored client. The
MCP tool is read-only and non-idempotent, since model outputs can differ.

## En español

Pregunta en el lector y pulsa **Párrafo** junto a la respuesta para ver la cita
en su contexto. La comprobación asegura que el texto citado está en el pasaje
consultado; la interpretación del modelo sigue siendo algo que puedes contrastar.
Si solo se ha consultado parte del artículo, se indica. Si el texto cambia, el
modelo no está disponible o las citas no son válidas, se informa sin inventar
un origen. Las preguntas y respuestas no se guardan al recargar.
