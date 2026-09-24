// Tools exposed to the assistant. One list drives /api/agent/call and the
// MCP bridge (server/mcp.js). Descriptions end with a "Sinónimos:" line of
// Spanish words for the client's tool index.
import { z } from "zod";
import * as links from "./links.js";
import * as highlights from "./highlights.js";
import { enqueueFetch, waitForFetch } from "./fetcher.js";
import * as watches from "./watches.js";

export const AGENT_INSTRUCTIONS = `Links Hoard is the user's read-it-later library: saved pages with extracted text, tags and highlights.
Summarize or quote a link only from the text read_link returns, never from the title or URL alone — the title can be misleading and the page may not be fetched yet.
save_link is idempotent on the normalized URL: calling it twice for the same page returns the existing link (existing: true) instead of duplicating it.
save_link waits briefly for the background fetch so it can report the real title and excerpt; if fetch_status comes back "pending" or "failed", say so plainly instead of inventing a summary — offer refetch_link or suggest the user opens the page.
Prefer list_links or search_links before read_link when you are not sure which link the user means.
Dates are ISO ("YYYY-MM-DD" or full ISO timestamps). link_digest groups what was saved since a date by site, for a weekly recap.
delete_link is irreversible: confirm with the user before calling it.
Watches bring things in: watch_add follows an RSS/Atom feed, a GitHub repository (releases, tags or commits) or a page (text changes); every new entry becomes a watch item and, with auto_save, a saved link. watch_items lists what arrived (unread first); watch_check polls now instead of waiting for the schedule.`;

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

export const TOOLS = [
  tool("save_link",
    "Save a URL to the read-later library. Idempotent on the normalized URL (strips tracking params and trailing slash): saving an already-saved page returns it unchanged with existing: true. Waits up to 10s for the background fetch so it can return the real title, site and excerpt; if the fetch is still pending or failed, that is reported instead of guessed.\nSinónimos: guarda esto, guardar enlace, para luego, guarda este artículo, marcador, guardar página",
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
    "List saved links, most recent first. state: unread (default), read, archived or all. Optional tag, site and since (ISO date, saved_at >= since). Paginated (limit up to 100).\nSinónimos: enlaces, lo que guardé, bandeja, qué tengo guardado, lista de lecturas, pendientes de leer",
    z.object({
      state: z.enum(["unread", "read", "archived", "all"]).default("unread"),
      tag: z.string().max(40).optional(),
      site: z.string().max(200).optional(),
      since: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }), RO,
    (a) => {
      const out = links.listLinks({ state: a.state, tag: a.tag, site: a.site, limit: a.limit });
      const items = a.since ? out.items.filter((l) => l.saved_at >= a.since) : out.items;
      return { total: out.total, items: items.map(present) };
    }),

  tool("search_links",
    "Full-text search over title, description, extracted content, notes and tags. Returns the same shape as list_links.\nSinónimos: buscar enlace, encontrar artículo, buscar en lo guardado, dónde leí, busca esto",
    z.object({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).default(30) }), RO,
    ({ q, limit }) => {
      const out = links.listLinks({ state: "all", q, limit });
      return { total: out.total, items: out.items.map(present), fts_enabled: out.ftsEnabled };
    }),

  tool("read_link",
    "Read a saved link's extracted text, paginated by characters (max_chars, default 4000; offset to page further). Identify by id or url. Returns title, byline, site, the text slice, whether more remains, and highlights. Summarize only from this text, never from the title alone.\nSinónimos: leer artículo, texto del enlace, qué dice, contenido del artículo, léeme esto",
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
    "Add and/or remove tags on a saved link (id or url). Unlisted tags are left untouched.\nSinónimos: etiquetar, poner etiqueta, quitar etiqueta, clasificar enlace",
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
      return present(links.updateLink(link.id, { tags: [...set] }));
    }),

  tool("mark_link",
    "Change a saved link's state: read, unread, archived or favorite (state applies; on/off toggles it, default true).\nSinónimos: marcar leído, marcar como leído, archivar, marcar favorito, destacar, marcar sin leer",
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
    "Save a highlighted quote from a link's text, with an optional note. Identify the link by id or url.\nSinónimos: subrayar, destacar texto, guardar cita, anotar frase",
    z.object({ id: z.string().optional(), url: z.string().optional(), text: z.string().trim().min(1).max(5000), note: z.string().trim().max(2000).default("") }), {},
    (a) => {
      const link = resolveLinkOrFail(a);
      return highlights.addHighlight(link.id, { text: a.text, note: a.note });
    }),

  tool("link_digest",
    "Links saved since a date (ISO, e.g. 2026-09-01), with excerpts, grouped by site. Good for a weekly recap.\nSinónimos: resumen de la semana, qué guardé esta semana, digest, novedades guardadas",
    z.object({ since: z.string().trim().min(4).max(40) }), RO,
    ({ since }) => {
      const out = links.digestSince(since);
      return {
        since: out.since,
        total: out.total,
        sites: out.sites.map((s) => ({ site: s.site, count: s.count, links: s.links.map(present) })),
      };
    }),

  tool("refetch_link",
    "Re-download and re-extract a saved link's page (id or url). Use when fetch_status is failed or the page changed.\nSinónimos: reintentar descarga, actualizar artículo, volver a leer, refrescar enlace",
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
    "Follow a URL for new things: an RSS/Atom feed, a GitHub repository (releases by default; github: tags|commits) or a plain page (text changes). Auto-detects the kind (a page that advertises a feed becomes a feed watch). Checked every every_min minutes (default 60); new entries become watch items and, with auto_save (default), saved links with the given tags. The first check is a baseline: existing entries are not 'new'.\nSinónimos: sigue este feed, avísame cuando, vigilar página, suscribirme, nuevas releases, cuando cambie, seguir repositorio",
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
    "List the watches (feeds, GitHub repositories, pages) with kind, interval, last check, last error and item count.\nSinónimos: qué sigo, mis feeds, vigilancias, suscripciones, qué estoy siguiendo",
    z.object({}), RO,
    () => ({ watches: watches.listWatches(), stats: watches.stats() })),

  tool("watch_items",
    "What the watches brought in: new feed entries, releases and page changes, newest first. unread (default true) hides dismissed items; since is an ISO date; watch_id narrows to one watch. Each item has title, url, summary, published_at and the saved link_id when auto_save applied.\nSinónimos: novedades, qué hay nuevo, qué ha salido, últimas releases, cambios, lo que llegó",
    z.object({
      watch_id: z.string().optional(),
      since: z.string().optional(),
      unread: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(30),
    }), RO,
    (a) => ({ items: watches.listItems({ watch_id: a.watch_id || null, since: a.since || null, unread: a.unread, limit: a.limit }) })),

  tool("watch_check",
    "Check a watch now (or every due watch when watch_id is omitted) instead of waiting for its schedule; returns what was new.\nSinónimos: comprueba ahora, actualiza el feed, mira si hay algo nuevo, refrescar vigilancias",
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

  tool("list_tags",
    "List every tag in use (excluding archived links) with counts, most used first.\nSinónimos: etiquetas, qué etiquetas tengo, lista de etiquetas",
    z.object({}), RO,
    () => ({ tags: links.listTags() })),
];

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

export async function callTool(name, args) {
  const t = findTool(name);
  if (!t) throw Object.assign(new Error("Herramienta desconocida."), { status: 404 });
  return await t.run(t.schema.parse(args || {}));
}
