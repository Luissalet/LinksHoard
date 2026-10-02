// Tools exposed to the assistant. One list drives /api/agent/call and the
// MCP bridge (server/mcp.js). Descriptions end with a "Sinónimos:" line of
// Spanish words for the client's tool index.
import { SINCE_HELP } from "./since.js";
import { z } from "zod";
import * as links from "./links.js";
import * as highlights from "./highlights.js";
import { enqueueFetch, waitForFetch } from "./fetcher.js";
import { importTranscript } from "./transcript.js";
import * as watches from "./watches.js";
import * as media from "./media.js";
import { highlightsToCards, DEFAULT_DECK } from "./cards.js";
import { resurface, resurfaceSettings } from "./resurface.js";

export const AGENT_INSTRUCTIONS = `Links Hoard is the user's read-it-later library: saved pages with extracted text, tags and highlights.
Summarize or quote a link only from the text read_link returns, never from the title or URL alone — the title can be misleading and the page may not be fetched yet.
save_link is idempotent on the normalized URL: calling it twice for the same page returns the existing link (existing: true) instead of duplicating it.
save_link waits briefly for the background fetch so it can report the real title and excerpt; if fetch_status comes back "pending" or "failed", say so plainly instead of inventing a summary — offer refetch_link or suggest the user opens the page.
Prefer list_links or search_links before read_link when you are not sure which link the user means.
For a saved YouTube video whose read_link text is empty or only metadata, import_video_transcript obtains available captions, then read_link can quote and summarize them.
Favorite is a dedicated boolean state, not a tag: use mark_link with state "favorite". tag_link only changes labels, even if a label is named "favorita".
Dates are ISO ("YYYY-MM-DD" or full ISO timestamps). link_digest groups what was saved since a date by site, for a weekly recap.
delete_link is irreversible: confirm with the user before calling it.
highlights_to_cards turns the user's highlights into Hypatia flashcards (deck "Lecturas") through the hub; report the status it returns, and say plainly when the hub or Hypatia is not there. resurface answers "what should I read today": quote the title, site and reason of each item and open nothing without being asked.
Watches bring things in: watch_add follows an RSS/Atom feed, a GitHub repository (releases, tags or commits) or a page (text changes); every new entry becomes a watch item and, with auto_save, a saved link. watch_items lists what arrived (unread first); watch_check polls now instead of waiting for the schedule.
When the user asks to download a link ("descárgame esto", "bájame este vídeo", "sácame el audio", "pásalo a mp3", a reel, a tweet, a photo carousel), call media_download — not save_link, which only bookmarks the page. format auto downloads the video and falls back to the photos of a post that has no video; audio gives an MP3; image forces photos. By default it waits for the file and returns its absolute path and size: report that exact path to the user, and never say a download worked unless the result has ok: true and at least one file. If it comes back still running (status downloading), follow it with media_status; if it failed, tell the user the error in plain words and offer media_retry. media_probe shows what a link holds (title, duration, available heights, playlist or photo post) without downloading. media_tools shows whether yt-dlp, gallery-dl and ffmpeg are installed and can update them. media_cancel stops a download; media_delete removes the record, and its files only with delete_files plus confirm: true after the user agreed.`;

const fail = (message, extra = {}) => { throw Object.assign(new Error(message), { status: 400, ...extra }); };

function resolveLinkOrFail({ id, url }) {
  if (id) {
    const link = links.getLink(id);
    if (link) return link;
    fail(`No existe un enlace con id "${id}".`);
  }
  if (url) {
    const link = links.getLinkByUrl(url);
    if (link) return link;
    fail(`No tienes guardada esa URL. Usa save_link primero.`);
  }
  fail("Indica id o url.");
}

const present = (link) => ({
  id: link.id,
  url: link.url,
  title: link.title,
  site: link.site,
  excerpt: link.excerpt,
  byline: link.byline,
  kind: link.kind,
  saved_at: link.saved_at,
  read_at: link.read_at,
  archived: link.archived,
  favorite: link.favorite,
  tags: link.tags,
  notes: link.notes,
  fetch_status: link.fetch_status,
  fetch_error: link.fetch_error || undefined,
  word_count: link.word_count,
});

const tool = (name, description, schema, hints, run) => ({
  name,
  description,
  schema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...hints },
  run,
});
const RO = { readOnlyHint: true, idempotentHint: true };

/** What the assistant sees of a download: the facts it must report, with absolute paths. */
function agentView(row, { started = false, existing, detail = false } = {}) {
  const files = (row.files || []).map((f) => ({ path: f.path, name: f.name, size: f.size, kind: f.kind }));
  const active = media.ACTIVE_STATUSES.includes(row.status);
  const out = {
    id: row.id,
    ok: row.status === "done" && files.length > 0,
    status: row.status,
    platform: row.platform,
    format: row.format,
    kind: row.kind || undefined,
    title: row.title || undefined,
    uploader: row.uploader || undefined,
    dir: row.dir,
    files,
    total_bytes: row.total_bytes || undefined,
    link_id: row.link_id || undefined,
    ...(active ? { progress: row.progress, speed: row.speed || undefined, eta: row.eta || undefined, detail: row.detail || undefined } : {}),
    ...(row.status === "failed" || row.status === "cancelled" ? { error: row.error } : {}),
    ...(row.status === "done" && row.detail ? { note: row.detail } : {}),
    ...(existing ? { existing: true } : {}),
  };
  if (detail) Object.assign(out, { url: row.url, upload_date: row.upload_date || undefined, duration: row.duration || undefined, description: row.description ? row.description.slice(0, 1000) : undefined, created_at: row.created_at, finished_at: row.finished_at || undefined });
  if (started || active) out.message = active ? "Sigue en curso: consulta media_status con este id; no digas que está descargado hasta que ok sea true." : undefined;
  if (row.status === "done" && !files.length) out.message = "Terminó pero no hay archivos en el resultado: no lo des por descargado.";
  return out;
}


export const TOOLS = [
  tool("save_link",
    "Save a URL to the read-later library (idempotent; waits for the fetch).\nSave a URL to the read-later library. Idempotent on the normalized URL (strips tracking params and trailing slash): saving an already-saved page returns it unchanged with existing: true. Waits up to 10s for the background fetch so it can return the real title, site and excerpt; if the fetch is still pending or failed, that is reported instead of guessed.\nSinónimos: guarda esto, guardar enlace, para luego, guarda este artículo, marcador, guardar página",
    z.object({
      url: z.string().trim().min(1).describe("The URL to save"),
      tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
      note: z.string().trim().max(5000).default(""),
    }), { idempotentHint: true },
    async ({ url, tags, note }) => {
      const { link, existing } = links.createLink({ url, tags, note, source: "agent" });
      if (!existing) enqueueFetch(link.id, link.url);
      await waitForFetch(link.id, 10_000);
      return { ...present(links.getLink(link.id)), existing };
    }),

  tool("list_links",
    "List saved links by state, tag, site or date.\nList saved links, most recent first. state: unread (default), read, archived or all. Optional tag, site and since (an ISO date, an age like 7d or hace 2 horas, or hoy/ayer/esta semana). Paginated (limit up to 100).\nSinónimos: enlaces, lo que guardé, bandeja, qué tengo guardado, lista de lecturas, pendientes de leer",
    z.object({
      state: z.enum(["unread", "read", "archived", "all"]).default("unread"),
      tag: z.string().max(40).optional(),
      site: z.string().max(200).optional(),
      since: z.string().max(40).optional().describe(SINCE_HELP),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.number().int().min(0).default(0).describe("Offset for paging; use next_cursor from the previous call"),
    }), RO,
    (a) => {
      const out = links.listLinks({ state: a.state, tag: a.tag, site: a.site, since: a.since, limit: a.limit, cursor: a.cursor });
      return { total: out.total, items: out.items.map(present), next_cursor: out.nextCursor };
    }),

  tool("search_links",
    "Full-text search over saved links.\nFull-text search over title, description, extracted content, notes and tags. Returns the same shape as list_links.\nSinónimos: buscar enlace, encontrar artículo, buscar en lo guardado, dónde leí, busca esto",
    z.object({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).default(30) }), RO,
    ({ q, limit }) => {
      const out = links.listLinks({ state: "all", q, limit });
      return { total: out.total, items: out.items.map(present), fts_enabled: out.ftsEnabled };
    }),

  tool("read_link",
    "Read a saved link's extracted text, paginated; summarize only from it.\nRead a saved link's extracted text, paginated by characters (max_chars, default 4000; offset to page further). Identify by id or url. Returns title, byline, site, the text slice, whether more remains, and highlights. Summarize only from this text, never from the title alone.\nSinónimos: leer artículo, texto del enlace, qué dice, contenido del artículo, léeme esto",
    z.object({
      id: z.string().optional(),
      url: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(200).max(20000).default(4000),
    }), RO,
    (a) => {
      const link = resolveLinkOrFail(a);
      const text = link.content_text || "";
      const slice = text.slice(a.offset, a.offset + a.max_chars);
      return {
        id: link.id,
        url: link.url,
        title: link.title,
        byline: link.byline,
        site: link.site,
        kind: link.kind,
        fetch_status: link.fetch_status,
        fetch_error: link.fetch_error || undefined,
        text: slice,
        offset: a.offset,
        total_chars: text.length,
        has_more: a.offset + slice.length < text.length,
        highlights: highlights.listHighlights(link.id),
      };
    }),

  tool("tag_link",
    "Add or remove labels only; this does not mark a link as favorite.\nUse id or url. Unlisted tags are left untouched. A tag named favorita is still just a label; use mark_link with state favorite to change actual favorite status.\nSinónimos: etiquetar, poner etiqueta, quitar etiqueta, clasificar enlace",
    z.object({
      id: z.string().optional(),
      url: z.string().optional(),
      add: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
      remove: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
    }), { idempotentHint: true },
    (a) => {
      const link = resolveLinkOrFail(a);
      const set = new Set(link.tags);
      for (const t of a.add) set.add(t);
      for (const t of a.remove) set.delete(t);
      const updated = links.updateLink(link.id, { tags: [...set] });
      return { ...present(updated), state_hint: "Only tags changed. To set actual favorite status, use mark_link with state favorite." };
    }),

  tool("mark_link",
    "Set actual read, archive or favorite status (not a tag).\nSet state to read, unread, archived or favorite; on/off toggles it (default true). To mark a link as favorite, use this tool with state favorite, not tag_link.\nSinónimos: marcar leído, marcar como leído, archivar, marcar favorito, destacar, marcar sin leer",
    z.object({
      id: z.string().optional(),
      url: z.string().optional(),
      state: z.enum(["read", "unread", "archived", "favorite"]),
      on: z.boolean().default(true),
    }), { idempotentHint: true },
    (a) => {
      const link = resolveLinkOrFail(a);
      if (a.state === "read") return present(links.markRead(link.id, a.on));
      if (a.state === "unread") return present(links.markRead(link.id, !a.on));
      if (a.state === "archived") return present(links.setArchived(link.id, a.on));
      return present(links.setFavorite(link.id, a.on));
    }),

  tool("add_highlight",
    "Save a verbatim quote from read_link, with an optional note. Identify the link by id or url.\nThe quote must appear in the extracted article text; read_link first. If extraction is pending or failed, do not invent a quote.\nSinónimos: subrayar, destacar texto, guardar cita, anotar frase",
    z.object({ id: z.string().optional(), url: z.string().optional(), text: z.string().trim().min(1).max(5000), note: z.string().trim().max(2000).default("") }), { idempotentHint: true },
    (a) => {
      const link = resolveLinkOrFail(a);
      const source = (link.content_text || "").replace(/\s+/gu, " ").trim();
      if (!source) fail("No hay texto extraído para citar. Espera a la descarga o usa refetch_link.");
      if (!source.includes(a.text.replace(/\s+/gu, " ").trim())) {
        fail("La cita no aparece en el texto extraído. Usa read_link y copia un fragmento literal.");
      }
      const previous = highlights.listHighlights(link.id).find((h) => h.text === a.text && h.note === a.note);
      if (previous) return { ...previous, existing: true };
      return { ...highlights.addHighlight(link.id, { text: a.text, note: a.note }), existing: false };
    }),

  tool("import_video_transcript",
    "Import subtitles of a saved YouTube video into searchable text.\nDownloads available Spanish or English captions, not the video, and makes them available to read_link, search_links and highlights. Requires Python yt-dlp; reports when captions are unavailable. Identify the saved video by id or url.\nSinónimos: transcribir vídeo, leer subtítulos, importar transcripción, resumir vídeo de YouTube",
    z.object({ id: z.string().optional(), url: z.string().optional() }), { idempotentHint: true, openWorldHint: true },
    (a) => importTranscript(resolveLinkOrFail(a))),

  tool("link_digest",
    "Links saved since a date or an age (\"7d\", \"esta semana\"), with excerpts, grouped by site. Weekly recap.\nSinónimos: resumen de la semana, qué guardé esta semana, digest, novedades guardadas",
    z.object({ since: z.string().trim().max(40).default("7d").describe(SINCE_HELP) }), RO,
    ({ since }) => {
      const out = links.digestSince(since);
      return {
        since: out.since,
        total: out.total,
        sites: out.sites.map((s) => ({ site: s.site, count: s.count, links: s.links.map(present) })),
      };
    }),

  tool("refetch_link",
    "Re-download and re-extract a saved link's page.\nRe-download and re-extract a saved link's page (id or url). Use when fetch_status is failed or the page changed.\nSinónimos: reintentar descarga, actualizar artículo, volver a leer, refrescar enlace",
    z.object({ id: z.string().optional(), url: z.string().optional() }), { idempotentHint: true },
    async (a) => {
      const link = resolveLinkOrFail(a);
      links.markFetchPending(link.id);
      enqueueFetch(link.id, link.url);
      await waitForFetch(link.id, 10_000);
      return present(links.getLink(link.id));
    }),

  tool("delete_link",
    "Permanently delete a saved link and its highlights (id or url). Irreversible; confirm with the user first.\nSinónimos: borrar enlace, eliminar artículo, quitar de la lista",
    z.object({ id: z.string().optional(), url: z.string().optional() }), { destructiveHint: true, idempotentHint: true },
    (a) => {
      const link = resolveLinkOrFail(a);
      links.deleteLink(link.id);
      return { deleted: present(link) };
    }),

  tool("watch_add",
    "Follow a feed, a GitHub repository or a page for new things.\nFollow a URL for new things: an RSS/Atom feed, a GitHub repository (releases by default; github: tags|commits) or a plain page (text changes). Auto-detects the kind (a page that advertises a feed becomes a feed watch). Checked every every_min minutes (default 60); new entries become watch items and, with auto_save (default), saved links with the given tags. The first check is a baseline: existing entries are not 'new'.\nSinónimos: sigue este feed, avísame cuando, vigilar página, suscribirme, nuevas releases, cuando cambie, seguir repositorio",
    z.object({
      url: z.string().trim().min(1).describe("Feed, GitHub repository or page URL"),
      kind: z.enum(["auto", "feed", "github", "page"]).default("auto"),
      name: z.string().trim().max(200).default(""),
      every_min: z.number().int().min(5).max(10080).default(60),
      tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
      auto_save: z.boolean().default(true),
      github: z.enum(["releases", "tags", "commits"]).default("releases"),
    }), { idempotentHint: true },
    async (a) => {
      const out = await watches.addWatch(a);
      return { ...out.watch, existing: out.existing, baseline_items: out.first_check ? out.first_check.watch.item_count : undefined,
               first_check_error: out.first_check && !out.first_check.ok ? out.first_check.error : undefined };
    }),

  tool("watch_list",
    "List the watches with last check, error and item count.\nList the watches (feeds, GitHub repositories, pages) with kind, interval, last check, last error and item count.\nSinónimos: qué sigo, mis feeds, vigilancias, suscripciones, qué estoy siguiendo",
    z.object({}), RO,
    () => ({ watches: watches.listWatches(), stats: watches.stats() })),

  tool("watch_items",
    "What the watches brought in: entries, releases, changes.\nWhat the watches brought in: new feed entries, releases and page changes, newest first. unread (default true) hides dismissed items; since is an ISO date; watch_id narrows to one watch. Each item has title, url, summary, published_at and the saved link_id when auto_save applied.\nSinónimos: novedades, qué hay nuevo, qué ha salido, últimas releases, cambios, lo que llegó",
    z.object({
      watch_id: z.string().optional(),
      since: z.string().optional(),
      unread: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(30),
    }), RO,
    (a) => ({ items: watches.listItems({ watch_id: a.watch_id || null, since: a.since || null, unread: a.unread, limit: a.limit }) })),

  tool("watch_check",
    "Check a watch now (or every due one) and return what was new.\nCheck a watch now (or every due watch when watch_id is omitted) instead of waiting for its schedule; returns what was new.\nSinónimos: comprueba ahora, actualiza el feed, mira si hay algo nuevo, refrescar vigilancias",
    z.object({ watch_id: z.string().optional() }), { idempotentHint: true },
    async (a) => {
      if (a.watch_id) return await watches.checkWatch(a.watch_id);
      return { results: await watches.checkDue() };
    }),

  tool("watch_dismiss",
    "Mark a watch item as seen (or unseen with dismissed=false) so it leaves the unread list.\nSinónimos: visto, descartar novedad, marcar como leído, ya lo vi",
    z.object({ item_id: z.string(), dismissed: z.boolean().default(true) }), { idempotentHint: true },
    (a) => watches.dismissItem(a.item_id, a.dismissed)),

  tool("watch_remove",
    "Stop following a watch (its items stay; saved links stay). Confirm with the user first.\nSinónimos: deja de seguir, quitar feed, cancelar suscripción, dejar de vigilar",
    z.object({ watch_id: z.string() }), { destructiveHint: true },
    (a) => ({ ok: true, removed: watches.removeWatch(a.watch_id) })),

  tool("highlights_to_cards",
    "Turn saved highlights into Hypatia flashcards — subrayados a tarjetas, enviar a Hypatia\nSends the highlights (of link_id or url, or every one saved since a date; default: all that have not gone yet) to Hypatia through the hub as flashcards in the deck \"Lecturas\" (deck overrides it): front = the highlighted text, back = your note and the article title, source_ref = hoard://links/highlight/<id>. Each highlight goes once (resend: true sends again; Hypatia does not duplicate a card). Returns ok, status (ok, nothing_new, hub_down, hypatia_unavailable, hypatia_error, unknown_link), sent and skipped; never claims cards were made when status is not ok.\nSinónimos: pasar subrayados a tarjetas, flashcards de lo que leí, estudiar mis subrayados, mandar a Hypatia, tarjetas de lecturas, repasar lo subrayado",
    z.object({
      link_id: z.string().optional(),
      url: z.string().optional(),
      since: z.string().optional().describe(SINCE_HELP),
      deck: z.string().trim().min(1).max(120).default(DEFAULT_DECK),
      resend: z.boolean().default(false),
    }), { idempotentHint: true },
    (a) => highlightsToCards(a)),

  tool("resurface",
    "What to read today from the saved-but-unread — para leer hoy, rescata enlaces\nPicks count links (default 3) worth reading now: unread for a while (older first), favourites, ones with highlights and topics the user reads weigh more; a read link with highlights comes back for a re-read after two weeks. Never the same link twice within 14 days (30 for a re-read). The list is the same all day and changes tomorrow; each item says why (reason).\nSinónimos: qué leo hoy, algo para leer, rescatar enlaces, lecturas pendientes, qué tengo sin leer, recomiéndame un artículo",
    z.object({ count: z.number().int().min(1).max(10).optional() }), { idempotentHint: true },
    (a) => resurface(a.count ?? resurfaceSettings().count)),

  tool("list_tags",
    "List every tag in use (excluding archived links) with counts, most used first.\nSinónimos: etiquetas, qué etiquetas tengo, lista de etiquetas",
    z.object({}), RO,
    () => ({ tags: links.listTags() })),
  tool("media_download",
    "Download a video, audio or photos from a link (YouTube, X, Instagram, TikTok…) — descargar, bájame\nDownloads the media behind a URL to disk with yt-dlp (video as H.264/AAC MP4, or audio as MP3) and gallery-dl (photo posts and carousels). format: auto (default: video, or the photos when the post has no video), video, audio or image. quality for video: best, 1080, 720, 480. Saves into the configured downloads folder (dir overrides it) and, with save_link (default true), also saves the URL to the library with the tag descarga and the caption. Waits up to timeout_s (default 150, under the assistant's 180 s call limit) and returns ok, status and the files with absolute path and size; if it is still running it returns the id so media_status can follow it. Never claim success unless ok is true and files is not empty.\nSinónimos: descárgame esto, descarga este vídeo, bájame, bájate, guarda el vídeo, sácame el audio, pásalo a mp3, descargar de YouTube, descargar reel, descargar tweet, bajar música, descargar fotos de Instagram, guardar el vídeo en el disco",
    z.object({
      url: z.string().trim().min(1).describe("Link to the video, audio or post"),
      format: z.enum(media.FORMATS).default("auto"),
      quality: z.union([z.enum(media.QUALITIES), z.number().int().min(144).max(4320)]).default("best").describe("Maximum video height: best, 1080, 720, 480…"),
      dir: z.string().trim().max(1000).optional().describe("Absolute folder to save into (default: the configured downloads folder)"),
      save_link: z.boolean().default(true).describe("Also save the URL in the library (tag descarga)"),
      playlist: z.boolean().default(false).describe("Download a whole playlist (up to max_items) instead of the single video"),
      max_items: z.number().int().min(1).max(500).default(media.DEFAULT_MAX_ITEMS),
      cookies_browser: z.string().trim().max(60).optional().describe("Browser whose login cookies to use (firefox, chrome, edge, brave…); default tries without, then each browser"),
      wait: z.boolean().default(true).describe("Wait for the download to finish"),
      timeout_s: z.number().int().min(5).max(3600).default(150).describe("Seconds to wait; past it the download keeps running and media_status follows it"),
    }), { openWorldHint: true },
    async (a) => {
      const started = media.startDownload({
        url: a.url, format: a.format, quality: String(a.quality), dir: a.dir, save_link: a.save_link,
        playlist: a.playlist, max_items: a.max_items, cookies_browser: a.cookies_browser || "auto",
      });
      if (!a.wait) return agentView(started, { started: true, existing: started.existing });
      const done = await media.waitForDownload(started.id, a.timeout_s * 1000);
      return agentView(done, { existing: started.existing });
    }),

  tool("media_status",
    "Progress and result of media downloads — estado de las descargas, cómo va la descarga\nWith id: that download's status, progress, speed, eta and, when done, its files (absolute paths); wait_s (up to 150) blocks until it finishes or the time runs out. Without id: the most recent downloads (status filter: queued, downloading, processing, done, failed, cancelled, active or finished).\nSinónimos: cómo va la descarga, estado de la descarga, qué he descargado, descargas en curso, dónde se guardó, lista de descargas, ruta del archivo descargado",
    z.object({
      id: z.string().optional(),
      status: z.string().max(20).optional(),
      limit: z.number().int().min(1).max(100).default(10),
      wait_s: z.number().int().min(0).max(150).default(0).describe("With id: wait up to this many seconds for the download to finish"),
    }), RO,
    async (a) => {
      if (a.id) {
        if (a.wait_s > 0 && media.getDownload(a.id)) await media.waitForDownload(a.id, a.wait_s * 1000);
        const row = media.getDownload(a.id);
        if (!row) fail(`No existe una descarga con id "${a.id}".`);
        return agentView(row, { detail: true });
      }
      const out = media.listDownloads({ status: a.status, limit: a.limit });
      return { total: out.total, items: out.items.map((r) => agentView(r)) };
    }),

  tool("media_cancel",
    "Cancel a queued or running media download — cancelar descarga, parar la descarga\nA waiting download is removed from the queue; the running one is stopped and its whole process tree killed. Partial files are cleaned up.\nSinónimos: cancela la descarga, para la descarga, detén la descarga, no la descargues, abortar descarga",
    z.object({ id: z.string() }), { idempotentHint: true },
    (a) => agentView(media.cancelDownload(a.id))),

  tool("media_retry",
    "Retry a failed or cancelled media download — reintentar descarga, volver a descargar\nPuts the same download back in the queue (same url, format, quality and folder) and, with wait (default true), waits for the result like media_download.\nSinónimos: reintenta la descarga, vuelve a descargarlo, inténtalo otra vez, descargar de nuevo",
    z.object({ id: z.string(), wait: z.boolean().default(true), timeout_s: z.number().int().min(5).max(3600).default(150) }), { openWorldHint: true },
    async (a) => {
      const row = media.retryDownload(a.id);
      if (!a.wait) return agentView(row);
      return agentView(await media.waitForDownload(row.id, a.timeout_s * 1000));
    }),

  tool("media_probe",
    "Inspect a link before downloading (title, duration, qualities) — comprobar enlace, ver formatos\nAsks yt-dlp (or gallery-dl for photo posts) what is behind a URL without downloading: title, uploader, duration, available video heights, whether it is a playlist or a photo post. Needs the network.\nSinónimos: qué hay en este enlace, es un vídeo o fotos, qué calidades tiene, cuánto dura, ver información del vídeo, comprobar si se puede descargar",
    z.object({
      url: z.string().trim().min(1),
      playlist: z.boolean().default(false),
      cookies_browser: z.string().trim().max(60).optional(),
    }), { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    (a) => media.probeUrl({ url: a.url, playlist: a.playlist, cookies_browser: a.cookies_browser || "auto" })),

  tool("media_tools",
    "Show or update yt-dlp, gallery-dl and ffmpeg — herramientas de descarga, actualizar yt-dlp\nReports which of yt-dlp, gallery-dl and ffmpeg were found (path, version and how: env, PATH, sibling app folder, python module), the downloads folder and the install command when something is missing. update: true runs the updaters (yt-dlp -U or pip install -U) and returns the versions before and after.\nSinónimos: tengo yt-dlp, está instalado ffmpeg, actualizar yt-dlp, por qué no descarga, instalar el descargador, versión de yt-dlp, herramientas de descarga",
    z.object({ update: z.boolean().default(false), tools: z.array(z.enum(["ytdlp", "gallerydl"])).optional() }), { openWorldHint: true },
    async (a) => {
      const update = a.update ? await media.updateTools(a.tools?.length ? { tools: a.tools } : {}) : undefined;
      const status = await media.toolsStatus({ refresh: !!a.update });
      return { ...status, settings: media.getMediaSettings(), ...(update ? { update: update.results } : {}) };
    }),

  tool("media_delete",
    "Remove a download record, optionally its files — borrar descarga, quitar archivo descargado\nRemoves the record from the downloads list. With delete_files: true AND confirm: true it also deletes the downloaded files from the disk (permanent, there is no recycle bin): confirm with the user first. A running download must be cancelled first.\nSinónimos: borra la descarga, elimina el archivo descargado, quita de la lista de descargas, borrar el vídeo descargado",
    z.object({ id: z.string(), delete_files: z.boolean().default(false), confirm: z.boolean().default(false) }), { destructiveHint: true },
    (a) => {
      if (a.delete_files && !a.confirm) fail("Borrar los archivos es permanente: confirma con el usuario y vuelve a llamar con confirm: true.");
      return media.removeDownload(a.id, { deleteFiles: a.delete_files });
    }),
];

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

export async function callTool(name, args) {
  const t = findTool(name);
  if (!t) throw Object.assign(new Error("Herramienta desconocida."), { status: 404 });
  return await t.run(t.schema.parse(args || {}));
}
