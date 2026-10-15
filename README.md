# Links Hoard

Local-first read-later bookmark library: save a URL, get the extracted article text, tag it, highlight passages and search everything — stored in a single SQLite file on your own computer and exposed to an assistant through MCP.

Spanish version: [`README.es.md`](README.es.md).

## Faustus copilot

The shared Faustus button opens its chat panel in every view. Faustus owns
conversations, drafts, memory and agent execution; Links supplies the current
native link, a selected current paragraph, selected text and form values that
have not been saved. New and missing links provide app context without an
invented object. Completing a turn refreshes lists and the reader while keeping
unsaved notes and settings. Manual tag additions and removals preserve labels
added by the agent. `edit_link` exposes partial title, notes and tag edits through
the normal agent API and MCP. Credentials stay in the server; configure its
Faustus endpoint with `LINKS_FAUSTUS_URL` or backend settings.

## Ask a saved article

The reader's **Preguntar al artículo** form answers through the Hub model with
exact quotes and clickable paragraph anchors. A click highlights and focuses
the source paragraph. MCP offers the same capability through `ask_link` and
`read_link_paragraphs`. Partial context, unavailable models, invalid quotes and
changed text are reported. Quote checks verify provenance, not interpretation;
questions and answers are transient and do not edit the saved library.
See [the API, MCP contract and limits](docs/ARTICLE_QUESTIONS.md).

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
| `LINKS_ALLOW_PRIVATE_URLS=1` | Let the app fetch pages, feeds and media from addresses on this machine or your own network (a NAS, a wiki on the LAN). Off by default: only the public internet is reachable, and every redirect hop is checked. |
| `LINKS_MEDIA_DIR` | Downloads folder when none is set in Ajustes (default `<home>/Downloads/Links Hoard`). |
| `LINKS_YTDLP` / `LINKS_GALLERYDL` / `LINKS_FFMPEG` | Path of each program (see [Downloads](#downloads)); the family-wide `HOARD_YTDLP` / `HOARD_GALLERYDL` / `HOARD_FFMPEG` work too and win. Also accepts `node:<script.js>` and `python -m yt_dlp`. |
| `HOARD_HOME` | The family's folder; `<HOARD_HOME>/bin` is searched for the programs (default `~/.hoard`). |
| `LINKS_MEDIA_SIBLING_DIR` | One more folder searched for the programs, after `<HOARD_HOME>/bin` and before the `PATH` (default `../Writers hoard desktop/resources/bin`); `off` skips it. |
| `LINKS_MEDIA_AUTO_UPDATE` / `LINKS_MEDIA_STALE_DAYS` | `0` turns off the automatic yt-dlp update (the Ajustes switch does the same); age in days after which yt-dlp is refreshed before a download (default 45). |
| `PYTHON` | Python interpreter used for `python -m yt_dlp` / `pip install -U` (default `python3`, `python` or `py -3`). |
| `LINKS_VIDEO` / `LINKS_VIDEO_AUTO` / `LINKS_VIDEO_AUTO_DOWNLOAD` | Video insight: `LINKS_VIDEO=0` stops the background sweep (retries, new videos); `LINKS_VIDEO_AUTO=0` stops analysing a video as soon as a file for it exists; `LINKS_VIDEO_AUTO_DOWNLOAD=1` also downloads the video of every saved video link (off by default). |
| `LINKS_VIDEO_MAX_FRAMES` / `LINKS_VIDEO_MAX_UPLOAD_MB` / `LINKS_VIDEO_RETRY_S` | Key-frame cap (default 24), largest attached file (default 500 MB), seconds before each retry (default `60,300,1800`). |
| `LINKS_WHISPER_MODEL` / `LINKS_WHISPER_ALLOW_DOWNLOAD` / `LINKS_PYTHON` | Local fallback engine: faster-whisper model (default `base`, must already be in the cache unless `LINKS_WHISPER_ALLOW_DOWNLOAD=1`) and the Python that has it. |
| `LINKS_COOKIES_FILE` | Netscape cookies file for private posts (the setting in Ajustes wins). |
| `LINKS_COOKIES_BROWSERS` | Comma-separated browsers to try for cookies, in order (default `firefox,chrome,edge,brave,chromium,vivaldi,opera`). |
| `LINKS_LOGIN_BROWSER` | Browser executable for the sign-in window (default: the system's default browser when it is Chromium-based, else the first of Chrome, Edge, Brave, Vivaldi, Chromium found; Ajustes can pick one). |
| `LINKS_SESSIONS_DIR` | Where the sign-in profile and `cookies.txt` live (default `<data>/sessions`). |
| `LINKS_MEDIA_TRANSCODE=0` | Do not re-encode downloaded videos that are not H.264/AAC. |

### Access from your phone (behind a tunnel)

The server binds 127.0.0.1 and only answers requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`. To reach it from your phone through a tunnel that fronts the app (a private mesh network, a reverse proxy), list the extra host names in `LINKS_ALLOWED_HOSTS`, comma-separated, exact names or `*.suffix`: `LINKS_ALLOWED_HOSTS=my-pc.example,*.ts.net`. Port and letter case are ignored, and the `Origin` of API calls must resolve to one of those hosts too (any scheme or port). Cross-site *fetches* are still refused; opening the app from another page (a link, a bookmarklet, the share sheet) is a normal navigation and works.

## What it does

- **Save instantly.** Paste a URL (or use the bookmarklet, the browser share sheet once installed as a PWA, or an assistant's `save_link` tool) and it is stored right away with `fetch_status: pending`. A background queue (2 at a time) downloads the page, extracts the article with Readability and fills in title, byline, excerpt and full text — the row updates itself, no reload needed.
- **Read cleanly.** The reader shows the extracted text at an adjustable font size, with the original URL, site, author and reading time. Select any text to highlight it, with an optional note.
- **Read within your available time.** Ask Faustus for a `reading_plan` with a minute budget, assumed reading speed and optional tag/site filters. It combines complete unread saved texts that fit, reports estimated and unused minutes, and leaves the library and daily picks unchanged. See [Reading plans](docs/READING_PLAN.md).
- **Organize.** Tags, favorites, archive, read/unread. Sidebar shows tag counts; the list can filter by site too.
- **Search everything.** Full-text search (SQLite FTS5) over title, description, extracted text, notes and tags. If the runtime's SQLite build lacks FTS5 the app falls back to a plain `LIKE` search automatically and says so in Ajustes.
- **Import in bulk.** Netscape bookmarks HTML (what every browser exports) or a plain list of URLs, one per line. Both dedupe against what you already have.
- **Weekly digest.** `GET /api/digest?since=` (and the `link_digest` MCP tool) lists what was saved since a date, grouped by site, with excerpts.
- **Watches (Vigía).** The library also *brings things in*: follow an RSS/Atom feed, a GitHub repository (releases, tags or commits — no API token, its public Atom feeds) or a plain page (a text diff on every change). Each is checked on its own interval (default 60 min, scheduler in-process, `LINKS_WATCHES=0` to disable); the first check is a baseline, and every later new entry, release or change becomes a *watch item* and, with `auto_save`, a saved link with the watch's tags (source `watch`), fetched like any other. A page that advertises a feed (`<link rel="alternate" type="application/rss+xml">`) becomes a feed watch automatically. Every new item is posted to the family bus as `links.watch.new` (and page changes as `links.watch.changed`), so a Hoard Hub rule or the assistant can react — a digest, a flashcard, a note.
- **Download media.** Tell the assistant "descárgame esto: <link>" (or paste the link in **Descargas**) and the video, the audio or the photos land in a folder on your disk: YouTube, X, Instagram, TikTok, Audiomack, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili and every other site yt-dlp knows. See [Downloads](#downloads).
- **Highlights to flashcards.** Each highlight in the reader has **Enviar a Hypatia** (and the list has **Enviar todos a Hypatia**); the `highlights_to_cards` tool does the same for one link or everything saved since a date. The card goes through the hub to Hypatia's `cards_add` in the deck **Lecturas**: front = the highlighted text, back = your note and the article title, `source_ref = hoard://links/highlight/<id>`. A highlight is sent once (`highlights.card_sent_at`; the reader shows *En Hypatia ✓*); `resend` sends it again and Hypatia does not duplicate the card. Nothing is marked as sent unless Hypatia answered, and the reply says why when the hub is down (`hub_down`) or Hypatia is not there (`hypatia_unavailable`). Creating a highlight posts `links.highlight.added {highlight_id, link_id}` on the family bus.
- **Para leer hoy.** The Bandeja opens with a few links saved a while ago (3 by default, 1 to 10 in Ajustes), and `resurface {count}` answers the same list. Candidates: unread for at least 2 days (older first; favourites, highlights and topics you actually read weigh more), plus links read two weeks ago that carry highlights, for a re-read; downloads, archived and unfetched links never. The same link is not offered twice within 14 days (30 for a re-read); the day's list is stored, so it does not change until tomorrow (a link you read drops out of it). Once a day, from 08:00 local, one `digest.item` event ("Para leer hoy (3): …") goes to the hub for the family digest, only when there is something to read and only marked as sent when the hub took it. `LINKS_RESURFACE=0` or the Ajustes switch turns the daily line off.
- **Install as an app.** `manifest.webmanifest` declares a `share_target`, so once installed on Android you can share a page from any app straight into Links Hoard.

## Downloads

The **Descargas** page (`#/descargas`) and the `media_download` tool turn a link into files on disk. Video and audio go through [yt-dlp](https://github.com/yt-dlp/yt-dlp), photo posts and carousels that yt-dlp cannot take ("There is no video in this post") through [gallery-dl](https://github.com/mikf/gallery-dl). Both run as separate programs; the app does not bundle them.

- **Sites.** YouTube, X (Twitter), Instagram, TikTok, Audiomack, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili and more get a label; any other URL is still handed to yt-dlp (labelled "Otro (yt-dlp)"), which supports over a thousand sites.
- **Formats.** `video` (MP4; H.264 + AAC is preferred and a file in another codec is re-encoded with ffmpeg so it plays everywhere), `audio` (MP3, best quality), `image` (gallery-dl) or `auto` (video; when the post has no video, its photos). `quality` for video: `best`, `1080`, `720`, `480`. A playlist is only downloaded with `playlist: true`, up to `max_items` (default 50).
- **Where files go.** The folder in **Ajustes → Descargas** (`media.dir`), else `LINKS_MEDIA_DIR`, else `<home>/Downloads/Links Hoard`; `dir` on a single call overrides it. Files are named `title [id].ext`, made safe for Windows; an existing file is never overwritten, and photo posts get their own sub-folder (`uploader - caption`, numbered if it exists). No `.info.json`, thumbnails or other sidecar files are left: title, caption, uploader, date and duration are stored in the database.
- **Queue.** One download at a time, first in first out, with progress (percent, speed, ETA) kept live in memory and mirrored to the `media_downloads` table. Cancelling removes a waiting download without running it; cancelling the running one kills yt-dlp and everything it started (`taskkill /T /F` on Windows). On the next start, downloads that were running become *failed* ("interrumpida al cerrar la app") and downloads that were still waiting are queued again.
- **Library link.** With `save_link` (default on) a finished download also saves the URL as a link tagged `descarga` (source `download`, kind video, audio or image) with the note "Descargado en <path>"; when the page itself gives no text (Instagram, X), the caption becomes the link's text so `read_link` and search find it. It posts the canonical job events on the family bus: `links.job.queued`, `started`, `progress` (at most every 3 seconds), `done`, `failed` and `cancelled`, each with `{job_id, title, kind: "download", progress 0..1, gpu: false, eta_s, url, error}` plus `source_url`, `platform`, `format`, `media_kind`, `dir`, `files`, `bytes` and `link_id`. The hub already maps the old `links.media.*` names to these, so those are no longer sent (a rule written against them keeps matching through the hub).
- **Public videos need no account.** When YouTube answers a download with "Sign in to confirm you're not a bot" (it does that to some addresses even for public videos), the app repeats the attempt through yt-dlp's embedded and mobile web players (`player_client=default,web_embedded,mweb`), which still answer, before reaching for any cookies.
- **Sign in with a button.** For private posts, age-restricted videos or sites that insist on an account, a failed download (and a failed video digest, and **Ajustes → Sesiones para descargar**) shows **Iniciar sesión con <site>**: the app opens your default browser on the computer it runs on when it is a Chromium one (Brave, Chrome, Edge, Vivaldi…; with Firefox as default it uses the first of those installed, and Ajustes lets you pick another), with a browser profile of its own per browser (`data/sessions/browser-profile-<browser>`), on that site's login page. You sign in as usual; the app reads the session through the browser's DevTools port, writes the known sites' cookies to `data/sessions/cookies.txt` and closes the window a few seconds after the login cookie appears (closing it yourself also saves; "Ya he terminado" saves at once). Downloads then try, in order: no cookies, the fallback players (YouTube), that saved session, and the cookies of your browsers (Firefox, Chrome, Edge, Brave, Chromium, Vivaldi, Opera). "Cerrar sesión" deletes a site's cookies from the profile and the file; your everyday browser is never touched and no cookie value leaves the server. Sites with a button: YouTube, X, Instagram, Threads, TikTok, Facebook, Reddit, Twitch, Vimeo, Pinterest, SoundCloud, Bilibili, Patreon. `cookies_browser` still picks one browser (or `none`), and a Netscape `cookies.txt` set in **Ajustes → Descargas** replaces all of this. `LINKS_LOGIN_BROWSER` points at another browser executable.
- **Tools needed.** yt-dlp for video and audio, gallery-dl for photos, ffmpeg to merge streams and make MP3 (video works without it, as a single file). Each is looked up in this order (the shared lookup of the family): its variable (`HOARD_YTDLP`…, then `LINKS_YTDLP`…), `<HOARD_HOME>/bin`, the sibling folder `../Writers hoard desktop/resources/bin`, the `PATH`, the usual system folders, and `python -m yt_dlp` / `python -m gallery_dl` (ffmpeg also through `imageio-ffmpeg`). Install with `python -m pip install -U yt-dlp gallery-dl` and `winget install Gyan.FFmpeg` on Windows. The **Herramientas** card in Descargas (and `media_tools`) shows what was found with versions, and **Actualizar** runs `yt-dlp -U` / `gallery-dl -U` or `pip install -U` when they run as Python modules. Windows `.cmd`/`.bat` shims on the `PATH` are ignored; use the `.exe` or point the variable at it.
- **yt-dlp keeps itself current.** Sites change and an old yt-dlp starts failing (a YouTube video answering HTTP 403 is the usual sign). Before a download, a yt-dlp build older than 45 days is updated; and when a download fails the way an outdated yt-dlp fails, it is updated and the download is repeated once, before any browser cookies are tried. At most one automatic update every 6 hours; the switch is in Ajustes → Descargas, which also shows the last automatic update.
- **Play and show.** The page plays the files in place (video, audio, images) from `GET /api/media/:id/file`, which supports Range requests, and opens Explorer with the file selected. In the reader, a saved video (or a link from a known site) has a **Descargar** button.
- **Family service.** Links Hoard owns media downloads for the whole family: the other apps ask it through the hub instead of running yt-dlp themselves. `media_download` also takes `sections` (`[[start_s, end_s], ...]`, at most 10: only those parts are downloaded, one file each, named `[part N]` when there are several), `max_duration_s` (a longer video is refused before anything is downloaded), `max_height` (caps the resolution; the lower of it and `quality` wins) and `dest_dir` (alias of `dir`). `media_info` is the probe plus thumbnail, caption languages, id, extractor and `is_live`; `media_subtitles` returns the captions of a video as text with timing without downloading it (languages in order of preference, manual before automatic); `media_audio_for_asr` returns a mono 16 kHz WAV under `<downloads>/asr/` for speech to text and never saves a library link.
- **Which addresses.** A media link must point at the public internet: other schemes, `localhost`, `*.local`, IP addresses of this machine or a private network, and public-looking names that resolve to one are refused. `LINKS_ALLOW_PRIVATE_URLS=1` lifts the address rule for a server on your own network.
- **Limits.** The app does not decrypt DRM streams, sign in for you, or download from sites yt-dlp and gallery-dl cannot read. Deleting files from the app is permanent (Node has no recycle bin) and only happens with an explicit request.

REST routes (same local guard as the rest of `/api`):

| Route | Use |
| --- | --- |
| `GET /api/media` | List, newest first (`?status=` any status, `active` or `finished`; `?limit=`). |
| `POST /api/media` | Start `{ url, format, quality, dir, save_link, playlist, max_items, cookies_browser }`; returns the queued row (an identical download in progress is returned with `existing: true`). |
| `GET /api/media/:id` | One download with progress, files and metadata. |
| `POST /api/media/:id/cancel` · `retry` | Cancel (waiting or running) / queue the same download again. |
| `DELETE /api/media/:id` | Remove the record; `?files=1` also deletes the downloaded files. |
| `GET /api/media/:id/file?i=0` | Stream a produced file (Range supported; `&download=1` as attachment). |
| `POST /api/media/:id/reveal` | Open the file manager on the file (`explorer /select,` on Windows). |
| `POST /api/media/probe` | What a link holds (title, duration, heights, playlist or photo post) without downloading. |
| `GET /api/media/tools` · `POST /api/media/tools/update` | Programs found with versions / update them. |
| `GET /api/media/settings` · `PUT /api/media/settings` | Downloads folder and cookies file. |
| `GET /api/sessions` | The sites with a sign-in button, whether each is signed in, the browser found and the open login window (no cookie values). |
| `PUT /api/sessions/settings` | `{ browser }`: the browser for the sign-in window (`auto` = the default one). |
| `POST /api/sessions/:site/login` · `POST /api/sessions/finish` · `POST /api/sessions/cancel` · `DELETE /api/sessions/:site` | Open the sign-in window / save now and close it / close it / sign the app out of a site. |
| `POST /api/highlights/:id/to-cards` | `{ deck? }`: send one highlight to Hypatia (answers 200 with `{ok, status, deck, sent, skipped}`). |
| `POST /api/links/:id/cards` · `POST /api/cards/from-highlights` | `{ deck?, resend? }` for one link / `{ link_id?, since?, deck?, resend? }` for everything that has not gone yet. |
| `GET /api/resurface` | `?count=`: today's "Para leer hoy" list, each item with its `reason`. |
| `GET /api/settings` · `POST /api/settings` | `{ resurface: { digest, count } }`. |

## Video insight (transcript and key frames)

A saved video link (a reel, a short, a video page, or any media file the app holds) gets, in the background:

- a **transcript with timestamps**: the family speech-to-text service (Funes, through Hoard Link) when it is running; otherwise `faster-whisper` on the CPU if Python has it and its model is already cached (nothing is downloaded behind your back); otherwise the step is marked `skipped` and retried later (up to 3 attempts, 1 / 5 / 30 minutes);
- **key frames**: ffmpeg scene changes (`select=gt(scene,0.3)`), an opening frame and timed frames in the gaps, at most 24 JPEGs (640 px wide) in `<data>/video/<link id>/frames`, each with its time.

Where the media comes from, in order: a file you give (path or upload), a finished download of that link (Descargas), and only on request (`download: true`, the "Descargar y analizar" button, or the `auto_download` setting) a download with the app's own yt-dlp integration. Finished downloads of videos are analysed by themselves (`auto`, on by default). The job is idempotent: the same file with nothing missing is not redone; only the missing part (for example the transcript) is retried; `force` redoes everything.

The transcript is part of the full-text search (`/api/links?q=` and the Bandeja box find a link by what is said in it), and `GET /api/video/search?q=` returns the lines with their time. In the item view, "Vídeo: transcripción y fotogramas" shows the status, the frame strip (click a frame to jump to the matching line) and the timed transcript with a filter.

| Endpoint | What |
| --- | --- |
| `GET /api/links/:id/video` | status, frames (with `url` and `path`), transcript (text, segments, engine) |
| `POST /api/links/:id/video/analyze` | `{path?, download?, force?, language?}`; 202 while it runs, 200 when already done |
| `PUT /api/links/:id/video/file?name=clip.mp4` | raw bytes of a video/audio file to attach (max 500 MB) |
| `GET /api/links/:id/frames/:idx` | one frame (JPEG) |
| `GET /api/video/search?q=` | spoken-word search with times |
| `GET` / `PUT /api/video/settings` | `auto`, `auto_download`, `max_frames`, `max_duration_s`, `scene_threshold`, `whisper_model` |

MCP tools: `link_video` (transcript + frames of a link), `link_video_analyze` (start / repeat, waits up to `timeout_s`), `link_video_search`.

Limits: needs ffmpeg; a video with no audio track gets `no_audio`; very long videos are cut at `max_duration_s` for scene detection; no OCR of the frames; the app never downloads a video by itself unless `auto_download` is on.

## Video digest (watch a video for an assistant)

Paste a link (a post on X with a video, YouTube, a reel) on the **Vídeos** page, or have an assistant call `video_digest`: the app downloads it, transcribes it, walks the whole picture, reads the screen text by OCR and writes chapters and a summary with the Hub's local models, then leaves a layered dossier under `<data>/video/<link id>/digest/` — `card.md` (source, post text, summary, key points, answer to your focus, what each layer costs), `index.md` (chapters with what is said and shown), `visual.md` (every visual segment with its literal screen text), `transcript.md`, `digest.md`, a 4×4 mosaic with timestamps and one frame per distinct shot. An assistant reads the brief level (card + index) for a few thousand tokens instead of hundreds of thousands for the frames, then asks (`video_ask`, answers with checked verbatim quotes and times), searches (`video_find`) or pulls the exact frame of an instant (`video_frame`). Literal and generated material are always labelled apart. From a shell: `node scripts/digest.mjs <url> --focus "…"`. Details, settings and limits: [docs/VIDEO_DIGEST.md](docs/VIDEO_DIGEST.md).
## URL normalization (the dedupe key)

Saving is idempotent on a normalized form of the URL (the family's shared rule, `normalizeUrl` of `hoard-commons/web.js`): `utm_*`, `fbclid`, `gclid`, `mc_*` and similar tracking params are stripped, the fragment is dropped, the host is lowercased, default ports and a trailing slash are removed (the bare root has no slash), the query is sorted, and a LinkedIn job link keeps only its job id. A scheme-less `example.com/page` is accepted and gets `https://`. When an older library is opened, the saved links are re-keyed to this form once. Saving an already-saved page (even with different tracking params) returns the existing link with `existing: true` instead of duplicating it.

## How pages and feeds are fetched

Saved pages, watches and oEmbed titles use the family's shared fetcher (`hoard-commons/web.js`): the address of every redirect hop is checked (loopback, private, link-local and cloud-metadata addresses are refused unless `LINKS_ALLOW_PRIVATE_URLS=1`), the charset comes from the header or the page, the body is capped (5 MB for pages, 3 MB for feeds) and a Cloudflare, CAPTCHA or login page is reported as a failed fetch ("blocked: …") instead of being saved as the content. A **page watch** compares the text with clocks, "5 minutes ago" lines and similar noise removed, never counts a blocked or too-short page (under about 40 words) as a change, and sends the stored `ETag` / `Last-Modified` back so an unchanged page answers 304. Watches read public addresses through the family hub when it is running (one polite fetcher for every app) and directly otherwise.

## Connect an assistant

In **Ajustes** (or via `faustus-plugin.json`) an assistant configured for local MCP servers over stdio can connect using `server/mcp.js`, `LINKS_URL` and `LINKS_TOKEN_FILE`. The bridge never opens the database itself: every call is proxied over HTTP to the running app, authenticated with a random token in `<data dir>/mcp-token` that is created once and then kept, so a bridge that is already running keeps working after the app restarts. The app is also on the family bus (Hoard Link 0.8, `server/hoard-link.js` and the shared commons in `server/hoard-commons/`): every agent call is posted to the Hoard Hub as an `agent.call` event, `/api/health` carries the `hoard_link` block, and the hub's proxy (`POST <hub>/api/apps/links/call`) can reach these tools on behalf of any sibling app.

Tools:

| Tool | Use |
| --- | --- |
| `save_link` | Save a URL (idempotent); waits up to 10 s for the fetch so it can report the real title/excerpt. |
| `list_links` | List by state (unread/read/archived/all), tag, site, since. |
| `search_links` | Full-text search. |
| `read_link` | Read the extracted text, paginated by characters; includes highlights. |
| `read_link_paragraphs` | Whole saved paragraphs, paginated by index, with versioned reader anchors. |
| `ask_link` | Ask the Hub model about saved text; answer sentences include checked quotes and paragraph anchors. |
| `import_video_transcript` | Import available captions from a saved YouTube video for reading, search and quotes. Uses the same caption path as `media_subtitles` (yt-dlp, found like the download tools); does not download the video. |
| `tag_link` | Add/remove tags. |
| `edit_link` | Edit only the supplied title, notes or tags; label deltas preserve other labels. |
| `mark_link` | Set read/unread/archived/favorite. Repeating read status preserves the original reading date. |
| `add_highlight` | Save a highlighted quote with a note. |
| `link_digest` | What was saved since a date, grouped by site. |
| `refetch_link` | Re-download and re-extract. |
| `delete_link` | Permanently delete (destructive; confirm first). |
| `watch_add` | Follow a feed, a GitHub repository or a page for new things (kind auto-detected; interval, tags, auto_save). |
| `watch_list` | The watches with last check, last error and item count. |
| `watch_items` | What the watches brought in (unread first; since; per watch). |
| `watch_check` | Check one watch (or every due one) now. |
| `watch_dismiss` | Mark an item as seen. |
| `watch_remove` | Stop following (items and saved links stay). |
| `highlights_to_cards` | Send highlights (of a link, or all not yet sent / since a date) to Hypatia as flashcards in the deck "Lecturas" (`link_id`, `url`, `since`, `deck`, `resend`); reports `status` (`ok`, `nothing_new`, `hub_down`, `hypatia_unavailable`, `hypatia_error`, `unknown_link`). |
| `resurface` | What to read today from the saved-but-unread (`count`, default 3); the same list all day, never the same link twice in 14 days. |
| `reading_plan` | Choose complete unread texts for `minutes`, with `words_per_minute` (default 200), `max_items` (default 5), optional `tag` / `site`; estimates only, no state changes. |
| `list_tags` | Every tag in use, with counts. |
| `media_download` | Download the video, audio or photos behind a link; waits and returns the files with absolute paths and sizes (`format`, `quality`, `max_height`, `sections`, `max_duration_s`, `dir` / `dest_dir`, `save_link`, `playlist`, `wait`, `timeout_s`). A finished download also lists its files in `deliverables`, which Faustus turns into download links for the chat (desktop save dialog, browser or phone). |
| `media_status` | Progress and result of one download or the recent list. |
| `media_cancel` | Cancel a waiting or running download. |
| `media_retry` | Queue a failed or cancelled download again. |
| `media_probe` | Title, duration, available heights, playlist or photo post — no download. |
| `media_info` | The probe plus `id`, `extractor`, `thumbnail`, `subtitle_langs` and `is_live` (the family's info call). |
| `media_subtitles` | Captions of a video as text and timed cues (`langs`, manual before automatic) — no download. |
| `media_audio_for_asr` | The audio of a link as a mono 16 kHz WAV for speech to text (`sections`, `max_duration_s`, `wait`, `timeout_s`). |
| `media_tools` | Whether yt-dlp, gallery-dl and ffmpeg were found, with versions; `update: true` updates them. |
| `site_sessions` | Which sites the app holds a signed-in session for, the browser it uses and the login window if open. |
| `site_login` | Open the sign-in window for a site on the computer the app runs on (`site`; `finish` saves now, `cancel` closes); the user signs in, never the assistant. |
| `site_logout` | Forget the app's session on a site. |
| `media_delete` | Remove a download record; its files only with `delete_files` and `confirm`. |
| `video_digest` | Watch a video locally and return a layered text digest (`url` or `id`, `path`, `focus`, `level`, `force`, `wait`, `timeout_s`). See [docs/VIDEO_DIGEST.md](docs/VIDEO_DIGEST.md). |
| `video_digest_read` | One layer (`brief`, `card`, `index`, `visual`, `transcript`, `full`) or one span (`from`, `to`) of a digest. |
| `video_ask` | A question answered from the transcript and screen text, with checked verbatim quotes and times. |
| `video_find` | Search spoken words and screen text in one or all digested videos. |
| `video_frame` | The exact frame at an instant (`t`, `width`): path, size and token cost. |
| `video_digests` | The latest digests and their state. |

46 tools in total. `GET /api/agent/tools` always reflects the live list. Tool descriptions end with a `Sinónimos:` line of Spanish words, so a Spanish-speaking user's phrasing ("guarda esto", "resumen de la semana") matches the right tool.

The assistant is instructed to summarize or quote a link only from the text `read_link` returns, never from the title alone, and to say plainly when a fetch is still pending or failed rather than guessing.

## Data and limits

- `data/links-hoard.db`: links, highlights (and which ones went to Hypatia), watches, the download list and settings, SQLite with WAL. Downloaded files are not in the data folder: they are in the downloads folder.
- `data/mcp-token`: local credential created at startup; not published or included anywhere else.
- Fetch: 15 s timeout, a browser-like User-Agent header, 5 MB body cap. HTML goes through `linkedom` + `@mozilla/readability`, with a manual fallback (title + meta description + stripped body) when Readability finds nothing usable. Before extraction, common boilerplate (infoboxes, navboxes, sidebars, reference markers, tables of contents, edit-section links, `<nav>`/`<aside>`) is stripped from the page, and the remaining HTML is converted to text block-by-block (a newline after each paragraph/heading/list item/table row, a space between table cells) so text never gets glued together across cells or blocks the way plain `textContent` would. The excerpt picks the first real paragraph (≥ 80 characters with sentence punctuation) rather than whatever text happens to come first in the markup, such as an infobox. PDFs and images are recorded with a filename-derived title (no OCR, no rendering). YouTube/Vimeo get an oEmbed title with no API key required. A link saved before this extraction logic improved can be fixed up in place with **refetch_link** / `POST /api/links/:id/refetch` (or the "Reintentar descarga" button in the reader) — it re-runs the current extraction code against the same URL and overwrites the stored title, excerpt and text.
- Search: FTS5 when the runtime's SQLite build supports it (verified at every startup); otherwise a `LIKE` fallback across the same fields, both reported in `GET /api/state`.

## Verification

```sh
npm test
npm run build
```

Tests use temporary data directories and a local HTTP server for fixtures — nothing touches your real data or the network. A fake hub (`tests/fake-hub.js`) stands in for the family hub: it records the events and answers the proxied `cards_add`. Downloads are tested with small fake yt-dlp, gallery-dl and ffmpeg scripts (`tests/media-fakes.js`, selected with `LINKS_YTDLP=node:<script>`), so no real site or binary is needed. They cover URL normalization (and the one-time re-keying of an older library), the shared page fetcher (charset, PDFs and images, challenge pages, the byte cap, the address check), watches (ETag, blocked pages, the hub path, a silent baseline after an upgrade), the family media service (sections, limits, `media_info`, `media_subtitles`, `media_audio_for_asr`, private addresses), the real entry point (restart keeps the token, SIGTERM exits 0), Readability extraction against an HTML fixture, save idempotency, full-text search, the digest, highlights, bookmarks/URL-list import parsing, agent token auth, a full API round-trip, and for the family: highlights to cards (once each, `source_ref`, older Hypatia, hub down, chunks of 50), the `links.highlight.added` event, the "Para leer hoy" picks (ranking, cooldown, one list per day) and its daily digest, the canonical job events; and for downloads: platform detection, arguments per format and quality, progress parsing, the queue (order, cancel of a waiting and of the running download with its process tree), the gallery-dl fallback, cookies from browsers, the fallback players for the bot check, the sign-in window driven through a fake browser (`tests/fake-browser.js`: saving, closing by hand, a new profile's first window quitting, signing out), the saved link with its note, no overwriting, file streaming with Range, the REST routes and the MCP tools.

Design and decisions: [`DESIGN.md`](DESIGN.md).
