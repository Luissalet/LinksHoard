# Video digest

Spanish summary below.

An assistant that "watches" a video by looking at frames pays for every picture: one 1280×720 frame is ~1,200 tokens, so an hour at one frame every 5 s is ~860k tokens, and it still misses what is said. The video digest does the watching on your own machine, where tokens cost nothing, and leaves a **layered text dossier** that an assistant reads for a few thousand tokens, pulling more only where it needs it.

## What it produces

For a link (a post on X with a video, YouTube, a reel, any yt-dlp site, or a local file given as `path`), under `<data>/video/<link id>/digest/`:

| File | What | Typical size |
| --- | --- | --- |
| `card.md` | Source, author, date, duration, the post text (literal), the summary, key points and the answer to your focus (generated), warnings, and what each other layer costs | 300–900 tokens |
| `index.md` | One block per chapter: time span, title and summary (generated), what is on screen (OCR excerpt, description) and which frame shows it | ~150–250 tokens per chapter |
| `visual.md` | Every visual segment of the whole video: span, kind, description (generated), the **literal screen text** (OCR), the frame file; a slide shown again is marked as a repeat | depends on the screen text |
| `transcript.md` | The literal transcript in timed paragraphs | ~200 tokens per spoken minute |
| `digest.md` | All of the above | |
| `overview.jpg`, `sheet-NN.jpg` | A 4×4 mosaic of frames with `v12 3:45` printed on each (all segments in order in the numbered sheets) | ~1,500 tokens each |
| `frames/vNNN.jpg` | One sharp frame per distinct segment (1280 px on the long edge) | ~1,200 tokens each |
| `digest.json` | The structured model behind the layers | |

Read **brief** (card + index) first. Literal material (transcript, OCR, post text) and generated material (titles, summaries, descriptions, marked *(generado · model)*) are never mixed: check a generated claim against its timestamp before stating it.

## How it is made

1. **Video and transcript**: the video insight job (see the README) downloads the video with the app's yt-dlp at 720p (readable screen text; the browser's cookies are tried for posts that need them) and transcribes it through the family speech-to-text service (Funes, started through the Hub when it is down) or faster-whisper.
2. **Visual pass over the whole video**: 64×36 grey thumbnails every 0.5 s (≤10 min), 1 s (≤1 h) or 2 s; a new segment starts when the picture drifts away from the segment's first frame (mean difference > 7.5 %); segments shorter than 2 s join their neighbour (a montage of fast cuts gives a few 2–4 s segments); at most 120 segments (the most alike neighbours are merged first); a segment that shows the same picture as an earlier one is a repeat and gets no frame of its own.
3. **Screen text**: OCR of every distinct frame through Kafka's Hoard (`ocr_image`, started through the Hub when needed) or a local Tesseract; lines without two letters or digits are dropped; text identical to the previous frame's is noted as "the same as vN".
4. **What the picture shows**: when the Hub serves a vision model, a one-or-two-sentence description, a kind (slide, code, chart, talking head…) and an "important" flag for frames the reader should actually look at; the longest 40 segments first. Without a vision model this layer is skipped and the card says so.
5. **Chapters**: cut near every 1/12 of the video (45 s – 5 min), preferring picture changes, then pauses, then sentence ends. The Hub's text model writes a title and summary per chapter, then the summary, key points and, with a `focus`, the answer to it and the chapters that matter (★ in the index).
6. **Files and search**: the layers above, the screen text in a full-text index next to the transcripts, an event `links.video.digest` on the family bus, and an optional copy to the export folder of the settings.

A digest is idempotent: asking again for the same video and focus returns it as it is; a new focus reuses the visual pass, OCR and descriptions and only redoes chapters and summary; `force` redoes everything but the download and transcript (`redo_media` too).

## After the digest

- `video_ask` / `POST /api/links/:id/digest/ask {question}`: the local model answers from the transcript and screen text; every sentence carries citations (`s12` speech, `v3` screen) with the time and a verbatim quote that the app checks; sentences whose quote is not in the source are dropped and counted.
- `video_find` / `GET /api/video-digests/search?q=&id=`: words in the transcripts and the screen text, with time and the lines around.
- `video_frame` / `GET /api/links/:id/digest/frame?t=3:45&width=1024` (`&json=1` for the path): the exact frame at any instant, with what it costs to look at it.
- `video_digest_read` / `GET /api/links/:id/digest?level=transcript&from=3:00&to=5:00`: one layer or one span.

## Interfaces

- App: **Vídeos** page (paste a link, optional focus, list of digests) and the **Digest para asistentes** panel of a saved link (state, token chips, mosaic, layers, copy, questions). Settings in **Ajustes → Digest de vídeos**.
- MCP: `video_digest`, `video_digest_read`, `video_ask`, `video_find`, `video_frame`, `video_digests`.
- REST: `POST /api/video-digests {url|id, path?, focus?, force?, redo_media?, language?}`, `GET /api/video-digests`, `GET /api/links/:id/digest[?level=&from=&to=]`, `POST /api/links/:id/digest`, `GET /api/links/:id/digest/files/<card.md|overview.jpg|frames/v001.jpg…>`, `GET|PUT /api/video-digests/settings`.
- Command line (from another machine through a shell, or a script): `node scripts/digest.mjs <url> [--focus "…"] [--level brief|card|index|visual|transcript|full]`, `--id <link> --ask "…"`, `--find "…"`, `--id <link> --frame 3:45`, `--list`, `--out file.md`. Progress on stderr, the text on stdout.

## Settings

`download_height` (720), `max_duration_s` (4 h), `fps` (0 = by duration), `diff_threshold` (0.075), `min_segment_s` (2), `max_visual` (120), `frame_width` (1280), `ocr` / `ocr_lang` (es), `vision` / `vision_max` (40), `llm`, `summary_lang` (es), `export_dir` (also `LINKS_DIGEST_EXPORT_DIR`).

## Limits

Needs ffmpeg. The summary and chapter titles need a text model served by the Hub (on a cold model the first answer can take minutes); descriptions need a vision model; without them the digest still has the transcript, the screen text, the chapters by time and the mosaic, and says what is missing. OCR quality depends on the resolution of the download. A video with burnt-in subtitles gets them through OCR as screen text.

---

## En español

El digest de vídeo hace en tu PC lo que a un asistente le costaría miles de tokens: descarga el vídeo (tweet, YouTube, reel o un archivo), lo transcribe, recorre la imagen entera, lee el texto en pantalla, agrupa en capítulos y resume con los modelos locales del Hub, y deja un dossier por capas (ficha, índice, pantalla, transcripción, mosaico, fotogramas). Lo literal (transcripción, OCR) y lo generado (marcado *(generado)*) van siempre separados. Después se le pregunta al vídeo con citas comprobadas (`video_ask`), se busca en él (`video_find`) o se saca el fotograma exacto de un instante (`video_frame`). En la app: página **Vídeos** y panel **Digest para asistentes** de cada enlace; ajustes en **Ajustes → Digest de vídeos**.
