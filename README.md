# Links Hoard

Local-first read-later bookmark library: save a URL, get the extracted article text, tag it, highlight passages and search everything — stored in a single SQLite file on your own computer and exposed to an assistant through MCP.

Spanish version: [`README.es.md`](README.es.md).

## Run

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`). No native modules, no Docker.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:5181
```

`npm run open` starts the server and opens the browser on Windows. `npm run dev` runs the API (`node --watch`) and Vite together with the `/api` proxy configured automatically.

The server binds to `127.0.0.1` only. If port 5181 is busy it walks up to the next free port and prints the address; set `PORT_STRICT=1` to fail instead.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `LINKS_PORT` / `PORT` | Preferred port (default `5181`). |
| `PORT_STRICT=1` | Do not fall back to another port. |
| `LINKS_DATA_DIR` | Data folder (default `<repo>/data`, gitignored). Contains `links-hoard.db` and `mcp-token`. |
| `LINKS_ALLOWED_HOSTS` | Extra host names accepted behind a tunnel (see below). |
| `LINKS_URL` | MCP bridge: base URL of the running app (default `http://127.0.0.1:5181`). Must be local. |
| `LINKS_TOKEN_FILE` / `LINKS_TOKEN` | MCP bridge: where to read the bearer token (default `<data dir>/mcp-token`). |

### Access from your phone (behind a tunnel)

The server binds 127.0.0.1 and only answers requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`. To reach it from your phone through a tunnel that fronts the app (a private mesh network, a reverse proxy), list the extra host names in `LINKS_ALLOWED_HOSTS`, comma-separated, exact names or `*.suffix`: `LINKS_ALLOWED_HOSTS=my-pc.example,*.ts.net`. Port and letter case are ignored, and the `Origin` of API calls must resolve to one of those hosts too (any scheme or port). Cross-site *fetches* are still refused; opening the app from another page (a link, a bookmarklet, the share sheet) is a normal navigation and works.

## What it does

- **Save instantly.** Paste a URL (or use the bookmarklet, the browser share sheet once installed as a PWA, or an assistant's `save_link` tool) and it is stored right away with `fetch_status: pending`. A background queue (2 at a time) downloads the page, extracts the article with Readability and fills in title, byline, excerpt and full text — the row updates itself, no reload needed.
- **Read cleanly.** The reader shows the extracted text at an adjustable font size, with the original URL, site, author and reading time. Select any text to highlight it, with an optional note.
- **Organize.** Tags, favorites, archive, read/unread. Sidebar shows tag counts; the list can filter by site too.
- **Search everything.** Full-text search (SQLite FTS5) over title, description, extracted text, notes and tags. If the runtime's SQLite build lacks FTS5 the app falls back to a plain `LIKE` search automatically and says so in Ajustes.
- **Import in bulk.** Netscape bookmarks HTML (what every browser exports) or a plain list of URLs, one per line. Both dedupe against what you already have.
- **Weekly digest.** `GET /api/digest?since=` (and the `link_digest` MCP tool) lists what was saved since a date, grouped by site, with excerpts.
- **Install as an app.** `manifest.webmanifest` declares a `share_target`, so once installed on Android you can share a page from any app straight into Links Hoard.

## URL normalization (the dedupe key)

Saving is idempotent on a normalized form of the URL: `utm_*`, `fbclid`, `gclid` and similar tracking params are stripped, the fragment is dropped, the host is lowercased and a trailing slash on the path is removed. Saving an already-saved page (even with different tracking params) returns the existing link with `existing: true` instead of duplicating it.

## Connect an assistant

In **Ajustes** (or via `faustus-plugin.json`) an assistant configured for local MCP servers over stdio can connect using `server/mcp.js`, `LINKS_URL` and `LINKS_TOKEN_FILE`. The bridge never opens the database itself: every call is proxied over HTTP to the running app, authenticated with a random token written fresh to `<data dir>/mcp-token` at every startup.

Tools:

| Tool | Use |
| --- | --- |
| `save_link` | Save a URL (idempotent); waits up to 10 s for the fetch so it can report the real title/excerpt. |
| `list_links` | List by state (unread/read/archived/all), tag, site, since. |
| `search_links` | Full-text search. |
| `read_link` | Read the extracted text, paginated by characters; includes highlights. |
| `tag_link` | Add/remove tags. |
| `mark_link` | Toggle read/unread/archived/favorite. |
| `add_highlight` | Save a highlighted quote with a note. |
| `link_digest` | What was saved since a date, grouped by site. |
| `refetch_link` | Re-download and re-extract. |
| `delete_link` | Permanently delete (destructive; confirm first). |
| `list_tags` | Every tag in use, with counts. |

11 tools in total. `GET /api/agent/tools` always reflects the live list. Tool descriptions end with a `Sinónimos:` line of Spanish words, so a Spanish-speaking user's phrasing ("guarda esto", "resumen de la semana") matches the right tool.

The assistant is instructed to summarize or quote a link only from the text `read_link` returns, never from the title alone, and to say plainly when a fetch is still pending or failed rather than guessing.

## Data and limits

- `data/links-hoard.db`: links, highlights and settings, SQLite with WAL.
- `data/mcp-token`: local credential created at startup; not published or included anywhere else.
- Fetch: 15 s timeout, a browser-like User-Agent header, 5 MB body cap. HTML goes through `linkedom` + `@mozilla/readability`, with a manual fallback (title + meta description + stripped body) when Readability finds nothing usable. Before extraction, common boilerplate (infoboxes, navboxes, sidebars, reference markers, tables of contents, edit-section links, `<nav>`/`<aside>`) is stripped from the page, and the remaining HTML is converted to text block-by-block (a newline after each paragraph/heading/list item/table row, a space between table cells) so text never gets glued together across cells or blocks the way plain `textContent` would. The excerpt picks the first real paragraph (≥ 80 characters with sentence punctuation) rather than whatever text happens to come first in the markup, such as an infobox. PDFs and images are recorded with a filename-derived title (no OCR, no rendering). YouTube/Vimeo get an oEmbed title with no API key required. A link saved before this extraction logic improved can be fixed up in place with **refetch_link** / `POST /api/links/:id/refetch` (or the "Reintentar descarga" button in the reader) — it re-runs the current extraction code against the same URL and overwrites the stored title, excerpt and text.
- Search: FTS5 when the runtime's SQLite build supports it (verified at every startup); otherwise a `LIKE` fallback across the same fields, both reported in `GET /api/state`.

## Verification

```sh
npm test
npm run build
```

Tests use temporary data directories and a local HTTP server for fixtures — nothing touches your real data or the network. They cover URL normalization, Readability extraction against an HTML fixture, save idempotency, full-text search, the digest, highlights, bookmarks/URL-list import parsing, agent token auth, and a full API round-trip.

Design and decisions: [`DESIGN.md`](DESIGN.md).
