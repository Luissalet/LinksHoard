import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { useAction, ConfirmDialog } from "../components/ui.jsx";
import VideoInsight from "../components/VideoInsight.jsx";
import VideoDigest from "../components/VideoDigest.jsx";
import ArticleQuestions from "../components/ArticleQuestions.jsx";
import ListenPanel from "../components/ListenPanel.jsx";
import FoldView, { FOLD_LEVELS } from "../components/FoldView.jsx";
import { formatDate, isMediaUrl, kindLabel, readingTime } from "../format.js";
import { useCopilotRefresh } from "../useCopilotRefresh.js";
import { COPILOT_CONTEXT } from "../hoard-copilot.js";

const FONT_SIZES = [15, 17, 19, 22];
const LANGUAGES = [["es", "Español"], ["en", "Inglés"], ["fr", "Francés"], ["de", "Alemán"], ["it", "Italiano"], ["pt", "Portugués"], ["ca", "Catalán"],
  ["gl", "Gallego"], ["eu", "Euskera"], ["nl", "Neerlandés"], ["ja", "Japonés"], ["zh", "Chino"]];
const TRANSLATE_STEP = 20;

/** Bilingual reading: stored translations first, then the missing paragraphs in steps, shown as they arrive. */
function useTranslation(link, notify) {
  const [lang, setLang] = useState("");
  const [items, setItems] = useState(() => new Map());
  const [progress, setProgress] = useState(null);
  const epoch = useRef(0);
  const total = link?.article_source?.paragraphs.length || 0;
  const start = useCallback(async (target) => {
    const run = ++epoch.current;
    setLang(target); setItems(new Map()); setProgress({ done: 0, total, running: true });
    const merge = (out) => setItems((m) => { const next = new Map(m); for (const p of out.pairs) if (p.translation) next.set(p.paragraph_id, p.translation); return next; });
    try {
      for (let offset = 0; offset < total; offset += 200) merge(await api.links.translate(link.id, { lang: target, offset, limit: 200, translate: false }));
      let done = 0;
      for (let offset = 0; offset < total && run === epoch.current; offset += TRANSLATE_STEP) {
        const out = await api.links.translate(link.id, { lang: target, offset, limit: TRANSLATE_STEP });
        if (run !== epoch.current) return;
        merge(out);
        done = offset + out.pairs.length;
        setProgress({ done, total, running: offset + TRANSLATE_STEP < total });
        if (out.error) { notify({ kind: "error", text: out.message }); setProgress({ done, total, running: false, error: out.error }); return; }
      }
    } catch (e) {
      if (run === epoch.current) { notify({ kind: "error", text: e.message }); setProgress((p) => ({ ...p, running: false, error: e.message })); }
    }
  }, [link?.id, total, notify]);
  const stop = useCallback(() => { epoch.current++; setLang(""); setProgress(null); setItems(new Map()); }, []);
  return { lang, items, progress, start, stop };
}

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

export default function Reader({ linkId, paragraphId, sourceVersion, foldLevel }) {
  const { notify, refresh: refreshApp } = useApp();
  const [link, setLink] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [fontIdx, setFontIdx] = useState(1);
  const [tagInput, setTagInput] = useState("");
  const [notes, setNotes] = useState("");
  const noteState = useRef({ value: "", baseline: "", loaded: false });
  noteState.current.value = notes;
  const [selection, setSelection] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [run, busy] = useAction(notify);
  const textRef = useRef(null);
  const [activeParagraph, setActiveParagraph] = useState(null);
  const [level, setLevel] = useState(() => Math.min(5, Math.max(1, Number(foldLevel) || 1)));
  const [foldLang, setFoldLang] = useState("es");
  const [targetLang, setTargetLang] = useState("es");
  const [pendingFocus, setPendingFocus] = useState(null);
  const translation = useTranslation(link, notify);

  const focusParagraph = useCallback((id, version) => {
    setActiveParagraph(null);
    if (!id || !link?.article_source) return;
    if (version !== link.article_source.version || !link.article_source.paragraphs.some((p) => p.id === id)) {
      notify({ kind: "error", text: "Esta cita pertenece a otra versión del artículo. Vuelve a preguntar sobre el texto actual." });
      return;
    }
    setActiveParagraph(id);
    const element = document.getElementById(id);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [link?.article_source, notify]);
  useEffect(() => { focusParagraph(paragraphId, sourceVersion); }, [paragraphId, sourceVersion, focusParagraph]);

  // Plegar: an item of a folded level opens its paragraph in the full text
  const openParagraph = useCallback((id) => { setLevel(1); setPendingFocus(id); }, []);
  useEffect(() => {
    if (level !== 1 || !pendingFocus || !link?.article_source) return;
    focusParagraph(pendingFocus, link.article_source.version);
    setPendingFocus(null);
  }, [level, pendingFocus, link?.article_source, focusParagraph]);
  // keys: 1-5 a level, + or = more detail, - less detail (not while typing)
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (/^[1-5]$/.test(e.key)) setLevel(Number(e.key));
      else if (e.key === "+" || e.key === "=") setLevel((l) => Math.max(1, l - 1));
      else if (e.key === "-") setLevel((l) => Math.min(5, l + 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [foldReload, setFoldReload] = useState(0);
  const addNote = async (paragraphId, text, note) => {
    const created = await run(() => api.highlights.create(linkId, { text, note }), "Nota guardada.");
    if (created) { setHighlights((h) => [...h, created]); setFoldReload((n) => n + 1); }
    return Boolean(created);
  };

  const load = useCallback(async () => {
    const data = await api.links.get(linkId);
    setLink(data);
    setHighlights(data.highlights || []);
    if (!noteState.current.loaded || noteState.current.value === noteState.current.baseline) {
      setNotes(data.notes || "");
      noteState.current.value = data.notes || "";
    }
    noteState.current.baseline = data.notes || "";
    noteState.current.loaded = true;
    if (!data.read_at) api.links.read(linkId).then(() => refreshApp()).catch(() => {});
  }, [linkId, refreshApp]);
  useEffect(() => { load(); }, [load]);
  useCopilotRefresh(load);
  useEffect(() => {
    const context = event => Object.assign(event.detail, {
      link_id: linkId, notes: noteState.current.value,
      notes_dirty: noteState.current.value !== noteState.current.baseline,
      selection: selection?.text || "",
    });
    window.addEventListener(COPILOT_CONTEXT, context);
    return () => window.removeEventListener(COPILOT_CONTEXT, context);
  }, [linkId, selection]);

  useEffect(() => {
    if (!link || link.fetch_status !== "pending") return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [link, load]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || !textRef.current?.contains(sel.anchorNode)) { setSelection(null); return; }
    // a translation is not the saved text: it cannot be a highlight of it
    if (sel.anchorNode?.parentElement?.closest("[data-translation]") || sel.focusNode?.parentElement?.closest("[data-translation]")) { setSelection(null); return; }
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

  // Highlights to Hypatia flashcards, through the hub. The server answers 200 with a status: say what it means.
  const CARD_MESSAGES = {
    hub_down: "No se alcanza el hub de Hoard Link: arráncalo y vuelve a intentarlo.",
    hypatia_unavailable: "El hub no encuentra Hypatia (o es una versión sin tarjetas): ábrela y vuelve a intentarlo.",
    hub_refused: "El hub no aceptó el token de esta aplicación.",
    hypatia_error: "Hypatia respondió con un error.",
  };
  const sendToHypatia = async (highlight) => {
    const out = await run(() => (highlight ? api.highlights.toCards(highlight.id) : api.highlights.linkToCards(linkId)), null);
    if (!out) return;
    if (out.ok) {
      notify({ kind: "ok", text: out.sent ? `${out.sent} ${out.sent === 1 ? "tarjeta enviada" : "tarjetas enviadas"} a Hypatia (mazo ${out.deck}).` : "Todo estaba ya enviado a Hypatia." });
      const list = await api.highlights.list(linkId).catch(() => null);
      if (list) setHighlights(list);
    } else {
      notify({ kind: "error", text: `${CARD_MESSAGES[out.status] || "No se pudo enviar a Hypatia."}${out.error ? ` (${out.error})` : ""}` });
    }
  };

  const saveNoteFor = async (id, note) => {
    const updated = await run(() => api.highlights.update(id, { note }));
    if (updated) setHighlights((h) => h.map((x) => (x.id === id ? updated : x)));
  };

  const addTag = async (e) => {
    e.preventDefault();
    const tag = tagInput.trim();
    if (!tag) return;
    const updated = await run(() => api.links.update(linkId, { tags_add: [tag] }));
    if (updated) { setLink((l) => ({ ...l, tags: updated.tags })); setTagInput(""); refreshApp(); }
  };
  const removeTag = async (tag) => {
    const updated = await run(() => api.links.update(linkId, { tags_remove: [tag] }));
    if (updated) { setLink((l) => ({ ...l, tags: updated.tags })); refreshApp(); }
  };

  const saveNotes = async () => {
    const saved = notes;
    if (saved === noteState.current.baseline) return;
    const updated = await run(() => api.links.update(linkId, { notes: saved }), "Notas guardadas.");
    if (updated) {
      noteState.current.baseline = updated.notes || "";
      setLink(current => ({ ...current, ...updated }));
      if (noteState.current.value === saved) setNotes(updated.notes || "");
    }
  };

  const toggleFavorite = async () => {
    const updated = await run(() => api.links.favorite(linkId, !link.favorite));
    if (updated) { setLink((l) => ({ ...l, favorite: updated.favorite })); refreshApp(); }
  };
  const toggleArchive = async () => {
    const updated = await run(() => api.links.archive(linkId, !link.archived));
    if (updated) { setLink((l) => ({ ...l, archived: updated.archived })); refreshApp(); window.location.hash = "#/bandeja"; }
  };
  const download = async () => {
    const out = await run(() => api.media.start({ url: link.url_original || link.url, format: "auto", save_link: true }), null);
    if (out) {
      notify({ kind: "ok", text: out.existing ? "Esa descarga ya está en curso." : "Descarga en cola: sigue el progreso en Descargas." });
      window.location.hash = "#/descargas";
    }
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
          {(link.kind === "video" || link.kind === "audio" || isMediaUrl(link.url)) && <button type="button" className="btn btn-sm" onClick={download} disabled={busy}>⬇ Descargar</button>}
          {link.fetch_status === "failed" && <button type="button" className="btn btn-sm" onClick={refetch} disabled={busy}>Reintentar descarga</button>}
          <div className="ml-auto flex items-center gap-1">
            <span className="help text-[11px]">Tamaño de letra</span>
            {FONT_SIZES.map((size, i) => (
              <button key={size} type="button" className={`btn btn-sm btn-icon ${fontIdx === i ? "btn-active" : ""}`} onClick={() => setFontIdx(i)} aria-label={`Letra ${size}px`}>A{i > 0 ? "+".repeat(i) : ""}</button>
            ))}
          </div>
        </div>
      </header>

      {link.fetch_status !== "pending" && <ListenPanel key={`listen:${linkId}:${link.fetched_at || ""}`} linkId={linkId} notify={notify} />}

      {link.fetch_status === "pending" && <p className="help mb-4">Descargando y extrayendo el texto…</p>}
      {link.fetch_status === "failed" && (
        <p className="chip chip-danger mb-4 inline-block">No se pudo descargar: {link.fetch_error || "error desconocido"}</p>
      )}

      {link.content_text ? (
        <>
          <ArticleQuestions key={`${linkId}:${link.article_source.version}`} link={link} onReload={load} onCitation={focusParagraph} />
          <div className="fold-bar" role="group" aria-label="Plegar">
            <span className="text-[13px] font-semibold">Plegar</span>
            <input type="range" min={1} max={5} step={1} value={level} onChange={(e) => setLevel(Number(e.target.value))}
              className="fold-range" aria-label="Nivel de detalle" aria-valuetext={FOLD_LEVELS[level - 1].label} />
            <span className="flex flex-wrap gap-1">
              {FOLD_LEVELS.map((l) => <button key={l.level} type="button" title={`${l.hint} (tecla ${l.level})`} aria-pressed={level === l.level}
                className={`btn btn-sm ${level === l.level ? "btn-active" : ""}`} onClick={() => setLevel(l.level)}>{l.level} {l.label}</button>)}
            </span>
            {level >= 3 && <select className="field field-sm w-auto" value={foldLang} onChange={(e) => setFoldLang(e.target.value)} aria-label="Idioma del plegado">
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>}
            <span className="help text-[11px]">Teclas 1-5, + y −</span>
          </div>
          {level === 1 && <div className="fold-bar" role="group" aria-label="Traducción">
            <span className="text-[13px] font-semibold">Traducción</span>
            <select className="field field-sm w-auto" value={targetLang} onChange={(e) => setTargetLang(e.target.value)} aria-label="Idioma de la traducción">
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            {translation.lang ? <button type="button" className="btn btn-sm" onClick={translation.stop}>Quitar traducción</button>
              : <button type="button" className="btn btn-sm" onClick={() => translation.start(targetLang)}>Traducir párrafo a párrafo</button>}
            {translation.lang && translation.lang !== targetLang && <button type="button" className="btn btn-sm" onClick={() => translation.start(targetLang)}>Cambiar idioma</button>}
            {translation.progress && <span className="help text-[12px]" aria-live="polite">
              {translation.items.size}/{translation.progress.total} párrafos{translation.progress.running ? " · traduciendo…" : ""}{translation.progress.error ? " · incompleta" : ""}
            </span>}
          </div>}
          {level === 1 ? <div ref={textRef} className="reader-text" style={{ fontSize: FONT_SIZES[fontIdx] }}>
            {link.article_source.paragraphs.map((p, i, paragraphs) => <React.Fragment key={p.id}>
              {link.content_text.slice(i ? paragraphs[i - 1].end : 0, p.start)}
              <span id={p.id} tabIndex={-1} className={activeParagraph === p.id ? "reader-paragraph reader-paragraph-active" : "reader-paragraph"}>{p.text}</span>
              {translation.lang && translation.items.has(p.id) && <span className="reader-translation" lang={translation.lang} data-translation="1">{translation.items.get(p.id)}</span>}
            </React.Fragment>)}
            {link.content_text.slice(link.article_source.paragraphs.at(-1)?.end || 0)}
          </div> : <FoldView link={link} level={level} lang={foldLang} notify={notify} onOpen={openParagraph} onAddNote={addNote} reloadKey={foldReload} />}
        </>
      ) : link.fetch_status === "ok" ? (
        <p className="help">No se pudo extraer texto legible de esta página. Ábrela en el sitio original.</p>
      ) : null}

      <VideoInsight linkId={linkId} kind={link.kind} notify={notify} />
      <VideoDigest linkId={linkId} kind={link.kind} notify={notify} />

      <HighlightPopover rect={selection?.rect} onSave={saveHighlight} onClose={() => setSelection(null)} />

      <section className="mt-10 border-t pt-6" style={{ borderColor: "var(--line)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold">Subrayados</h2>
          {highlights.some((h) => !h.card_sent_at) && (
            <button type="button" className="btn btn-sm" onClick={() => sendToHypatia(null)} disabled={busy}>Enviar todos a Hypatia</button>
          )}
        </div>
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
                  <span className="help text-[11px]">{formatDate(h.created_at)}{h.card_sent_at && <> · <span className="chip" title={`Enviada a Hypatia (mazo ${h.card_deck || "Lecturas"})`}>En Hypatia ✓</span></>}</span>
                  <span className="flex items-center gap-3">
                    <button type="button" className="btn-link text-[12px]" onClick={() => sendToHypatia(h)} disabled={busy}>{h.card_sent_at ? "Enviar de nuevo" : "Enviar a Hypatia"}</button>
                    <button type="button" className="btn-link text-[12px]" onClick={() => setPendingDelete(h)}>Borrar</button>
                  </span>
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
