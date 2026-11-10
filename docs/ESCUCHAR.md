# Escuchar: a saved link read aloud

Ask Faustus: «léeme este artículo», «ponme en la cola los tres últimos que guardé» or «¿por dónde iba en el de la curva del olvido?».

## What is read

- An article: its title, its byline and the extracted text, cleaned for a voice (no URLs, markdown marks, list bullets, code blocks or reference marks such as `[12]`).
- A video link whose digest is `done` or `partial`: the digest's summary, its key points and each chapter (title and summary; a chapter without a summary reads how it starts). The page text is not read in that case.
- Nothing else: a link whose fetch is pending, or that has under 80 characters of text and no digest, answers 409 with the reason.

## How it is made

Links calls Prospero's Hoard through the hub: `voice_audiobook` (Piper, MP3) queues the narration, `voice_job` is followed until it ends, and the final file and its sentence timings are fetched from Prospero (`/api/voice/audiobook/<job>/download`) into `data/listen/<link id>/audio.mp3` and `lines.json`. If Prospero is not running the hub is asked to start it; if its generation module is off it is turned on; if Prospero forgets the job (a restart) the narration is requested again, up to three times, and Prospero resumes from the chapters it already rendered. A narration left unfinished when Links stops is followed again at the next start. The text and the voice are hashed: the same pair is never narrated twice, and `stale: true` says the text changed since.

## REST

| Route | What it does |
| --- | --- |
| `GET /api/links/:id/listen` | The audio of a link: `status` (`none`, `queued`, `running`, `done`, `failed`), `progress`, `detail`, `error`, `source` (`article`, `video_digest`), `voice`, `chars`, and when done `duration_s`, `bytes`, `file`, `audio_url`, `chapters`, `position_s`, `percent`, `finished`, `played_at`, `stale`, `queued`, `queue_pos`. |
| `POST /api/links/:id/listen` | Start or reuse it: `{voice?, regenerate?, queue?}`. Answers at once with the view and `existing`. |
| `DELETE /api/links/:id/listen` | Delete the audio, its resume point and its place in the queue. The link stays. |
| `POST /api/links/:id/listen/position` | `{position_s, finished?}`. Reaching the last 1.5 s, or `finished: true`, marks it heard: position 0, out of the queue, link marked read. |
| `GET /api/links/:id/listen/audio` | The MP3, with byte ranges. |
| `GET /api/links/:id/listen/lines` | `[{start_s, end_s, text}]`, one per narrated sentence. |
| `GET /api/listen` | `{queue, library, settings}`: the queue in order, every link with audio (newest first) and the voice setting. |
| `POST /api/listen/queue` | `{id, position?}`: add (or move to a 1-based position). Starts the narration when the link has no audio. |
| `POST /api/listen/queue/order` | `{ids}`: reorder; ids not listed keep their order after the listed ones. |
| `DELETE /api/listen/queue/:id`, `DELETE /api/listen/queue` | Take one out (its audio stays), or empty the queue. |
| `POST /api/listen/settings` | `{voice}`: the default voice; empty goes back to the voice of the link's language. |

## MCP

- `listen_link {id | url, voice?, regenerate?, queue?, wait_s?}`: start or reuse; `wait_s` (up to 150) waits for it. While it runs the answer says so: do not report it as ready until `status` is `done`.
- `listen_status {id | url, wait_s?}`: one link; without a link, `{queue, library, settings}`.
- `listen_position {id | url, position_s, finished?}`.
- `listen_queue {action: list | add | remove | move | clear, id | url, position?}`.
- `listen_delete {id | url}`.

## Limits

- One voice per audio; there is no casting of several voices by speaker or quotation.
- Narration is Piper on the CPU through Prospero: a 500-word article takes well under a minute on an idle machine and longer when the machine is busy. Texts over 1.5 million characters are refused.
- The resume point is kept per link, not per device or per person.
- The queue chains in the page that is open: closing the tab stops it (the position is saved).
- A video without a digest is not transcribed here just to be listened to: digest it first.
- Languages other than Spanish and English use the Spanish default voice unless a voice is set.
