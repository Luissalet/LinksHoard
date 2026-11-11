// App Dock uses the same routes and refresh events as the person's interface.
import { COPILOT_REFRESH } from "./hoard-copilot.js";

const fold = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
function choose(items, title) {
  const exact = items.filter((item) => fold(item.title || item.url) === fold(title));
  const matches = exact.length ? exact : items.filter((item) => fold(item.title || item.url).includes(fold(title)));
  if (matches.length !== 1) throw Object.assign(new Error(matches.length ? "Several links match; use an id" : "Link not found"), {
    code: matches.length ? "ambiguous" : "not_found", candidates: matches.slice(0, 8).map(({ id, title }) => ({ id, label: title })),
  });
  return matches[0];
}

export function installAppDock({ api, refresh, pages }, target = window) {
  const app = target.HoardApp ||= { q: [] };
  const send = (method, ...args) => app[method] ? app[method](...args) : app.q.push([method, ...args]);
  let active = true;
  const point = async (cursor, selector = "main h1") => {
    const el = target.document.querySelector(selector) || target.document.querySelector("main");
    if (el) await cursor.to(el);
  };
  const tool = (name, description, properties, required, handler) => send("registerTool", name, {
    description, inputSchema: { type: "object", properties, required, additionalProperties: false },
  }, handler);
  const text = { type: "string", minLength: 1 };
  tool("links_open", "Open a saved link by id or unique title", { id: text, title: text }, [], async ({ id, title }, { cursor }) => {
    if (!id && !title?.trim()) throw Object.assign(new Error("Provide id or title"), { code: "bad_args" });
    const link = id ? await api.links.get(id) : choose((await api.links.list({ q: title, state: "all", limit: 100 })).items, title);
    if (!link?.id) throw Object.assign(new Error("Link not found"), { code: "not_found" });
    await point(cursor);
    target.location.hash = `#/link/${encodeURIComponent(link.id)}`;
    return { opened: link.id, title: link.title || link.url };
  });
  tool("links_filter", "Filter the saved links by text, tag, site and reading state", {
    q: { type: "string" }, tag: { type: "string" }, site: { type: "string" },
    view: { type: "string", enum: ["todo", "bandeja", "archivados", "favoritos"] },
  }, [], async ({ view = "todo", ...filter }, { cursor }) => {
    await point(cursor);
    const query = new URLSearchParams(filter).toString();
    target.location.hash = `#/${view}${query ? "?" + query : ""}`;
    return { view, filters: filter };
  });
  tool("links_view", "Switch the Links section", { view: { type: "string", enum: pages } }, ["view"], async ({ view }, { cursor }) => {
    await point(cursor, `nav a[href="#/${view}"]`);
    target.location.hash = `#/${view}`;
    return { view };
  });
  send("setContext", () => {
    const route = target.location.hash.replace(/^#\/?/, "") || "bandeja";
    const id = route.match(/^link\/([^?]+)/)?.[1];
    const row = target.document.querySelector(".link-row[data-selected=true]");
    const focus = id ? { kind: "link", id: decodeURIComponent(id), label: target.document.querySelector("main h1")?.textContent || "" }
      : row ? { kind: "link", id: row.dataset.linkId, label: row.dataset.linkTitle } : undefined;
    return { view: route.split("?")[0].split("/")[0], focus, summary: JSON.stringify({ q: target.document.querySelector('input[aria-label="Buscar enlaces"]')?.value || "", site: target.document.querySelector('select[aria-label="Filtrar por sitio"]')?.value || "", tag: new URLSearchParams(route.split("?")[1] || "").get("tag") || "" }) };
  });
  const unsubscribe = send("onChanged", async () => {
    if (!active) return;
    await refresh();
    target.dispatchEvent(new Event(COPILOT_REFRESH));
  });
  return () => { active = false; if (typeof unsubscribe === "function") unsubscribe(); };
}
