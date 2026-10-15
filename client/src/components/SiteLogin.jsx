import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// "Iniciar sesión con…": Links opens a browser window on the computer it runs on, the person signs in there, and the session is
// saved for downloads (server/site-login.js). These components show the button, follow the window and offer "Ya he terminado".

const RUNNING = ["opening", "waiting", "signing", "capturing"];

/** Follows GET /api/sessions while a login window is open (every 1.5 s), otherwise loads it once. */
export function useSessions() {
  const [data, setData] = useState(null);
  const timer = useRef(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const out = await api.sessions.list();
      if (alive.current) setData(out);
      return out;
    } catch { return null; }
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, [load]);
  const running = !!(data?.active && RUNNING.includes(data.active.state));
  useEffect(() => {
    clearTimeout(timer.current);
    if (running) timer.current = setTimeout(load, 1500);
    return () => clearTimeout(timer.current);
  }, [running, data, load]);
  return { data, setData, load, running };
}

function WindowStatus({ active, onFinish, onCancel, busy }) {
  if (!active) return null;
  const running = RUNNING.includes(active.state);
  const tone = active.state === "saved" ? "var(--ok-ink, #1f7a3a)" : ["failed", "expired"].includes(active.state) ? "var(--danger-ink)" : "var(--muted)";
  return (
    <div className="mt-2 text-[12.5px]" role="status" aria-live="polite">
      <p style={{ color: tone }}>{active.detail || active.state}</p>
      {running && active.open && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button type="button" className="btn btn-sm" onClick={onFinish} disabled={busy}>Ya he terminado</button>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cerrar la ventana</button>
        </div>
      )}
    </div>
  );
}

/**
 * The button for one site ({ site, label } from a failed download or digest). onSaved runs once the site's session is saved (the
 * download page retries the download with it).
 */
export function LoginButton({ login, onSaved, className = "" }) {
  const { data, setData, running } = useSessions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asked, setAsked] = useState(false);
  const fired = useRef(false);
  const active = data?.active && data.active.site === login.site ? data.active : null;
  const signed = data?.sites?.find((s) => s.id === login.site)?.logged_in;

  useEffect(() => {
    if (asked && active?.state === "saved" && !fired.current) { fired.current = true; onSaved?.(); }
  }, [asked, active?.state, onSaved]);

  const act = async (fn) => {
    setBusy(true); setError("");
    try { setData(await fn()); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const start = () => { fired.current = false; setAsked(true); return act(() => api.sessions.login(login.site)); };

  return (
    <div className={className}>
      {!(active && running) && (
        <button type="button" className="btn btn-sm btn-primary" onClick={start} disabled={busy}>
          {signed ? `Volver a iniciar sesión con ${login.label}` : `Iniciar sesión con ${login.label}`}
        </button>
      )}
      {!active && !error && (
        <p className="help mt-1 text-[12px]">Se abre una ventana del navegador en el ordenador donde corre Links; inicia sesión allí y se guarda sola.</p>
      )}
      <WindowStatus active={active} busy={busy} onFinish={() => act(api.sessions.finish)} onCancel={() => act(api.sessions.cancel)} />
      {error && <p className="mt-1 text-[12.5px]" style={{ color: "var(--danger-ink)" }}>{error}</p>}
    </div>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "");

/** Ajustes → Descargas: every site with its state and its buttons. */
export function SessionsPanel({ notify }) {
  const { data, setData, running } = useSessions();
  const [busy, setBusy] = useState(false);
  const act = async (fn, ok) => {
    setBusy(true);
    try { setData(await fn()); if (ok) notify?.({ kind: "ok", text: ok }); } catch (e) { notify?.({ kind: "error", text: e.message }); } finally { setBusy(false); }
  };
  if (!data) return <p className="help">Cargando sesiones…</p>;
  const active = data.active;
  return (
    <div>
      <p className="help mb-2 text-[12.5px]">
        Los vídeos públicos se descargan sin cuenta. Para contenido privado, con restricción de edad o cuando un sitio exige iniciar sesión,
        pulsa «Iniciar sesión»: se abre {data.browser ? data.browser.name : "el navegador"} en este ordenador con un perfil propio de Links,
        inicias sesión como siempre y la sesión se guarda sola (la ventana se cierra al terminar). Tu perfil de siempre no se toca.
      </p>
      {data.browsers?.length > 0 && (
        <label className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
          <span>Navegador para iniciar sesión</span>
          <select className="field field-sm w-auto" value={data.choice || "auto"} disabled={busy || running}
            onChange={(e) => act(() => api.sessions.setBrowser(e.target.value), "Navegador guardado.")}>
            <option value="auto">El predeterminado{data.default_browser ? ` (${data.default_browser.name}${data.default_browser.usable ? "" : ", no sirve: uso otro"})` : ""}</option>
            {data.browsers.map((b) => <option key={b.name} value={b.name}>{b.name}{b.default ? " (predeterminado)" : ""}</option>)}
          </select>
          <span className="help text-[11.5px]">Cada navegador guarda sus propias sesiones: al cambiar, vuelve a iniciar sesión.</span>
        </label>
      )}
      {!data.browser && <p className="mb-2 text-[12.5px]" style={{ color: "var(--danger-ink)" }}>No encontré Brave, Chrome, Edge, Vivaldi ni Chromium en este equipo.</p>}
      {active && <div className="mb-2 rounded-md border p-2" style={{ borderColor: "var(--field-line)" }}><span className="font-semibold text-[13px]">{active.label}</span>
        <WindowStatus active={active} busy={busy} onFinish={() => act(api.sessions.finish)} onCancel={() => act(api.sessions.cancel)} /></div>}
      <ul className="grid gap-1 sm:grid-cols-2">
        {data.sites.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5" style={{ borderColor: "var(--field-line)" }}>
            <div className="min-w-0">
              <span className="text-[13px] font-semibold">{s.label}</span>
              <span className={`chip ml-2 ${s.logged_in ? "chip-ok" : ""}`}>{s.logged_in ? "Sesión guardada" : "Sin sesión"}</span>
              {s.logged_in && s.since && <span className="help ml-1 text-[11.5px]">desde {when(s.since)}</span>}
            </div>
            <div className="flex shrink-0 gap-1">
              <button type="button" className="btn btn-sm" disabled={busy || running || !data.browser} onClick={() => act(() => api.sessions.login(s.id))}>
                {s.logged_in ? "Renovar" : "Iniciar sesión"}
              </button>
              {s.logged_in && (
                <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => act(() => api.sessions.logout(s.id), `Sesión de ${s.label} cerrada en Links.`)}>Cerrar sesión</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
