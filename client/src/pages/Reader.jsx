import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { useAction, ConfirmDialog } from "../components/ui.jsx";
import { formatDate, kindLabel, readingTime } from "../format.js";

const FONT_SIZES = [15, 17, 19, 22];

function HighlightPopover({ rect, onSave, onClose }) {
  if (!rect) return null;
  return (
    <div
      className="fixed z-20 flex gap-1 rounded-md border bg-white p-1 shadow-lg"
      style={{ left: rect.left, top: rect.top - 44, borderColor: "var(--line)" }}
    >
      <button type="button" className="btn btn-sm btn-primary" onClick={onSave}>Subrayar</button>
      <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Cancelar">✕</button>
    </div>
  );
}

export default function Reader({ linkId }) {
  const { notify, refresh: refreshApp } = useApp();
  const [link, setLink] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [fontIdx, setFontIdx] = useState(1);
  const [tagInput, setTagInput] = useState("");
  const [notes, setNotes] = useState("");
  const [selection, setSelection] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [run, busy] = useAction(notify);
  const textRef = useRef(null);

  const load = useCallback(async () => {
    const data = await api.links.get(linkId);
    setLink(data);
    setHighlights(data.highlights || []);
    setNotes(data.notes || "");
    if (!data.read_at) api.links.read(linkId).then(() => refreshApp()).catch(() => {});
  }, [linkId, refreshApp]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!link || link.fetch_status !== "pending") return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [link, load]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || !textRef.current?.contains(sel.anchorNode)) { setSelection(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({ text, rect });
  };

  const saveHighlight = async () => {
    if (!selection) return;
    const created = await run(() => api.highlights.create(linkId, { text: selection.text }), "Subrayado guardado.");
    if (created) setHighlights((h) => [...h, created]);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const removeHighlight = async (id) => {
    setPendingDelete(null);
    await run(() => api.highlights.remove(id), "Subrayado borrado.");
    setHighlights((h) => h.filter((x) => x.id !== id));
  };

  const saveNoteFor = async (id, note) => {
    const updated = await run(() => api.highlights.update(id, { note }));
    if (updated) setHighlights((h) => h.map((x) => (x.id === id ? updated : x)));
  };

  const addTag = async (e) => {
    e.preventDefault();
    const tag = tagInput.trim();
    if (!tag) return;
    const updated = await run(() => api.links.update(linkId, { tags: [...new Set([...link.tags, tag])] }));
    if (updated) { setLink((l) => ({ ...l, tags: updated.tags })); setTagInput(""); refreshApp(); }
  };
  const removeTag = async (tag) => {
    const updated = await run(() => api.links.update(linkId, { tags: link.tags.filter((t) => t !== tag) }));
    if (updated) { setLink((l) => ({ ...l, tags: updated.tags })); refreshApp(); }
  };

  const saveNotes = async () => {
    await run(() => api.links.update(linkId, { notes }), "Notas guardadas.");
  };

  const toggleFavorite = async () => {
    const updated = await run(() => api.links.favorite(linkId, !link.favorite));
    if (updated) { setLink((l) => ({ ...l, favorite: updated.favorite })); refreshApp(); }
  };
  const toggleArchive = async () => {
    const updated = await run(() => api.links.archive(linkId, !link.archived));
    if (updated) { setLink((l) => ({ ...l, archived: updated.archived })); refreshApp(); window.location.hash = "#/bandeja"; }
  };
  const refetch = async () => {
    await run(() => api.links.refetch(linkId), "Volviendo a descargar…");
    load();
  };

  if (!link) return <p className="help p-8">Cargando…</p>;

  return (
    <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-8 sm:py-9" onMouseUp={onMouseUp}>
      <a href="#/bandeja" className="btn-link text-[13px]">← Volver</a>
      <header className="mt-3 mb-5">
        <h1 className="text-[24px] font-semibold leading-tight sm:text-[28px]">{link.title || link.url}</h1>
        <p className="help mt-1 text-[13px]">
          <a href={link.url_original || link.url} target="_blank" rel="noreferrer" className="btn-link">{link.site}</a>
          {link.byline && <> · {link.byline}</>} · {formatDate(link.saved_at)}
          {link.word_count > 0 && <> · {readingTime(link.word_count)}</>} · <span className="chip">{kindLabel(link.kind)}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={toggleFavorite} disabled={busy}>{link.favorite ? "★ Favorito" : "☆ Marcar favorito"}</button>
          <button type="button" className="btn btn-sm" onClick={toggleArchive} disabled={busy}>{link.archived ? "Desarchivar" : "Archivar"}</button>
          {link.fetch_status === "failed" && <button type="button" className="btn btn-sm" onClick={refetch} disabled={busy}>Reintentar descarga</button>}
          <div className="ml-auto flex items-center gap-1">
            <span className="help text-[11px]">Tamaño de letra</span>
            {FONT_SIZES.map((size, i) => (
              <button key={size} type="button" className={`btn btn-sm btn-icon ${fontIdx === i ? "btn-active" : ""}`} onClick={() => setFontIdx(i)} aria-label={`Letra ${size}px`}>A{i > 0 ? "+".repeat(i) : ""}</button>
            ))}
          </div>
        </div>
      </header>

      {link.fetch_status === "pending" && <p className="help mb-4">Descargando y extrayendo el texto…</p>}
      {link.fetch_status === "failed" && (
        <p className="chip chip-danger mb-4 inline-block">No se pudo descargar: {link.fetch_error || "error desconocido"}</p>
      )}

      {link.content_text ? (
        <div ref={textRef} className="reader-text" style={{ fontSize: FONT_SIZES[fontIdx] }}>{link.content_text}</div>
      ) : link.fetch_status === "ok" ? (
        <p className="help">No se pudo extraer texto legible de esta página. Ábrela en el sitio original.</p>
      ) : null}

      <HighlightPopover rect={selection?.rect} onSave={saveHighlight} onClose={() => setSelection(null)} />

      <section className="mt-10 border-t pt-6" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-[16px] font-semibold">Subrayados</h2>
        {highlights.length === 0 ? (
          <p className="help mt-2">Selecciona texto arriba y pulsa «Subrayar» para guardarlo.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {highlights.map((h) => (
              <li key={h.id} className="panel-white">
                <p className="text-[14px]"><mark>{h.text}</mark></p>
                <input
                  className="field field-sm mt-2"
                  placeholder="Añadir nota…"
                  defaultValue={h.note}
                  onBlur={(e) => { if (e.target.value !== h.note) saveNoteFor(h.id, e.target.value); }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="help text-[11px]">{formatDate(h.created_at)}</span>
                  <button type="button" className="btn-link text-[12px]" onClick={() => setPendingDelete(h)}>Borrar</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 border-t pt-6" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-[16px] font-semibold">Etiquetas</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {link.tags.map((t) => (
            <span key={t} className="chip chip-accent">{t} <button type="button" className="ml-1" aria-label={`Quitar etiqueta ${t}`} onClick={() => removeTag(t)}>✕</button></span>
          ))}
          <form onSubmit={addTag} className="inline-flex gap-1">
            <input className="field field-sm w-[140px]" placeholder="nueva etiqueta" value={tagInput} onChange={(e) => setTagInput(e.target.value)} />
            <button type="submit" className="btn btn-sm">Añadir</button>
          </form>
        </div>
      </section>

      <section className="mt-8 border-t pt-6 pb-10" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-[16px] font-semibold">Notas</h2>
        <textarea className="field mt-2" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="Tus notas sobre este artículo…" />
      </section>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Borrar subrayado"
        text="Se borrará este subrayado y su nota."
        onConfirm={() => removeHighlight(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
