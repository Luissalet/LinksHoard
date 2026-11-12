<img src="app-icon.png" width="96" alt="">

# Links Hoard

A local-first read-later library: save a URL, get the extracted article text, tag and highlight it, search everything, and let an assistant use it through MCP. [Español](README.es.md)

## What it is

Links Hoard stores links in a single SQLite file on your own computer. Saving a link fetches the page in the background and extracts the readable article (title, byline, excerpt, full text), so you read a clean copy and search it later. Beyond bookmarks, it follows feeds and pages, downloads media, digests videos, narrates articles and can answer questions about what you saved.

It runs as its own Hoard with its own server, port, data folder and MCP bridge. Writer's Hoard uses it by reference for its reading and links module.

## What it does

### Save and read
- Paste a URL, use the bookmarklet, share into the installed PWA (the manifest declares a share target) or call `save_link`. The link is stored at once and fetched by a background queue; saving is idempotent on a normalised URL (tracking parameters, fragments, default ports and trailing slashes are ignored).
- Reader with adjustable font size, original URL, site, author and reading time; select text to highlight with an optional note.
- Tags, favourites, archive and read/unread state, with tag counts and site filters.
- Full-text search (SQLite FTS5, with an automatic `LIKE` fallback) over title, description, text, notes, tags and video transcripts.
- Bulk import from a browser bookmarks export (Netscape HTML) or a list of URLs, deduplicated against the library.
- Weekly digest of what was saved since a date, grouped by site.
- "To read today" suggestions from the saved-but-unread, and reading plans that fit complete unread texts into a minute budget. See [docs/READING_PLAN.md](docs/READING_PLAN.md).
- Highlights can be sent to Hypatia's Hoard as flashcards in the deck "Lecturas".

### Ask a saved article
- The reader answers questions about an article through the Hub model, with exact quotes and clickable paragraph anchors; invalid quotes and changed text are reported. Questions and answers are transient. See [docs/ARTICLE_QUESTIONS.md](docs/ARTICLE_QUESTIONS.md).

### Watches
- Follow an RSS/Atom feed, a GitHub repository (releases, tags or commits) or a plain page (text diff on every change), each on its own interval.
- List watches follow the entries of a page without a feed (job offers, products, listings) using an automatically found or user-given CSS selector.
- Items found by watches can be read, dismissed or saved as links.

### Save a whole site
- Map a site or section from its sitemaps and links, with include/exclude patterns, then save the pages as links in a background job that honours `robots.txt`, skips what is already saved, can be resumed or cancelled and keeps a history.

### Downloads
- Video, audio and photo posts from YouTube, X, Instagram, TikTok, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili and any other site yt-dlp supports, using yt-dlp, gallery-dl and ffmpeg as separate programs.
- Formats `video` (MP4), `audio` (MP3), `image` or `auto`; quality choice, sections, optional playlists; a one-at-a-time queue with progress, cancel and retry.
- A "Sign in with <site>" button for private posts, using the app's own browser profile; the user signs in, never the assistant.
- yt-dlp refreshes itself when it gets old or fails the way an outdated build does.
- Finished downloads can be saved as links tagged `descarga`.

### Video
- **Insight**: a transcript with timestamps (Funes through Hoard Link, or local faster-whisper) and up to 24 scene-change key frames; the transcript is searchable.
- **Digest**: download, transcribe, read on-screen text by OCR and write chapters and a summary with the Hub's local models into a layered dossier an assistant can read cheaply, ask questions of and search. See [docs/VIDEO_DIGEST.md](docs/VIDEO_DIGEST.md).

### Listen
- Narrate a saved article (or a video's digest) through Prospero's Hoard, sentence by sentence as a background job, with the audio stored locally.
- Player bar with play/pause, skip, speed and resume position; an ordered "listen later" queue; voice chosen by the link's language or on the Listen page. See [docs/ESCUCHAR.md](docs/ESCUCHAR.md).

### Sentidos
- A local listening engine (CLAP and AudioSet models on CPU) that describes a sound, finds and matches sounds, measures audio, checks how real a sound is, draws timelines and contact sheets, and builds a soundtrack layer for video digests. See [docs/SENTIDOS.md](docs/SENTIDOS.md).

### Faustus copilot and App Dock
- The shared Faustus panel is available in every view and receives the current link, selected paragraph or text and unsaved form values; lists and the reader refresh after a turn without losing unsaved notes.
- Beside a Faustus chat, the app registers view tools (`links_open`, `links_filter`, `links_view`) so the assistant can open links, apply filters and switch sections. See [docs/COPILOT.md](docs/COPILOT.md).

## How to run it

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`). No native modules, no Docker.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:5181
```

`npm run open` starts the server and opens the browser on Windows; `npm run dev` runs the API with `node --watch` plus Vite. The server binds to `127.0.0.1` only. If port 5181 is busy it takes the next free one; `PORT_STRICT=1` makes it fail instead.

| Variable | Purpose |
| --- | --- |
| `LINKS_PORT` / `PORT` | Preferred port (default `5181`). |
| `LINKS_DATA_DIR` | Data folder (default `<repo>/data`): `links-hoard.db` and `mcp-token`. |
| `LINKS_ALLOWED_HOSTS` | Extra host names accepted behind a tunnel, comma-separated, exact or `*.suffix`. |
| `LINKS_ALLOW_PRIVATE_URLS=1` | Allow fetching from this machine or your own network; off by default. |
| `LINKS_URL`, `LINKS_TOKEN_FILE` / `LINKS_TOKEN` | MCP bridge: base URL of the running app and where to read its token. |
| `LINKS_MEDIA_DIR` | Downloads folder when none is set in Settings (default `<home>/Downloads/Links Hoard`). |
| `LINKS_YTDLP`, `LINKS_GALLERYDL`, `LINKS_FFMPEG` | Paths of the external programs; the family-wide `HOARD_*` variants also work and win. |
| `LINKS_FAUSTUS_URL` | Faustus endpoint for the copilot. |
| `LINKS_WATCHES=0` | Disable the watch scheduler. |
| `LINKS_VIDEO`, `LINKS_VIDEO_AUTO`, `LINKS_VIDEO_AUTO_DOWNLOAD` | Control the background video analysis and automatic downloads. |
| `LINKS_WHISPER_MODEL` | Local faster-whisper model for the transcript fallback. |
| `LINKS_SENTIDOS_VENV`, `LINKS_SENTIDOS_HOME` | Python environment and home of the Sentidos engine. |
| `LINKS_COOKIES_FILE`, `LINKS_SESSIONS_DIR` | Cookies file and sign-in session folder for private posts. |

The server answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`; to reach it from a phone through a tunnel, add the tunnel's host names to `LINKS_ALLOWED_HOSTS`.

Pages are fetched with the family's shared fetcher: every redirect hop is checked against private and metadata addresses, the body is capped at 5 MB, and HTML goes through Readability with a manual fallback.

## Connection with Faustus and Hoard Hub

- App id `links`, default port 5181; `faustus-plugin.json` is the plugin manifest. Start it from the Hoard Hub or with `npm start`.
- The MCP bridge (`server/mcp.js`) proxies every call over HTTP to the running app, authenticated with the token in `<data dir>/mcp-token`; it never opens the database itself. `GET /api/agent/tools` returns the live tool list. Tool descriptions end with Spanish synonyms so Spanish phrasing matches the right tool.
- Tools by group: saving and reading (`save_link`, `list_links`, `search_links`, `read_link`, `read_link_paragraphs`, `ask_link`, `edit_link`, `tag_link`, `mark_link`, `add_highlight`, `refetch_link`, `delete_link`, `list_tags`, `link_digest`, `resurface`, `reading_plan`, `highlights_to_cards`, `import_video_transcript`); watches (`watch_*`); site mapping and crawling (`map_site`, `crawl_*`); downloads (`media_*`, `site_sessions`, `site_login`, `site_logout`, `read_post`); video (`link_video*`, `video_digest*`, `video_ask`, `video_find`, `video_frame`); listening (`listen_*`); sound (`audio_*`).
- The assistant is told to summarise or quote a link only from the text `read_link` returns, and to say plainly when a fetch is pending or failed.
- Writer's Hoard forwards its reading views and tool calls to this app through the Hub and offers to start it when it is not running.
- The manifest names the skills `read-later-digest` and `web-to-clean-markdown`, shown in the Hub's Skills tab.

## Project layout

| Path | Contents |
| --- | --- |
| `server/` | Node server: API, extraction, watches, crawls, downloads, video, listening, MCP bridge |
| `client/` | Web interface (Vite) |
| `sentidos/` | Python listening engine |
| `docs/` | Feature references |
| `scripts/` | Helper scripts |
| `tests/` | Test suite |
| `data/` | Local database and token (gitignored) |
| `faustus-plugin.json` | Faustus plugin manifest |

## Development

```sh
npm test
npm run build
```

Tests use temporary data directories, a local HTTP server for fixtures, a fake hub and fake yt-dlp, gallery-dl and ffmpeg scripts. Design notes are in [DESIGN.md](DESIGN.md); goals and known issues in [docs/OBJETIVOS.md](docs/OBJETIVOS.md) and [docs/REVISAR.md](docs/REVISAR.md) (Spanish).

Data: `data/links-hoard.db` (SQLite with WAL) holds links, highlights, watches, the download list and settings; downloaded files live in the downloads folder. See `LICENSE`.
