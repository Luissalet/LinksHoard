# Reading plans by available time

Ask Faustus: “I have 20 minutes; pick saved articles tagged research that fit.”
The MCP `reading_plan` tool reads the current library:

```json
{"minutes":20,"words_per_minute":200,"max_items":5,"tag":"research"}
```

`minutes` accepts 1–240 whole minutes; `words_per_minute` accepts 50–1000 (default
200, the reader's existing estimate); `max_items` accepts 1–20 (default 5).
`tag` is an exact, case-sensitive saved label; `site` is an exact domain with
case ignored. Neither filter is a keyword search.

Only unread, unarchived article/PDF/other entries with successfully extracted,
nonblank text and a positive known word count are eligible. Audio, video and
image entries are excluded: word counts do not estimate playback time. Unknown
counts and unavailable text stay visible in `excluded`, rather than becoming
zero-minute articles. A text longer than the whole budget is excluded.

Each complete text uses `ceil(word_count / words_per_minute)` estimated minutes.
The selection fills as much of the budget as possible while respecting the item
limit. Equal-duration plans prefer more favourites, then fewer texts, then older
saved entries (stable ID breaks a final tie). This is a bounded-cardinality
knapsack calculation, so combinations can beat choosing the longest text first.
Candidates are checked before the item limit; they are not limited to one page
of `list_links`.

The result gives `items`, `estimated_minutes`, `unused_minutes`, `total_words`,
`eligible_candidates`, `not_selected`, exclusions and the applied filters.
These are estimates, not a guarantee of reading speed or comprehension; diagrams,
code and difficult prose can take longer. The planner does not split articles,
infer a personal speed, retrieve pages, mark anything read, reserve links or
change the daily resurfacing list. Repeating a call against unchanged data is
stable; a user correction or newly read article is reflected in the next call.
Read a selected article through `read_link` before quoting or summarizing it.

## References and scope

- [Omnivore](https://github.com/omnivore-app/omnivore) documents saving the reader's
  position as part of a read-later workflow.
- [Savr](https://github.com/jonocodes/savr) describes reading-time estimates based
  on reading speed. Links Hoard takes an explicit speed; it does not learn it.
- GitHub Trending was inspected, but its retrieved page did not expose a current
  repository list. No daily trend or popularity claim is made.

The budget selection is an original extension using Links Hoard's existing
saved word counts. No upstream code was copied, dependency added or data schema
changed.

## En español

`reading_plan` prepara lecturas completas que quepan en los minutos que tienes.
Usa palabras guardadas y un ritmo explícito (200 palabras por minuto por defecto),
redondeando cada artículo hacia arriba. Busca la combinación que más aprovecha
el tiempo; en empate prioriza favoritos, menos artículos y los más antiguos.

Devuelve tiempos estimados, minutos libres y exclusiones por textos no
disponibles, longitud desconocida, tipo no compatible o exceso de duración.
Puedes filtrar por etiqueta exacta o sitio. No consume la selección diaria ni
marca enlaces como leídos, no descarga nada y no promete tu tiempo real de
lectura. Una corrección del ritmo, presupuesto o estado se refleja al consultar
de nuevo. Usa `read_link` para leer el contenido antes de resumirlo.
