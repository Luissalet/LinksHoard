import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useAction, ConfirmDialog } from "./ui.jsx";
import { useListen, clock } from "../listen.jsx";

const SOURCE = { article: "el texto del artículo", video_digest: "el resumen del vídeo digerido" };

/** «Escuchar» in the reader: make the audio of this link, play or resume it, and put it in «Escuchar después». */
export default function ListenPanel({ linkId, notify }) {
  const player = useListen();
  const [view, setView] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [run, busy] = useAction(notify);

  const load = useCallback(async () => { try { setView(await api.listen.get(linkId)); } catch { setView(null); } }, [linkId]);
  useEffect(() => { load(); }, [load]);
  const active = view && ["queued", "running"].includes(view.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active, load]);
  // what the player does elsewhere (finishes, leaves the queue) shows here too
  useEffect(() => {
    window.addEventListener("links:listen-changed", load);
    return () => window.removeEventListener("links:listen-changed", load);
  }, [load]);

  if (!view) return null;
  const here = player.current?.link_id === linkId;
  const ready = view.status === "done";
  const position = here ? player.time : view.position_s || 0;
  const listen = async () => { await player.play(linkId); load(); };
  const fromStart = async () => { await player.play(linkId, { restart: true }); load(); };
  const later = async () => {
    const out = await run(() => (view.queued ? api.listen.queueRemove(linkId) : api.listen.queueAdd(linkId)), view.queued ? "Quitado de Escuchar después." : "Añadido a Escuchar después.");
    if (out) { player.refreshQueue(); load(); }
  };
  const regenerate = async () => { if (await run(() => api.listen.start(linkId, { regenerate: true }), "Generando el audio de nuevo.")) load(); };
  const remove = async () => {
    setConfirm(false);
    if (here) await player.close();
    if (await run(() => api.listen.remove(linkId), "Audio borrado.")) { player.refreshQueue(); load(); }
  };

  return (
    <section className="listen-panel" aria-label="Escuchar" data-testid="listen-panel" data-status={view.status}>
      <div className="flex flex-wrap items-center gap-2">
        {ready ? (
          here && player.playing
            ? <button type="button" className="btn btn-sm btn-primary" onClick={player.toggle} data-testid="listen-play">Pausar</button>
            : <button type="button" className="btn btn-sm btn-primary" onClick={here ? player.toggle : listen} data-testid="listen-play">
              {position > 1 ? `Reanudar desde ${clock(position)}` : "Escuchar"}
            </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={listen} disabled={busy || active} data-testid="listen-play">
            {active ? "Preparando el audio…" : view.status === "failed" ? "Reintentar el audio" : "Escuchar"}
          </button>
        )}
        {ready && position > 1 && <button type="button" className="btn btn-sm" onClick={fromStart}>Desde el principio</button>}
        <button type="button" className="btn btn-sm" onClick={later} disabled={busy} data-testid="listen-later">{view.queued ? "Quitar de Escuchar después" : "Escuchar después"}</button>
        {ready && <button type="button" className="btn btn-sm" onClick={regenerate} disabled={busy}>Volver a generar</button>}
        {(ready || view.status === "failed") && <button type="button" className="btn btn-sm" onClick={() => setConfirm(true)} disabled={busy}>Borrar audio</button>}
        {ready && (
          <span className="help text-[12px]" data-testid="listen-info">
            {view.duration} · {view.finished ? "escuchado" : `${here && player.duration ? Math.round((player.time / player.duration) * 100) : view.percent} %`} · voz {view.voice}
          </span>
        )}
      </div>
      {active && (
        <div className="mt-3" data-testid="listen-progress">
          <div className={`progress ${view.progress ? "" : "progress-indeterminate"}`}><span style={{ width: `${Math.round((view.progress || 0) * 100)}%` }} /></div>
          <p className="help mt-1 text-[12px]">Prospero's Hoard está leyendo {SOURCE[view.source] || "el texto"} ({Math.round((view.progress || 0) * 100)} %){view.detail ? ` · ${view.detail}` : ""}. Puedes seguir leyendo: empezará a sonar al terminar si lo pediste con Escuchar.</p>
        </div>
      )}
      {view.status === "failed" && <p className="mt-2 text-[13px]" style={{ color: "var(--danger-ink)" }} role="alert">{view.error}</p>}
      {ready && view.source === "video_digest" && <p className="help mt-2 text-[12px]">Se lee el resumen y los capítulos del vídeo digerido, no la página.</p>}
      {ready && view.stale && <p className="help mt-2 text-[12px]">El texto ha cambiado desde que se generó este audio. «Volver a generar» lo actualiza.</p>}
      <ConfirmDialog open={confirm} title="Borrar el audio" text="Se borra el audio de este enlace y dónde ibas. El enlace y su texto se quedan." confirmLabel="Borrar audio" onConfirm={remove} onCancel={() => setConfirm(false)} />
    </section>
  );
}
