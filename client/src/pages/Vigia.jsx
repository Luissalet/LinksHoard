import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, Empty, useAction } from "../components/ui.jsx";

const KIND_LABEL = { feed: "Feed", github: "GitHub", page: "Página" };
const when = (iso) => (iso ? new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "nunca");

export default function Vigia() {
  const { notify, refresh } = useApp();
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [showSeen, setShowSeen] = useState(false);
  const [form, setForm] = useState({ url: "", kind: "auto", every_min: 60, tags: "", auto_save: true, github: "releases" });
  const [run, busy] = useAction(notify);

  const load = useCallback(async () => {
    try {
      const [w, it] = await Promise.all([api.watches.list(), api.watches.items({ unread: showSeen ? "0" : "1", limit: 100 })]);
      setData(w); setItems(it.items);
    } catch (e) { notify(e.message); }
  }, [showSeen, notify]);
  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    if (!form.url.trim()) return;
    const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const out = await run(() => api.watches.add({ ...form, tags, every_min: Number(form.every_min) || 60 }), "Vigilancia añadida.");
    if (out) { setForm({ ...form, url: "", tags: "" }); load(); refresh(); }
  };
  const check = async (id) => { const out = await run(() => (id ? api.watches.check(id) : api.watches.checkDue()), "Comprobado."); if (out) { load(); refresh(); } };
  const toggle = async (w) => { await run(() => api.watches.update(w.id, { enabled: !w.enabled })); load(); };
  const remove = async (w) => { if (!confirm(`¿Dejar de seguir «${w.name || w.url}»? Sus enlaces guardados se quedan.`)) return; await run(() => api.watches.remove(w.id), "Vigilancia quitada."); load(); };
  const dismiss = async (item) => { await run(() => api.watches.dismiss(item.id, !item.dismissed)); load(); };

  return (
    <Page title="Vigía" description="Feeds, repositorios de GitHub y páginas que se comprueban solos: lo nuevo llega como novedades y, si quieres, como enlaces guardados." actions={<button type="button" className="btn" onClick={() => check(null)} disabled={busy}>Comprobar pendientes</button>}>
      <Section title="Seguir algo nuevo">
        <form onSubmit={add} className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_1fr] md:items-end">
          <Field label="URL" help="Un feed RSS/Atom, un repositorio de GitHub o cualquier página (se detecta solo).">
            <input className="field" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://github.com/anomalyco/opencode" />
          </Field>
          <Field label="Tipo">
            <select className="field" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="auto">Automático</option><option value="feed">Feed</option><option value="github">GitHub</option><option value="page">Página (cambios)</option>
            </select>
          </Field>
          <Field label="Cada (min)"><input className="field" type="number" min="5" value={form.every_min} onChange={(e) => setForm({ ...form, every_min: e.target.value })} /></Field>
          <Field label="Etiquetas"><input className="field" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="releases, ia" /></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.auto_save} onChange={(e) => setForm({ ...form, auto_save: e.target.checked })} /> Guardar cada novedad como enlace</label>
          {(form.kind === "github" || /github\.com\//.test(form.url)) && (
            <Field label="De GitHub, seguir">
              <select className="field" value={form.github} onChange={(e) => setForm({ ...form, github: e.target.value })}>
                <option value="releases">Releases</option><option value="tags">Tags</option><option value="commits">Commits</option>
              </select>
            </Field>
          )}
          <div><button type="submit" className="btn btn-primary" disabled={busy}>Seguir</button></div>
        </form>
      </Section>

      <Section title={`Vigilancias${data ? ` (${data.stats.enabled}/${data.stats.watches} activas)` : ""}`} className="mt-4">
        {data && data.watches.length === 0 && <Empty text="Todavía no sigues nada." />}
        {data && data.watches.map((w) => (
          <div key={w.id} className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2 ${w.enabled ? "" : "opacity-60"}`}>
            <div className="min-w-0">
              <div className="truncate font-medium">{w.name || w.url} <span className="help text-[11px]">· {KIND_LABEL[w.kind] || w.kind} · cada {w.every_min} min · {w.item_count} novedades{w.auto_save ? " · guarda" : ""}</span></div>
              <div className="help truncate text-[12px]">{w.url} · última comprobación {when(w.last_check_at)}{w.last_error ? <span style={{ color: "var(--danger)" }}> · {w.last_error}</span> : ""}</div>
            </div>
            <div className="flex gap-1">
              <button type="button" className="btn btn-sm" onClick={() => check(w.id)} disabled={busy}>Comprobar</button>
              <button type="button" className="btn btn-sm" onClick={() => toggle(w)}>{w.enabled ? "Pausar" : "Reanudar"}</button>
              <button type="button" className="btn btn-sm" onClick={() => remove(w)}>Quitar</button>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Novedades" aside={<label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={showSeen} onChange={(e) => setShowSeen(e.target.checked)} /> ver también las vistas</label>} className="mt-4">
        {items.length === 0 && <Empty text="Nada nuevo por ahora." />}
        {items.map((it) => (
          <div key={it.id} className={`flex flex-wrap items-start justify-between gap-2 border-b border-[var(--line)] py-2 ${it.dismissed ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <div className="truncate font-medium">{it.link_id ? <a href={`#/link/${it.link_id}`}>{it.title || it.url}</a> : (it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title || it.url}</a> : it.title)}</div>
              {it.summary && <div className="help text-[12px]" style={{ whiteSpace: "pre-wrap" }}>{it.summary.slice(0, 300)}</div>}
              <div className="help text-[11px]">{when(it.published_at || it.seen_at)} · {(data?.watches.find((w) => w.id === it.watch_id) || {}).name || ""}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => dismiss(it)}>{it.dismissed ? "Marcar nueva" : "Visto"}</button>
          </div>
        ))}
      </Section>
    </Page>
  );
}
