import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { LoginButton } from "./SiteLogin.jsx";

export const DIGEST_STATUS = {
  none: "Sin digest todavía.",
  queued: "En cola…",
  running: "Procesando…",
  done: "Listo.",
  partial: "Listo con huecos (mira los avisos).",
  failed: "Falló.",
};
const STAGES = { media: "vídeo y transcripción", metadata: "datos de la publicación", visual: "recorrido de la imagen", frames: "fotogramas",
  ocr: "texto en pantalla", vision: "descripción de planos", chapters: "capítulos", summary: "resumen con el modelo local", sheets: "mosaico", write: "escritura" };
const TABS = [
  { level: "brief", label: "Ficha e índice" },
  { level: "visual", label: "Pantalla (OCR)" },
  { level: "transcript", label: "Transcripción" },
];
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

/** The layered digest of a video for an assistant (server/videodigest.js): state, cost in tokens, contact sheet, layers and questions. */
export default function VideoDigest({ linkId, kind, notify }) {
  const [view, setView] = useState(null);
  const [focus, setFocus] = useState("");
  const [tab, setTab] = useState("brief");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try { const v = await api.videoDigest.get(linkId); setView(v); if (v.focus && !focus) setFocus(v.focus); } catch { /* optional panel */ }
  }, [linkId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const running = view && ["queued", "running"].includes(view.status);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [running, load]);
  const ready = view && ["done", "partial"].includes(view.status);
  useEffect(() => {
    if (!ready) { setText(""); return; }
    api.videoDigest.get(linkId, tab).then((v) => setText(v.text || "")).catch(() => setText(""));
  }, [ready, tab, linkId, view?.finished_at]);

  if (!view) return null;
  if (view.status === "none" && kind !== "video" && !view.video_candidate) return null;

  const start = async (extra = {}) => {
    setBusy(true);
    try { setView(await api.videoDigest.run(linkId, { focus: focus.trim() || undefined, ...extra })); notify({ kind: "ok", text: "Digest en marcha." }); }
    catch (e) { notify({ kind: "error", text: e.message }); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); notify({ kind: "ok", text: "Copiado." }); } catch { notify({ kind: "error", text: "No se pudo copiar." }); }
  };
  const ask = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try { setAnswer(await api.videoDigest.ask(linkId, question.trim())); } catch (err) { notify({ kind: "error", text: err.message }); } finally { setAsking(false); }
  };

  const t = view.stats?.tokens || {};
  const notes = view.stats?.notes || [];
  return (
    <section className="mt-8 border-t pt-6" style={{ borderColor: "var(--line)" }} data-testid="video-digest">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold">Digest para asistentes</h2>
        {ready && <span className="help text-[12px]">{view.dir}</span>}
      </div>
      <p className="help mt-1 text-[13px]">
        El vídeo se procesa en este equipo (transcripción, texto en pantalla, capítulos) y queda en texto por capas para que un asistente lo lea sin gastar miles de tokens en fotogramas.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className="field field-sm min-w-[240px] flex-1" placeholder="Foco opcional: qué buscas en el vídeo" value={focus} onChange={(e) => setFocus(e.target.value)} disabled={running} />
        {view.status === "none" || view.status === "failed"
          ? <button type="button" className="btn btn-sm btn-primary" disabled={busy || running} onClick={() => start()}>Generar digest</button>
          : <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => start({ force: true })}>Regenerar</button>}
      </div>
      <p className="help mt-2" data-testid="digest-status">
        {DIGEST_STATUS[view.status] || view.status}
        {running && view.stage ? <> Etapa: {STAGES[view.stage] || view.stage}.</> : null}
        {running && view.detail ? <> {view.detail}</> : null}
        {view.status === "failed" && view.error ? <> {view.error}</> : null}
      </p>
      {view.status === "failed" && view.login && <LoginButton login={view.login} onSaved={() => start()} className="mt-2" />}
      {ready && (
        <>
          <div className="mt-3 flex flex-wrap gap-2 text-[12px]" data-testid="digest-tokens">
            <span className="chip chip-ok">Ficha + índice ≈ {fmt(t.brief)} tokens</span>
            <span className="chip">Todo ≈ {fmt(t.full)}</span>
            {t.overview_image ? <span className="chip">Mosaico ≈ {fmt(t.overview_image)}</span> : null}
            {t.naive_5s ? <span className="chip chip-warn">Fotograma cada 5 s ≈ {fmt(t.naive_5s)}</span> : null}
            {view.stats?.chapters ? <span className="chip">{view.stats.chapters} capítulos · {view.stats.distinct_frames} planos · {view.stats.ocr_frames} con texto</span> : null}
          </div>
          {notes.length > 0 && <ul className="help mt-2 list-disc pl-5 text-[12px]">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {view.files?.overview && (
            <a href={api.videoDigest.fileUrl(linkId, "overview.jpg")} target="_blank" rel="noreferrer" className="mt-3 block">
              <img src={api.videoDigest.fileUrl(linkId, "overview.jpg")} alt="Mosaico de fotogramas con su tiempo" loading="lazy" style={{ maxHeight: 360, maxWidth: "100%", borderRadius: 6 }} />
            </a>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist">
            {TABS.map((x) => (
              <button key={x.level} type="button" role="tab" aria-selected={tab === x.level} className={`btn btn-sm${tab === x.level ? " btn-primary" : ""}`} onClick={() => setTab(x.level)}>{x.label}</button>
            ))}
            <button type="button" className="btn btn-sm" disabled={!text} onClick={copy}>Copiar</button>
          </div>
          <pre className="mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap rounded-md p-3 text-[13px]" style={{ background: "var(--panel, rgba(127,127,127,.08))" }} data-testid="digest-text">{text || "…"}</pre>
          <form onSubmit={ask} className="mt-4 flex flex-wrap items-center gap-2">
            <input className="field field-sm min-w-[240px] flex-1" placeholder="Pregúntale al vídeo (responde con citas y minuto)" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={asking || !question.trim()}>{asking ? "Pensando…" : "Preguntar"}</button>
          </form>
          {answer && (
            <div className="mt-3 text-[14px]" data-testid="digest-answer">
              {answer.sentences?.length ? answer.sentences.map((s, i) => (
                <p key={i} className="mb-2">
                  {s.text}{" "}
                  {s.citations.map((c) => (
                    <a key={`${c.ref}-${c.quote}`} className="chip mr-1 text-[11px]" href={api.videoDigest.frameUrl(linkId, c.start_s)} target="_blank" rel="noreferrer" title={`«${c.quote}»`}>
                      {c.time} · {c.kind === "screen" ? "pantalla" : "voz"}
                    </a>
                  ))}
                </p>
              )) : <p className="help">{answer.message || "El vídeo no responde a eso."}</p>}
              {answer.rejected_sentences ? <p className="help text-[12px]">Se descartaron {answer.rejected_sentences} frases con citas que no aparecen en el vídeo.</p> : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
