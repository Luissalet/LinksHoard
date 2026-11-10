// Escuchar: one audio player for the whole app. It plays the narrated audio of a link, remembers where
// the listener stopped (saved on the server every few seconds, on pause and at the end), and when an audio
// ends it goes on with the next one of «Escuchar después».
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

const ListenContext = createContext(null);
export const useListen = () => useContext(ListenContext);
export const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
export const clock = (s) => { const t = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const SAVE_EVERY_S = 5;

export function ListenProvider({ notify, children }) {
  const audio = useRef(null);
  const [current, setCurrent] = useState(null);     // the view of the link in the player
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [queue, setQueue] = useState([]);
  const [rate, setRate] = useState(() => Number(localStorage.getItem("links.listen.rate")) || 1);
  const state = useRef({ id: null, savedAt: 0, resume: 0, waiting: null });
  const fail = useCallback((e) => notify?.({ kind: "error", text: e.message || String(e) }), [notify]);

  const refreshQueue = useCallback(async () => {
    try { const out = await api.listen.queue(); setQueue(out.queue); return out.queue; } catch { return []; }
  }, []);
  useEffect(() => { refreshQueue(); }, [refreshQueue]);

  const savePosition = useCallback((finished) => {
    const el = audio.current;
    const id = state.current.id;
    if (!el || !id || !Number.isFinite(el.currentTime)) return Promise.resolve();
    state.current.savedAt = el.currentTime;
    return api.listen.position(id, finished ? { position_s: el.currentTime, finished: true } : { position_s: el.currentTime, finished: false }).catch(() => {});
  }, []);

  const load = useCallback((view, { autoplay = true } = {}) => {
    const el = audio.current;
    if (!el) return;
    state.current.id = view.link_id;
    state.current.resume = view.finished ? 0 : Number(view.position_s) || 0;
    state.current.savedAt = state.current.resume;
    setCurrent(view);
    setTime(state.current.resume);
    setDuration(Number(view.duration_s) || 0);
    el.src = view.audio_url;
    el.playbackRate = rate;
    el.load();
    if (autoplay) el.play().catch(() => setPlaying(false));
  }, [rate]);

  /** Play a link: its audio if it exists, or ask for it and start when it is ready. */
  const play = useCallback(async (linkId, { restart = false } = {}) => {
    try {
      if (state.current.id && state.current.id !== linkId) await savePosition(false);
      clearInterval(state.current.waiting);
      let view = await api.listen.start(linkId, {});
      if (view.status === "done") { load(restart ? { ...view, position_s: 0 } : view); return view; }
      setCurrent(view);
      state.current.id = null;
      audio.current?.pause();
      state.current.waiting = setInterval(async () => {
        try {
          view = await api.listen.get(linkId);
          setCurrent((c) => (c && c.link_id === linkId ? view : c));
          if (view.status === "done") { clearInterval(state.current.waiting); load(view); refreshQueue(); }
          else if (!["queued", "running"].includes(view.status)) { clearInterval(state.current.waiting); if (view.error) fail(new Error(view.error)); }
        } catch (e) { clearInterval(state.current.waiting); fail(e); }
      }, 2000);
      return view;
    } catch (e) { fail(e); return null; }
  }, [load, savePosition, refreshQueue, fail]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el || !state.current.id) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }, []);
  const seek = useCallback((to) => {
    const el = audio.current;
    if (!el || !state.current.id) return;
    el.currentTime = Math.max(0, Math.min(Number.isFinite(el.duration) ? el.duration - 0.2 : to, to));
    setTime(el.currentTime);
  }, []);
  const skip = useCallback((delta) => { if (audio.current) seek(audio.current.currentTime + delta); }, [seek]);
  const changeRate = useCallback((value) => {
    setRate(value);
    localStorage.setItem("links.listen.rate", String(value));
    if (audio.current) audio.current.playbackRate = value;
  }, []);

  /** The next of «Escuchar después» after the one in the player (the first one when the player is empty). */
  const next = useCallback(async () => {
    const list = await refreshQueue();
    const at = list.findIndex((q) => q.link_id === state.current.id);
    const following = list.slice(at + 1).find((q) => q.status !== "failed") || null;
    if (following) return play(following.link_id);
    return null;
  }, [refreshQueue, play]);

  const close = useCallback(async () => {
    clearInterval(state.current.waiting);
    await savePosition(false);
    audio.current?.pause();
    audio.current?.removeAttribute("src");
    state.current.id = null;
    setCurrent(null);
    setPlaying(false);
  }, [savePosition]);

  const onEnded = useCallback(async () => {
    const list = queue;
    const at = list.findIndex((q) => q.link_id === state.current.id);
    const following = list.slice(at + 1).find((q) => q.status !== "failed") || (at < 0 ? list.find((q) => q.status !== "failed" && q.link_id !== state.current.id) : null);
    await savePosition(true);                       // heard: leaves the queue and is marked read
    setPlaying(false);
    await refreshQueue();
    window.dispatchEvent(new Event("links:listen-changed"));
    if (following) play(following.link_id);
    else setCurrent((c) => (c ? { ...c, finished: true, position_s: 0 } : c));
  }, [queue, savePosition, refreshQueue, play]);

  const onTime = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    setTime(el.currentTime);
    if (Math.abs(el.currentTime - state.current.savedAt) >= SAVE_EVERY_S) savePosition(false);
  }, [savePosition]);
  const onLoaded = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (Number.isFinite(el.duration)) setDuration(el.duration);
    if (state.current.resume > 0 && state.current.resume < (el.duration || Infinity) - 1) el.currentTime = state.current.resume;
    el.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const onHide = () => { if (state.current.id) savePosition(false); };
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); clearInterval(state.current.waiting); };
  }, [savePosition]);

  const value = useMemo(() => ({ current, playing, time, duration, queue, rate, play, toggle, seek, skip, next, close, changeRate, refreshQueue }),
    [current, playing, time, duration, queue, rate, play, toggle, seek, skip, next, close, changeRate, refreshQueue]);

  return (
    <ListenContext.Provider value={value}>
      {children}
      <audio ref={audio} preload="metadata" data-testid="listen-audio"
        onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); savePosition(false); }}
        onTimeUpdate={onTime} onLoadedMetadata={onLoaded} onEnded={onEnded}
        onError={() => { if (state.current.id) fail(new Error("No se pudo reproducir el audio.")); }} />
    </ListenContext.Provider>
  );
}

/** The player at the bottom of the app; hidden until something is played. */
export function ListenBar() {
  const { current, playing, time, duration, queue, rate, toggle, seek, skip, next, close, changeRate } = useListen();
  if (!current) return null;
  const ready = current.status === "done";
  const waiting = ["queued", "running"].includes(current.status);
  const at = queue.findIndex((q) => q.link_id === current.link_id);
  const hasNext = queue.slice(at + 1).some((q) => q.status !== "failed");
  return (
    <div className="listen-bar" role="region" aria-label="Reproductor" data-testid="listen-bar">
      <div className="listen-bar-inner">
        <a href={`#/link/${current.link_id}`} className="min-w-0 flex-1 truncate text-[13px] font-semibold hover:underline" title={current.title}>{current.title || current.url}</a>
        {waiting && (
          <span className="flex items-center gap-2 text-[12px]" data-testid="listen-bar-progress">
            <span className="help">Preparando el audio… {Math.round((current.progress || 0) * 100)} %</span>
          </span>
        )}
        {current.status === "failed" && <span className="chip chip-danger">No se pudo generar</span>}
        {ready && (
          <>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => skip(-15)} aria-label="Retroceder 15 segundos" title="Retroceder 15 s">−15</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={toggle} data-testid="listen-toggle" aria-label={playing ? "Pausar" : "Reproducir"}>{playing ? "Pausa" : "Reproducir"}</button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => skip(30)} aria-label="Avanzar 30 segundos" title="Avanzar 30 s">+30</button>
            <input type="range" className="listen-seek" min="0" max={Math.max(1, Math.round(duration))} step="1" value={Math.min(Math.round(time), Math.round(duration) || 1)}
              onChange={(e) => seek(Number(e.target.value))} aria-label="Posición" data-testid="listen-seek" />
            <span className="help shrink-0 tabular-nums text-[12px]" data-testid="listen-time">{clock(time)} / {clock(duration)}</span>
            <select className="field field-sm listen-rate" value={rate} onChange={(e) => changeRate(Number(e.target.value))} aria-label="Velocidad">
              {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          </>
        )}
        {hasNext && <button type="button" className="btn btn-sm" onClick={next} data-testid="listen-next" title="Siguiente de Escuchar después">Siguiente</button>}
        <a href="#/escuchar" className="btn btn-sm" title="Escuchar después">Cola{queue.length ? ` · ${queue.length}` : ""}</a>
        <button type="button" className="btn btn-sm btn-icon" onClick={close} aria-label="Cerrar el reproductor">✕</button>
      </div>
    </div>
  );
}
