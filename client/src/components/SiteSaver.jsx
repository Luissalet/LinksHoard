
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { useAction } from "./ui.jsx";

const STATUS_LABEL = { queued: "En cola", running: "Guardando", done: "Terminado", cancelled: "Cancelado", interrupted: "Interrumpido", failed: "Fallido" };
const ITEM_LABEL = { saved: "guardada", existing: "ya la tenías", failed: "error", robots: "bloqueada por robots.txt" };
const splitList = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** "Guardar sitio completo": map a site or section, pick the pages, crawl them in the background and watch the progress. */
export default function SiteSaver({ notify, initialUrl = "", onSaved, onClose }) {
  const [url, setUrl] = useState(initialUrl);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [wholeSite, setWholeSite] = useState(false);
  const [limit, setLimit] = useState(50);
  const [tags, setTags] = useState("");
  const [map, setMap] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [filter, setFilter] = useState("");
  const [job, setJob] = useState(null);
  const [run, busy] = useAction(notify);
  const timer = useRef(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (map?.urls || []).filter((u) => !q || u.url.toLowerCase().includes(q) || (u.title || "").toLowerCase().includes(q));
  }, [map, filter]);

  const doMap = async (e) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setJob(null);
    const out = await run(() => api.site.map({
      url: url.trim(), include: splitList(include), exclude: splitList(exclude), ...(wholeSite ? { path_prefix: "/" } : {}), limit: 1000,
    }), null);
    if (out) {
      setMap(out);
      setPicked(new Set(out.urls.filter((u) => !u.saved).map((u) => u.url)));
    }
  };

  const toggle = (u) => setPicked((prev) => { const next = new Set(prev); if (next.has(u)) next.delete(u); else next.add(u); return next; });
  const setAll = (list, on) => setPicked((prev) => { const next = new Set(prev); for (const u of list) (on ? next.add(u.url) : next.delete(u.url)); return next; });

  const start = async () => {
    const urls = [...picked];
    if (!urls.length) return;
    const out = await run(() => api.site.crawl({ urls, limit: Math.min(Math.max(Number(limit) || 50, 1), 500), tags: splitList(tags), delay_ms: 500 }), null);
    if (out) setJob(out);
  };

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return undefined;
    timer.current = setTimeout(async () => {
      try {
        const next = await api.site.crawlGet(job.id);
        setJob(next);
        if (!["queued", "running"].includes(next.status)) {
          onSaved?.();
          notify({ kind: "ok", text: `Sitio guardado: ${next.saved} páginas nuevas.` });
        }
      } catch { /* the next tick tries again */ }
    }, 700);
    return () => clearTimeout(timer.current);
  }, [job, notify, onSaved]);

  const [history, setHistory] = useState([]);
  const loadHistory = async () => { try { setHistory((await api.site.crawls()).crawls || []); } catch { /* keep the last list */ } };
  const jobStatus = job?.status;
  useEffect(() => { loadHistory(); }, [jobStatus]);

  const cancel = () => run(async () => setJob(await api.site.crawlCancel(job.id)), null);
  const resume = () => run(async () => setJob(await api.site.crawlResume(job.id)), null);
  const openJob = (id) => run(async () => setJob(await api.site.crawlGet(id)), null);
  const resumeJob = (id) => run(async () => setJob(await api.site.crawlResume(id)), null);
  // removes the job record only: the pages it saved stay in the library
  const removeJob = (h) => run(async () => {
    await api.site.crawlDelete(h.id);
    if (job?.id === h.id) setJob(null);
    await loadHistory();
  }, `Rastreo quitado del historial; sus ${h.saved} páginas siguen en la biblioteca.`);
  const active = job && ["queued", "running"].includes(job.status);
  const pct = job ? Math.min(100, Math.round((job.done / Math.max(1, Math.min(picked.size || job.found, job.found || 1))) * 100)) : 0;

  return (
    <section className="panel mb-5" aria-label="Guardar sitio completo">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold">Guardar sitio completo</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>Cerrar</button>
      </div>
      <form onSubmit={doMap} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <label className="block"><span className="label">Web o sección</span>
          <input className="field" type="url" required placeholder="https://docs.python.org/3/howto/" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label className="block"><span className="label">Incluir (patrones)</span>
          <input className="field" placeholder="/3/howto/*" value={include} onChange={(e) => setInclude(e.target.value)} /></label>
        <label className="block"><span className="label">Excluir</span>
          <input className="field" placeholder="**/old/**, *.pdf" value={exclude} onChange={(e) => setExclude(e.target.value)} /></label>
        <button type="submit" className="btn btn-primary" disabled={busy}>Buscar páginas</button>
      </form>
      <label className="help mt-2 flex items-center gap-2">
        <input type="checkbox" checked={wholeSite} onChange={(e) => setWholeSite(e.target.checked)} />
        Todo el dominio (si no, solo la carpeta de esa dirección)
      </label>

      {map && (
        <div className="mt-4">
          <p className="help mb-2">
            {map.total} páginas en {map.host}{map.path_prefix !== "/" ? ` · ${map.path_prefix}` : ""} (sitemap {map.sources.sitemap}, enlaces {map.sources.link})
            {map.blocked_by_robots ? ` · ${map.blocked_by_robots} bloqueadas por robots.txt` : ""}
            {map.robots.crawl_delay ? ` · Crawl-delay ${map.robots.crawl_delay}s` : ""}
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input className="field field-sm max-w-[260px]" placeholder="Filtrar la lista" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => setAll(visible, true)}>Marcar visibles</button>
            <button type="button" className="btn btn-sm" onClick={() => setAll(visible, false)}>Desmarcar visibles</button>
            <span className="help">{picked.size} marcadas</span>
          </div>
          <ul className="max-h-[320px] overflow-auto rounded-lg border" style={{ borderColor: "var(--line)" }} data-testid="map-list">
            {visible.map((u) => (
              <li key={u.url} className="flex items-start gap-2 border-b px-3 py-1.5 text-[13px] last:border-b-0" style={{ borderColor: "var(--line)" }}>
                <input type="checkbox" className="mt-1" checked={picked.has(u.url)} onChange={() => toggle(u.url)} aria-label={u.url} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{u.title || u.url.replace(/^https?:\/\//, "")}</span>
                  <span className="help block truncate">{u.url}</span>
                </span>
                {u.saved && <span className="chip">ya guardada</span>}
              </li>
            ))}
            {!visible.length && <li className="help px-3 py-3">Ninguna página coincide.</li>}
          </ul>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block"><span className="label">Máximo de páginas nuevas</span>
              <input className="field field-sm w-[110px]" type="number" min="1" max="500" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
            <label className="block"><span className="label">Etiquetas extra</span>
              <input className="field field-sm" placeholder="docs, python" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
            <button type="button" className="btn btn-primary" disabled={busy || active || !picked.size} onClick={start}>Guardar {picked.size} páginas</button>
          </div>
        </div>
      )}

      {job && (
        <div className="mt-4" data-testid="crawl-progress">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span><strong>{STATUS_LABEL[job.status] || job.status}</strong> · {job.saved} guardadas · {job.skipped} omitidas · {job.failed} con error · {job.done}/{job.found}</span>
            <span className="flex gap-2">
              {active && <button type="button" className="btn btn-sm" onClick={cancel}>Cancelar</button>}
              {["cancelled", "interrupted", "failed"].includes(job.status) && <button type="button" className="btn btn-sm" onClick={resume}>Reanudar</button>}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded" style={{ background: "var(--soft)" }}>
            <div className="h-2 rounded" style={{ width: `${pct}%`, background: "var(--accent)", transition: "width .3s" }} />
          </div>
          {job.current && <p className="help mt-1 truncate">{job.current}</p>}
          {job.results && !active && (
            <ul className="mt-2 max-h-[200px] overflow-auto text-[12px]">
              {job.results.slice(-60).map((r, i) => (
                <li key={i} className="truncate"><span className="chip mr-2">{ITEM_LABEL[r.status] || r.status}</span>{r.title || r.url}{r.error ? ` · ${r.error}` : ""}</li>
              ))}
            </ul>
          )}
          {job.status === "done" && <p className="help mt-2">Las páginas están en la biblioteca con la etiqueta <code>{job.tag}</code>.</p>}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4" data-testid="crawl-history">
          <h3 className="label mb-1">Rastreos anteriores</h3>
          <p className="help mb-2">Quitar borra solo el registro del rastreo; las páginas que guardó siguen en la biblioteca.</p>
          <ul className="max-h-[220px] overflow-auto rounded-lg border text-[13px]" style={{ borderColor: "var(--line)" }}>
            {history.map((h) => {
              const busyJob = ["queued", "running"].includes(h.status);
              return (
                <li key={h.id} className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 last:border-b-0" style={{ borderColor: "var(--line)" }}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{h.start_url}</span>
                    <span className="help block">{STATUS_LABEL[h.status] || h.status} · {h.saved} guardadas · {(h.created_at || "").slice(0, 16).replace("T", " ")} · <code>{h.tag}</code></span>
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => openJob(h.id)}>Ver</button>
                  {["cancelled", "interrupted", "failed"].includes(h.status) && <button type="button" className="btn btn-sm" onClick={() => resumeJob(h.id)}>Reanudar</button>}
                  <button type="button" className="btn btn-sm" disabled={busy || busyJob} title={busyJob ? "Cancélalo antes de quitarlo" : "Quita el registro; las páginas guardadas se quedan"}
                    onClick={() => removeJob(h)} aria-label={`Quitar rastreo ${h.tag}`}>Quitar</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
