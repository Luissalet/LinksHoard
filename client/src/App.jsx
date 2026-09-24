import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { Toast } from "./components/ui.jsx";
import Bandeja from "./pages/Bandeja.jsx";
import Todo from "./pages/Todo.jsx";
import Archivados from "./pages/Archivados.jsx";
import Favoritos from "./pages/Favoritos.jsx";
import Reader from "./pages/Reader.jsx";
import Ajustes from "./pages/Ajustes.jsx";
import Vigia from "./pages/Vigia.jsx";

const PAGES = [
  { path: "bandeja", label: "Bandeja", icon: "M4 4h16v6H4zM4 14h16v6H4z", component: Bandeja },
  { path: "todo", label: "Todo", icon: "M4 6h16M4 12h16M4 18h16", component: Todo },
  { path: "archivados", label: "Archivados", icon: "M3 5h18v4H3zM5 9v10h14V9M10 13h4", component: Archivados },
  { path: "favoritos", label: "Favoritos", icon: "M12 4l2.5 5.5L20 10l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z", component: Favoritos },
  { path: "vigia", label: "Vigía", icon: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 100 6 3 3 0 000-6z", component: Vigia },
  { path: "ajustes", label: "Ajustes", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2", component: Ajustes },
];

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

function useHashRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, "") || "bandeja";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function Icon({ d }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function App() {
  const route = useHashRoute();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const notify = useCallback((message) => setToast(message), []);
  const value = useMemo(() => ({ ...(state || {}), ready: !!state, refresh, notify }), [state, refresh, notify]);

  const readerMatch = route.match(/^link\/(.+)$/);
  const page = PAGES.find((p) => p.path === route) || PAGES[0];
  const Component = readerMatch ? Reader : page.component;
  const activePath = readerMatch ? null : page.path;

  return (
    <AppContext.Provider value={value}>
      <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="sticky top-0 z-10 border-b md:h-dvh md:border-b-0 md:border-r" style={{ background: "var(--sidebar)", borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2 px-4 py-3 md:px-5 md:py-5">
            <span className="grid h-8 w-8 place-items-center rounded-md text-[15px] font-bold text-white" style={{ background: "var(--accent)", fontFamily: "Georgia, serif" }}>L</span>
            <div className="leading-tight">
              <div className="text-[15px] font-semibold">Links Hoard</div>
              <div className="help text-[11px]">Bandeja de lectura</div>
            </div>
          </div>
          <nav aria-label="Secciones" className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:px-3">
            {PAGES.map((p) => (
              <a key={p.path} href={`#/${p.path}`} className="nav-link shrink-0 text-[13px]" aria-current={p.path === activePath ? "page" : undefined}>
                <Icon d={p.icon} />
                {p.label}
                {p.path === "bandeja" && state?.stats?.unread > 0 && <span className="help ml-auto text-[11px]">{state.stats.unread}</span>}
              </a>
            ))}
          </nav>
          {state?.tags?.length > 0 && (
            <div className="hidden px-5 py-3 md:block">
              <div className="label mb-2">Etiquetas</div>
              <div className="flex flex-wrap gap-1.5">
                {state.tags.slice(0, 12).map((t) => (
                  <a key={t.tag} href={`#/todo?tag=${encodeURIComponent(t.tag)}`} className="chip hover:opacity-80">{t.tag} · {t.count}</a>
                ))}
              </div>
            </div>
          )}
        </aside>
        <main className="min-w-0">
          {error && (
            <div className="m-4 rounded-md border p-4 text-[13px]" style={{ background: "var(--danger-bg)", color: "var(--danger-ink)", borderColor: "var(--danger-line)" }} role="alert">
              No se pudo cargar el estado: {error}. <button type="button" className="btn-link" onClick={refresh}>Reintentar</button>
            </div>
          )}
          {state ? <Component key={route} linkId={readerMatch?.[1]} /> : !error && <p className="help p-8">Cargando…</p>}
        </main>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </AppContext.Provider>
  );
}
