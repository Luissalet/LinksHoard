import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export const FOLD_LEVELS = [
  { level: 1, label: "Completo", hint: "El texto entero" },
  { level: 2, label: "Frases", hint: "Las frases clave, literales" },
  { level: 3, label: "Clave", hint: "La idea de cada sección y por qué importa (generado)" },
  { level: 4, label: "Secciones", hint: "Una línea por sección (generado)" },
  { level: 5, label: "Temas", hint: "Mapa de temas (generado)" },
];

const GEN_STATUS = {
  none: "Los niveles 3 a 5 los escribe el modelo de las Sparks una vez y quedan guardados.",
  stale: "El texto ha cambiado desde el último plegado: hay que generar los niveles de nuevo.",
  running: "Generando con el modelo…",
  partial: "El plegado quedó a medias.",
  failed: "No se pudo generar el plegado.",
  interrupted: "El plegado se interrumpió.",
};

/** Link to the original page at a passage (text fragment), when the original is a web page. */
function originalAt(link, text) {
  const url = link.url;
  if (link.kind !== "article" || !text) return url;
  const start = text.split(/\s+/).slice(0, 8).join(" ");
  return `${url.split("#")[0]}#:~:text=${encodeURIComponent(start)}`;
}

function Notes({ notes }) {
  if (!notes?.length) return null;
  return <ul className="fold-notes">
    {notes.map((n) => <li key={n.highlight_id}><mark>{n.text.length > 160 ? `${n.text.slice(0, 160)}…` : n.text}</mark>{n.note && <span> — {n.note}</span>}</li>)}
  </ul>;
}

function NoteButton({ onSave }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) return <button type="button" className="btn-link text-[12px]" onClick={() => setOpen(true)}>+ nota</button>;
  const save = async (e) => {
    e.preventDefault();
    if (await onSave(value.trim())) { setValue(""); setOpen(false); }
  };
  return <form className="mt-1 flex gap-1" onSubmit={save}>
    <input className="field field-sm" autoFocus maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Tu nota sobre este pasaje…" aria-label="Nota" />
    <button type="submit" className="btn btn-sm" disabled={!value.trim()}>Guardar</button>
    <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} aria-label="Cancelar">✕</button>
  </form>;
}

function Item({ ctx, pid, text, children, noteText }) {
  return <div className="fold-item">
    <button type="button" className="fold-open" onClick={() => ctx.onOpen(pid)} title="Abrir este párrafo en el texto completo">{children}</button>
    <span className="fold-item-tools">
      <a className="btn-link text-[12px]" href={originalAt(ctx.link, text)} target="_blank" rel="noreferrer" title="Abrir en el original">original ↗</a>
      <NoteButton onSave={(note) => ctx.onAddNote(pid, noteText || ctx.passage(pid), note)} />
    </span>
  </div>;
}

/** Levels 2-5 of a link's fold. Every item opens its paragraph in the full text (level 1); notes stay with their passage. */
export default function FoldView({ link, level, lang, notify, onOpen, onAddNote, reloadKey }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const out = await api.links.fold(link.id, lang);
      if (alive.current) { setDoc(out); setError(""); }
    } catch (e) { if (alive.current) setError(e.message); }
  }, [link.id, lang]);
  useEffect(() => { load(); }, [load, reloadKey, link.article_source.version]);
  const running = doc?.generation.status === "running";
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const generate = async (force = false) => {
    setStarting(true);
    try {
      await api.links.foldStart(link.id, { lang, force });
      await load();
    } catch (e) { notify({ kind: "error", text: e.message }); } finally { if (alive.current) setStarting(false); }
  };

  if (error) return <p role="alert" className="article-answer-warning">{error}</p>;
  if (!doc) return <p className="help">Plegando…</p>;
  const pIndex = new Map(doc.paragraphs.map((p) => [p.id, p]));
  const firstBody = (s) => s.paragraph_ids.find((id) => id !== s.heading_paragraph_id) || s.paragraph_ids[0];
  const passage = (pid) => (pIndex.get(pid)?.text || "").slice(0, 300);
  const sectionTitle = (s) => s.title || `Sección ${s.index}`;
  const gen = doc.generation;
  const generated = level >= 3;
  const hasGenerated = doc.sections.some((s) => s.key || s.line) || doc.themes.length > 0;
  const levelInfo = doc.levels.find((l) => l.level === level);

  const ctx = { link: doc.link, onOpen, onAddNote, passage };

  return <section className="fold-view" aria-live="polite" data-fold-level={level}>
    <p className="help text-[12px]">
      {FOLD_LEVELS.find((l) => l.level === level)?.hint} · {doc.sections.length} {doc.sections.length === 1 ? "sección" : "secciones"}
      {levelInfo?.tokens ? <> · ≈{levelInfo.tokens.toLocaleString("es-ES")} tókenes</> : null}
      {generated && gen.model && <> · generado con {gen.model}</>}
    </p>

    {generated && gen.status !== "done" && <div className="fold-generate">
      <p className="text-[14px]">{GEN_STATUS[gen.status] || ""}{gen.error ? ` (${gen.error})` : ""}
        {running && gen.progress ? ` ${gen.progress.done}/${gen.progress.total}` : ""}</p>
      {!running && <button type="button" className="btn btn-sm btn-primary mt-2" onClick={() => generate(false)} disabled={starting}>
        {gen.status === "none" ? "Generar niveles 3-5" : gen.status === "stale" ? "Generar de nuevo" : "Completar"}
      </button>}
    </div>}
    {generated && gen.status === "done" && <p className="help text-[12px]">
      Texto generado: compruébalo en su párrafo antes de citarlo. <button type="button" className="btn-link" onClick={() => generate(true)} disabled={starting}>Volver a generar</button>
    </p>}

    {level === 2 && doc.sections.map((s) => <article key={s.id} className="fold-section" id={`fold-${s.id}`}>
      <h3 className="fold-title"><button type="button" className="fold-open" onClick={() => onOpen(firstBody(s))}>{sectionTitle(s)}</button></h3>
      {s.references ? <p className="help">Referencias</p> : s.sentences.map((x) => <Item ctx={ctx} key={`${x.start}`} pid={x.paragraph_id} text={x.text} noteText={x.text}><span>{x.text}</span></Item>)}
      <Notes notes={s.notes} />
    </article>)}

    {level === 3 && hasGenerated && doc.sections.map((s) => <article key={s.id} className="fold-section" id={`fold-${s.id}`}>
      <h3 className="fold-title"><button type="button" className="fold-open" onClick={() => onOpen(firstBody(s))}>{sectionTitle(s)}</button></h3>
      {s.references ? <p className="help">Referencias</p> : s.key ? <Item ctx={ctx} pid={s.key.paragraph_id} text={passage(s.key.paragraph_id)}>
        <span className="fold-idea">{s.key.idea}</span>{s.key.why && <span className="fold-why"> Por qué: {s.key.why}</span>}
      </Item> : <p className="help">Pendiente.</p>}
      <Notes notes={s.notes} />
    </article>)}

    {level === 4 && hasGenerated && <ol className="fold-lines">
      {doc.sections.map((s) => <li key={s.id} id={`fold-${s.id}`}>
        <Item ctx={ctx} pid={firstBody(s)} text={passage(firstBody(s))}>
          <strong>{sectionTitle(s)}</strong>{" — "}{s.references ? "Referencias" : s.line || "pendiente"}
        </Item>
        {s.notes.length > 0 && <span className="help text-[12px]">{s.notes.length} {s.notes.length === 1 ? "nota" : "notas"}</span>}
      </li>)}
    </ol>}

    {level === 5 && doc.themes.length > 0 && <div className="fold-themes">
      {doc.themes.map((t) => {
        const notes = doc.sections.filter((s) => t.section_ids.includes(s.id)).reduce((n, s) => n + s.notes.length, 0);
        return <article key={t.id} className="fold-card">
          <h3 className="fold-title">{t.title}</h3>
          <p className="text-[14px]">{t.summary}</p>
          <p className="mt-2 flex flex-wrap gap-1">
            {t.section_ids.map((sid) => {
              const s = doc.sections.find((x) => x.id === sid);
              return s ? <button key={sid} type="button" className="chip" onClick={() => onOpen(firstBody(s))} title={s.line || ""}>{sectionTitle(s)}</button> : null;
            })}
          </p>
          {notes > 0 && <p className="help mt-1 text-[12px]">{notes} {notes === 1 ? "nota" : "notas"}</p>}
        </article>;
      })}
    </div>}

    {doc.loose_notes.length > 0 && <div className="mt-4"><p className="help text-[12px]">Notas sin pasaje en este texto:</p><Notes notes={doc.loose_notes} /></div>}
  </section>;
}
