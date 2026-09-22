import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Empty, useAction } from "./ui.jsx";
import SaveBox from "./SaveBox.jsx";
import LinkRow from "./LinkRow.jsx";

function useQueryParam(name) {
  const [value, setValue] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] || "").get(name) || "");
  useEffect(() => {
    const onChange = () => setValue(new URLSearchParams(window.location.hash.split("?")[1] || "").get(name) || "");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [name]);
  return value;
}

/**
 * Shared list view for Bandeja/Todo/Archivados/Favoritos. `state` picks the
 * server-side filter; `showSave` shows the paste box (only on Bandeja/Todo).
 * Keyboard: j/k move selection, Enter opens, e archives, r toggles read.
 */
export default function LinkList({ title, description, state, showSave = false, favoriteOnly = false }) {
  const { notify, refresh } = useApp();
  const tagParam = useQueryParam("tag");
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const [site, setSite] = useState("");
  const [sites, setSites] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [run] = useAction(notify);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    const filter = { state: state === "all" ? "all" : state, tag: tagParam || undefined, site: site || undefined, q: q || undefined, limit: 100 };
    const out = await api.links.list(filter);
    let list = out.items;
    if (favoriteOnly) list = list.filter((l) => l.favorite);
    setItems(list);
    setSelectedId((prev) => (list.some((l) => l.id === prev) ? prev : list[0]?.id ?? null));
  }, [state, tagParam, site, q, favoriteOnly]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.sites().then(setSites).catch(() => {}); }, []);
  // Poll while any link is still fetching, so title/excerpt appear without a manual refresh.
  useEffect(() => {
    if (!items?.some((l) => l.fetch_status === "pending")) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [items, load]);

  const open = useCallback((link) => { window.location.hash = `#/link/${link.id}`; }, []);
  const toggleRead = useCallback(async (link) => {
    await run(() => (link.read_at ? api.links.unread(link.id) : api.links.read(link.id)));
    load(); refresh();
  }, [run, load, refresh]);
  const toggleArchive = useCallback(async (link) => {
    await run(() => api.links.archive(link.id, !link.archived));
    load(); refresh();
  }, [run, load, refresh]);
  const toggleFavorite = useCallback(async (link) => {
    await run(() => api.links.favorite(link.id, !link.favorite));
    load(); refresh();
  }, [run, load, refresh]);

  useEffect(() => {
    function onKey(e) {
      if (!items?.length) return;
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      const idx = items.findIndex((l) => l.id === selectedId);
      if (e.key === "j") { e.preventDefault(); setSelectedId(items[Math.min(items.length - 1, idx + 1)]?.id); }
      else if (e.key === "k") { e.preventDefault(); setSelectedId(items[Math.max(0, idx - 1)]?.id); }
      else if (e.key === "Enter") { const l = items[idx]; if (l) open(l); }
      else if (e.key === "e") { const l = items[idx]; if (l) toggleArchive(l); }
      else if (e.key === "r") { const l = items[idx]; if (l) toggleRead(l); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selectedId, open, toggleArchive, toggleRead]);

  return (
    <Page
      title={title}
      description={description}
      actions={
        <select className="field field-sm w-[180px]" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Filtrar por sitio">
          <option value="">Todos los sitios</option>
          {sites.map((s) => <option key={s.site} value={s.site}>{s.site} ({s.count})</option>)}
        </select>
      }
    >
      {showSave && <SaveBox notify={notify} onSaved={() => { load(); refresh(); }} />}
      <div className="mb-4">
        <input className="field" type="search" placeholder="Buscar en título, texto, notas y etiquetas…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar enlaces" />
      </div>
      {tagParam && (
        <div className="mb-3 flex items-center gap-2 text-[13px]">
          <span className="chip chip-accent">#{tagParam}</span>
          <a href="#/todo" className="btn-link">Quitar filtro</a>
        </div>
      )}
      {items === null ? (
        <p className="help">Cargando…</p>
      ) : items.length === 0 ? (
        <Empty text={q || tagParam || site ? "No hay enlaces que coincidan con el filtro." : "Todavía no has guardado nada aquí. Pega una URL arriba para empezar."} />
      ) : (
        <ul ref={listRef} className="divide-y" style={{ borderColor: "var(--line)" }}>
          {items.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              selected={link.id === selectedId}
              onOpen={open}
              onSelect={setSelectedId}
              onToggleRead={toggleRead}
              onToggleArchive={toggleArchive}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </ul>
      )}
      <p className="help mt-4 text-[11px]">Atajos: j/k para moverte, Intro para abrir, e archiva, r marca leído/sin leer.</p>
    </Page>
  );
}
