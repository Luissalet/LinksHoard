# Links Hoard

## App Dock

When opened beside a Faustus chat, this page registers `links_open`, `links_filter`, `links_view` through `window.HoardApp`. These tools resolve records by id or unique name, apply the app's filters and switch sections. Ambiguous names return candidates. The current reading section and the selected or open link are reported. Text, tag and site filters use the normal saved-link lists.

`dock/changed` refreshes the mounted views without a page reload. Existing pending form fields are retained by the app's refresh handlers. The standalone interface continues to use its normal routes and controls. The Dock tools are exposed through the host's `app_view` and `app_act`; the existing backend tool catalogue is unchanged.

## Plegar and bilingual reading

Faustus reads a long saved text (web page, PDF, DOCX, EPUB, arXiv paper) level by level instead of all at once: `fold_link` writes the generated levels once with the Sparks model through the Hub (key idea per section, one line per section, theme map) and reports what each level costs in tokens; `fold_read` returns one level, 5 to 1, for the whole text or one section, as markdown with `[¶n]` paragraph marks. Levels 1-2 are literal and need no model; 3-5 are generated and say so. `translate_link` returns paragraphs with their stored translation into a chosen language, translating the missing ones. Details in [docs/FOLD.md](docs/FOLD.md).

## Photo posts and post reading

`video_digest` also takes a carousel of photos (Instagram, X, Threads): it collects the pictures (the post's own listing, or the originals through gallery-dl with the saved session), reads each one (caption, OCR, a description by the Sparks vision model) and returns the same layered dossier, one chapter per photo, with the photo the link opened (`?img_index=7`) marked. `video_digest_read` cuts by photo numbers, `video_frame` returns one photo by number (no number: the opened one), `video_find` names the photo of a hit and `video_ask` cites the caption (`p0`) and each photo's text (`v3`). The speech service is started through the Hub by starting Talos's Hoard, which holds Funes, and waited for.

`read_post` tries the Chromium profile of Links, then gallery-dl with the saved session, then Camoufox when `media_tools` reports it installed (a Firefox without automation traces, one persistent profile per site under `sessions/camoufox`, fed the saved session's cookies); `via` in the answer says which one read the post.
