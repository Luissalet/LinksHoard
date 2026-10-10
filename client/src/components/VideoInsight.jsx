import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const STATUS_TEXT = {
  none: "Todavía sin analizar.",
  queued: "En cola para analizar…",
  running: "Analizando el vídeo…",
  done: "Análisis completo.",
  partial: "Análisis parcial: falta una parte.",
  failed: "El análisis falló.",
  no_source: "No hay archivo de vídeo para este enlace.",
};
const TRANSCRIPT_TEXT = {
  skipped: "Sin motor de transcripción disponible (ni Funes ni faster-whisper). Se reintentará solo.",
  failed: "La transcripción falló.",
  no_audio: "El vídeo no tiene audio.",
  no_speech: "No se detectó voz.",
  pending: "Pendiente.",
};

/** Transcript with timestamps and the strip of key frames of a saved video link (see server/videoinsight.js). */
export default function VideoInsight({ linkId, kind, notify }) {
  const [view, setView] = useState(null);
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(null);
  const [open, setOpen] = useState(false);
  const fileRef = useRef(null);
  const segRefs = useRef({});

  const load = useCallback(async () => {
    try { setView(await api.links.video(linkId)); } catch { /* the page keeps working without it */ }
  }, [linkId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!view || !["queued", "running"].includes(view.status)) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [view, load]);

  if (!view) return null;
  if (view.status === "none" && kind !== "video" && !view.video_candidate) return null;

  const act = async (fn, okText) => {
    setBusy(true);
    try { const out = await fn(); setView(out); if (okText) notify({ kind: "ok", text: okText }); } catch (e) { notify({ kind: "error", text: e.message }); } finally { setBusy(false); }
  };
  const analyze = (extra = {}) => act(() => api.links.analyzeVideo(linkId, extra), "Análisis en cola.");
  const onFile = (e) => { const file = e.target.files?.[0]; if (file) act(() => api.links.uploadVideo(linkId, file), "Archivo recibido: analizando."); e.target.value = ""; };

  const frames = view.frames?.items || [];
  const segments = view.transcript?.segments || [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? segments.filter((s) => s.text.toLowerCase().includes(needle)) : segments;
  const goTo = (frame) => {
    setActive(frame.index);
    const near = segments.find((s) => s.end_s >= frame.t_s) || segments[segments.length - 1];
    if (near) segRefs.current[near.index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const running = ["queued", "running"].includes(view.status);

  return (
    <section className="mt-8 border-t pt-6" style={{ borderColor: "var(--line)" }} data-testid="video-insight">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold">Vídeo: transcripción y fotogramas</h2>
        <span className="flex items-center gap-2">
          {view.status === "done" || view.status === "partial" || view.status === "failed" ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => analyze({ force: true })}>Volver a analizar</button> : null}
          <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => fileRef.current?.click()}>Adjuntar archivo</button>
          <input ref={fileRef} type="file" accept="video/*,audio/*" className="hidden" onChange={onFile} />
        </span>
      </div>
      <p className="help mt-2">
        {STATUS_TEXT[view.status] || view.status}
        {view.detail && view.status !== "done" && <> {view.detail}</>}
        {view.next_retry_at && <> Próximo reintento: {new Date(view.next_retry_at).toLocaleTimeString()}.</>}
        {view.duration_s ? <> · {Math.round(view.duration_s)} s</> : null}
        {view.transcript?.via ? <> · transcrito con {view.transcript.via}{view.transcript.language ? ` (${view.transcript.language})` : ""}</> : null}
      </p>

      {(view.status === "none" || view.status === "no_source") && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="field field-sm min-w-[220px] flex-1" placeholder="Ruta de un archivo de vídeo en este equipo (opcional)" value={path} onChange={(e) => setPath(e.target.value)} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !path.trim()} onClick={() => analyze({ path: path.trim() })}>Analizar archivo</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => analyze({ download: true })} title="Descarga el vídeo con el descargador de la app y lo analiza">Descargar y analizar</button>
        </div>
      )}

      {frames.length > 0 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-2" data-testid="frame-strip">
          {frames.map((f) => (
            <button key={f.index} type="button" onClick={() => goTo(f)} className="shrink-0 text-left" aria-label={`Fotograma en ${f.time}`}
              style={{ outline: active === f.index ? "2px solid var(--accent, #2f6fed)" : "none", borderRadius: 6 }}>
              <img src={f.url} alt={`Fotograma ${f.time}`} loading="lazy" style={{ height: 92, width: "auto", borderRadius: 6, display: "block" }} />
              <span className="help text-[11px]">{f.time}{f.reason === "scene" ? " · escena" : ""}</span>
            </button>
          ))}
        </div>
      )}

      {view.transcript?.status && view.transcript.status !== "done" && TRANSCRIPT_TEXT[view.transcript.status] && view.status !== "none" && view.status !== "no_source" && (
        <p className="help mt-3">{TRANSCRIPT_TEXT[view.transcript.status]}{view.transcript.error ? ` (${view.transcript.error})` : ""}</p>
      )}

      {segments.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "Ocultar transcripción" : `Ver transcripción (${view.transcript.word_count} palabras)`}</button>
            {open && <input className="field field-sm w-[200px]" placeholder="Buscar en la transcripción…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          </div>
          {open && (
            <ol className="mt-3 max-h-[420px] space-y-1 overflow-y-auto" data-testid="transcript">
              {shown.map((s) => (
                <li key={s.index} ref={(el) => { segRefs.current[s.index] = el; }} className="flex gap-3 text-[14px]">
                  <span className="help w-[52px] shrink-0 text-right tabular-nums">{s.time}</span>
                  <span>{s.text}</span>
                </li>
              ))}
              {shown.length === 0 && <li className="help">Nada coincide.</li>}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}