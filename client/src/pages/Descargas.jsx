import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, Empty, useAction } from "../components/ui.jsx";
import { formatBytes, formatDate, formatDuration } from "../format.js";

const STATUS = {
  queued: { label: "En cola", chip: "chip" },
  downloading: { label: "Descargando", chip: "chip chip-accent" },
  processing: { label: "Procesando", chip: "chip chip-accent" },
  done: { label: "Listo", chip: "chip chip-ok" },
  failed: { label: "Fallida", chip: "chip chip-danger" },
  cancelled: { label: "Cancelada", chip: "chip chip-warn" },
};
const ACTIVE = ["queued", "downloading", "processing"];
const HOW = { env: "variable de entorno", path: "PATH", sibling: "carpeta de Writers Hoard", "python-module": "módulo de Python", imageio: "imageio-ffmpeg" };

function Player({ item, index }) {
  const file = item.files[index];
  if (!file) return null;
  const src = api.media.fileUrl(item.id, index);
  if (file.kind === "video") return <video className="mt-2 max-h-[420px] w-full rounded-md bg-black" controls preload="metadata" src={src} />;
  if (file.kind === "audio") return <audio className="mt-2 w-full" controls preload="metadata" src={src} />;
  if (file.kind === "image") return <img className="mt-2 max-h-[420px] rounded-md" src={src} alt={file.name} loading="lazy" />;
  return <a className="btn-link mt-2 inline-block text-[13px]" href={`${src}&download=1`}>Descargar {file.name}</a>;
}

function Item({ item, onChange, run, busy }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const active = ACTIVE.includes(item.status);
  const st = STATUS[item.status] || STATUS.queued;
  const indeterminate = item.status === "queued" || (item.kind === "image" && item.status === "downloading") || (item.status === "downloading" && !item.progress);

  const cancel = async () => { await run(() => api.media.cancel(item.id), "Cancelando…"); onChange(); };
  const retry = async () => { await run(() => api.media.retry(item.id), "Descarga en cola de nuevo."); onChange(); };
  const reveal = async () => { await run(() => api.media.reveal(item.id, index)); };
  const remove = async (files) => {
    const text = files
      ? "Se borrarán del disco los archivos descargados (no hay papelera). ¿Seguir?"
      : "Se quita de la lista; los archivos descargados se quedan en el disco.";
    if (!window.confirm(text)) return;
    await run(() => api.media.remove(item.id, files), files ? "Archivos borrados." : "Quitada de la lista.");
    onChange();
  };

  return (
    <li className="border-b border-[var(--line)] py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip">{item.platform}</span>
            <span className={st.chip}>{st.label}</span>
            {item.kind && <span className="chip">{{ video: "Vídeo", audio: "Audio", image: "Fotos" }[item.kind] || item.kind}</span>}
            <span className="truncate font-semibold text-[14px]">{item.title || item.url}</span>
          </div>
          <div className="help mt-0.5 truncate text-[12px]">
            {item.uploader && <>{item.uploader} · </>}
            {item.duration ? <>{formatDuration(item.duration)} · </> : null}
            {item.total_bytes ? <>{formatBytes(item.total_bytes)} · </> : null}
            {item.files.length > 1 ? <>{item.files.length} archivos · </> : null}
            {formatDate(item.finished_at || item.created_at)}
            <> · <a href={item.url} target="_blank" rel="noreferrer" className="btn-link">{item.url}</a></>
          </div>
          {active && (
            <div className="mt-2 max-w-[560px]">
              <div className={`progress ${indeterminate ? "progress-indeterminate" : ""}`} role="progressbar" aria-valuenow={Math.round(item.progress)} aria-valuemin="0" aria-valuemax="100">
                <span style={{ width: `${Math.max(2, item.progress)}%` }} />
              </div>
              <div className="help mt-1 text-[12px]">
                {item.status === "queued" ? "Esperando su turno…" : `${item.detail || "Descargando…"}${item.progress ? ` ${Math.round(item.progress)} %` : ""}${item.speed ? ` · ${item.speed}` : ""}${item.eta ? ` · quedan ${item.eta}` : ""}`}
              </div>
            </div>
          )}
          {item.status === "failed" && <p className="mt-1 text-[12.5px]" style={{ color: "var(--danger-ink)" }}>{item.error}</p>}
          {item.status === "cancelled" && <p className="help mt-1 text-[12px]">Cancelada.</p>}
          {item.status === "done" && item.detail && <p className="help mt-1 text-[12px]">{item.detail}</p>}
          {item.status === "done" && item.cookies_browser && <p className="help mt-1 text-[12px]">Se usaron las cookies de: {item.cookies_browser}.</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          {item.status === "done" && item.files.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "Ocultar" : "Reproducir"}</button>}
          {item.files.length > 0 && <button type="button" className="btn btn-sm" onClick={reveal} disabled={busy}>Mostrar en carpeta</button>}
          {active && <button type="button" className="btn btn-sm" onClick={cancel} disabled={busy}>Cancelar</button>}
          {(item.status === "failed" || item.status === "cancelled") && <button type="button" className="btn btn-sm" onClick={retry} disabled={busy}>Reintentar</button>}
          {item.link_id && <a className="btn btn-sm" href={`#/link/${item.link_id}`}>Ver en la biblioteca</a>}
          {!active && <button type="button" className="btn btn-sm" onClick={() => remove(false)} disabled={busy}>Quitar</button>}
          {!active && item.files.length > 0 && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(true)} disabled={busy}>Borrar archivos</button>}
        </div>
      </div>
      {item.files.length > 0 && (
        <ul className="help mt-2 space-y-0.5 text-[12px]">
          {item.files.map((f, i) => (
            <li key={f.path} className="truncate">
              <button type="button" className="btn-link text-[12px]" onClick={() => { setIndex(i); setOpen(true); }} title={f.path}>{f.name}</button>
              {f.size ? <> · {formatBytes(f.size)}</> : null}
            </li>
          ))}
        </ul>
      )}
      {open && <Player item={item} index={index} />}
    </li>
  );
}

function Tools({ run, busy }) {
  const { notify } = useApp();
  const [tools, setTools] = useState(null);
  const load = useCallback(async () => {
    try { setTools(await api.media.tools(true)); } catch (e) { notify({ kind: "error", text: e.message }); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);

  const update = async () => {
    const out = await run(() => api.media.updateTools());
    if (out) {
      const lines = out.results.map((r) => (r.ok ? `${r.tool}: ${r.before || "—"} → ${r.after || "—"}${r.updated ? "" : " (ya estaba al día)"}` : `${r.tool}: ${r.error}`));
      notify({ kind: out.results.every((r) => r.ok) ? "ok" : "error", text: lines.join(" · ") });
      load();
    }
  };
  const rows = tools ? [["yt-dlp", tools.ytdlp, "vídeo y audio"], ["gallery-dl", tools.gallerydl, "fotos y carruseles"], ["ffmpeg", tools.ffmpeg, "unir, convertir a MP3 y H.264"]] : [];
  return (
    <Section title="Herramientas" aside={<button type="button" className="btn btn-sm" onClick={update} disabled={busy || !tools}>Actualizar</button>} className="mt-4">
      {!tools && <p className="help">Comprobando…</p>}
      {rows.map(([name, t, what]) => (
        <div key={name} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--line)] py-2 text-[13px]">
          <div><span className="font-semibold">{name}</span> <span className="help">· {what}</span></div>
          {t.found
            ? <div className="help" title={t.path}>{t.version || "versión desconocida"} · {HOW[t.how] || t.how}</div>
            : <div className="chip chip-danger">No encontrado</div>}
        </div>
      ))}
      {tools && rows.some(([, t]) => !t.found) && (
        <p className="help mt-3">Para instalar yt-dlp y gallery-dl: <code>{tools.install_command}</code>. ffmpeg: <code>winget install Gyan.FFmpeg</code> en Windows.</p>
      )}
      {tools && <p className="help mt-2">«Actualizar» ejecuta yt-dlp -U / gallery-dl -U, o pip install -U si funcionan como módulo de Python.</p>}
    </Section>
  );
}

export default function Descargas() {
  const { notify, refresh } = useApp();
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ url: "", format: "auto", quality: "best", save_link: true, playlist: false });
  const [settings, setSettings] = useState(null);
  const [run, busy] = useAction(notify);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await api.media.list({ limit: 100 });
      if (alive.current) setData(out);
    } catch (e) { if (alive.current) notify({ kind: "error", text: e.message }); }
  }, [notify]);

  useEffect(() => { alive.current = true; load(); api.media.settings().then(setSettings).catch(() => {}); return () => { alive.current = false; }; }, [load]);

  const hasActive = useMemo(() => !!data?.items.some((i) => ACTIVE.includes(i.status)), [data]);
  useEffect(() => {
    if (!hasActive) return undefined;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [hasActive, load]);

  // a finished download may have saved a link: keep the sidebar counters honest
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !hasActive) refresh();
    wasActive.current = hasActive;
  }, [hasActive, refresh]);

  const start = async (e) => {
    e.preventDefault();
    const url = form.url.trim();
    if (!url) return;
    const out = await run(() => api.media.start({ url, format: form.format, quality: form.quality, save_link: form.save_link, playlist: form.playlist }), null);
    if (out) {
      notify({ kind: "ok", text: out.existing ? "Esa descarga ya está en curso." : "Descarga en cola." });
      setForm({ ...form, url: "" });
      load();
    }
  };

  const videoish = form.format === "auto" || form.format === "video";
  const items = data?.items || [];

  return (
    <Page title="Descargas" description="Pega un enlace de YouTube, X, Instagram, TikTok, Audiomack u otro sitio: el vídeo, el audio o las fotos se guardan en tu disco.">
      <Section title="Descargar un enlace">
        <form onSubmit={start} className="grid gap-3 md:grid-cols-[3fr_1.4fr_1fr_auto] md:items-end">
          <Field label="Enlace">
            <input className="field" type="url" required placeholder="https://www.youtube.com/watch?v=…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          <Field label="Formato">
            <select className="field" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
              <option value="auto">Automático (vídeo o fotos)</option>
              <option value="video">Vídeo (MP4)</option>
              <option value="audio">Solo audio (MP3)</option>
              <option value="image">Fotos</option>
            </select>
          </Field>
          <Field label="Calidad">
            <select className="field" value={form.quality} onChange={(e) => setForm({ ...form, quality: e.target.value })} disabled={!videoish}>
              <option value="best">La mejor</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option>
            </select>
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy}>Descargar</button>
          <div className="flex flex-wrap gap-4 md:col-span-4">
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.save_link} onChange={(e) => setForm({ ...form, save_link: e.target.checked })} /> Guardar también en la biblioteca</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.playlist} onChange={(e) => setForm({ ...form, playlist: e.target.checked })} /> Si es una lista, descargarla entera (hasta 50)</label>
          </div>
        </form>
        {settings && <p className="help mt-3">Se guardan en <code>{settings.dir}</code>. Puedes cambiar la carpeta en <a className="btn-link" href="#/ajustes">Ajustes</a>.</p>}
      </Section>

      <Section title={`Cola y descargas${data ? ` (${data.total})` : ""}`} className="mt-4">
        {data && items.length === 0 && <Empty text="Todavía no has descargado nada." />}
        {!data && <p className="help">Cargando…</p>}
        <ul>
          {items.map((item) => <Item key={item.id} item={item} onChange={load} run={run} busy={busy} />)}
        </ul>
      </Section>

      <Tools run={run} busy={busy} />
    </Page>
  );
}
