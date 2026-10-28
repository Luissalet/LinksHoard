import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, Empty, useAction } from "../components/ui.jsx";
import { formatDuration } from "../format.js";

const TOOLS = [
  { tool: "describe", label: "Qué suena", help: "Con qué se parece más y qué etiquetas de AudioSet salen." },
  { tool: "match", label: "Comprobar descripción", help: "¿Suena a lo que escribes? Da veredicto y z.", query: true },
  { tool: "find", label: "Buscar el momento", help: "En qué tramos de este archivo suena lo que escribes.", query: true },
  { tool: "timeline", label: "Línea de tiempo", help: "Música, efectos y ambiente por tramos, con volumen y pulso.", detail: true },
  { tool: "measure", label: "Medir", help: "Volumen, picos, ruido y brillo, sin modelos (rápido)." },
  { tool: "realness", label: "¿Real o sintético?", help: "Orientativo: calibración débil." },
  { tool: "sheet", label: "Hoja de sonido", help: "Una imagen con espectrograma, onda, volumen y eventos.", detail: true },
];

const STEP = { venv: "creando el entorno", packages: "instalando paquetes", models: "descargando modelos" };
const num = (v) => (v === "" || v === undefined ? undefined : Number(v));

/** Sentidos: the listening engine (server/sentidos.js). Prepare it, point it at a sound and read what it hears. */
export default function Sentidos() {
  const { notify } = useApp();
  const [run, busy] = useAction(notify);
  const [st, setSt] = useState(null);
  const [sources, setSources] = useState([]);
  const [mode, setMode] = useState("library");
  const [pick, setPick] = useState("");
  const [filePath, setFilePath] = useState("");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [detail, setDetail] = useState("normal");
  const [working, setWorking] = useState("");
  const [result, setResult] = useState(null);
  const [lib, setLib] = useState({ q: "", deep: false, out: null });
  const logRef = useRef(null);

  const load = useCallback(async () => { try { setSt(await api.sentidos.status()); } catch (e) { notify({ kind: "error", text: e.message }); } }, [notify]);
  useEffect(() => { load(); api.sentidos.sources().then((r) => { setSources(r.sources || []); if (r.sources?.[0]) setPick(r.sources[0].path); }).catch(() => {}); }, [load]);
  const settingUp = Boolean(st?.setup?.running);
  useEffect(() => {
    if (!settingUp) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [settingUp, load]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [st?.setup?.log?.length]);

  const source = () => (mode === "library" ? { path: pick } : mode === "path" ? { path: filePath.trim() } : { url: url.trim() });
  const haveSource = mode === "library" ? Boolean(pick) : mode === "path" ? Boolean(filePath.trim()) : Boolean(url.trim());

  const analyse = async (t) => {
    setWorking(t.tool);
    setResult(null);
    try {
      const out = await api.sentidos.run({ tool: t.tool, ...source(), query: t.query ? query.trim() : undefined, start: num(from), end: num(to), detail: t.detail ? detail : undefined });
      setResult({ ...out, label: t.label });
    } catch (e) { setResult({ ok: false, label: t.label, error: e.message }); } finally { setWorking(""); load(); }
  };

  const searchLibrary = async (e) => {
    e.preventDefault();
    setWorking("lib");
    try { setLib((l) => ({ ...l, out: null })); const out = await api.sentidos.run({ tool: "find", query: lib.q.trim(), deep: lib.deep }); setLib((l) => ({ ...l, out })); }
    catch (err) { notify({ kind: "error", text: err.message }); } finally { setWorking(""); }
  };

  const ready = Boolean(st?.ready);
  const needsSetup = st && (!st.installed || !st.ready);
  const queryMissing = (t) => t.query && !query.trim();

  return (
    <Page title="Sentidos" description="Escucha un sonido en este equipo: qué es, qué música y qué efectos lleva, cuánto suena, si parece grabado o sintético. Usa dos modelos locales (CLAP y AudioSet) que se descargan una vez, unos 1,1 GB. La voz se transcribe aparte: aquí se oye todo lo demás. Un asistente puede hacer lo mismo por MCP (audio_*).">
      <Section title="Motor" aside={st && <span className={`chip ${ready ? "chip-ok" : needsSetup ? "chip-warn" : ""}`}>{ready ? "Listo" : st.setup?.running ? "Preparando" : "Sin preparar"}</span>}>
        {!st ? <p className="help">Cargando…</p> : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="sentidos-state">
              <span className={`chip ${st.installed ? "chip-ok" : ""}`}>Entorno de Python: {st.installed ? "instalado" : "sin instalar"}</span>
              <span className={`chip ${st.models?.ready || (st.ready && !st.models) ? "chip-ok" : ""}`}>Modelos: {st.models ? (st.models.ready ? "descargados" : "faltan") : st.ready ? "descargados" : "sin comprobar"}</span>
              <span className={`chip ${st.worker?.running ? "chip-accent" : ""}`}>Motor: {st.worker?.running ? `en marcha${st.worker.calls ? ` · ${st.worker.calls} llamadas` : ""}${st.loaded?.clap ? " · modelos en memoria" : ""}` : "parado"}</span>
              {st.threads ? <span className="chip">{st.threads} hilos · {st.precision}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {needsSetup && <button type="button" className="btn btn-primary" disabled={busy || settingUp} onClick={() => run(() => api.sentidos.setup(), "Preparando Sentidos en segundo plano.").then(load)}>{settingUp ? "Preparando…" : "Preparar Sentidos"}</button>}
              {st.installed && !st.worker?.running && <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.sentidos.start(), "Motor en marcha.").then(load)}>Arrancar el motor</button>}
              {st.worker?.running && <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.sentidos.stop(), "Motor parado.").then(load)}>Parar el motor</button>}
            </div>
            {(settingUp || st.setup?.log?.length > 0) && (
              <div>
                {settingUp && <p className="help mb-1 text-[12px]">Paso actual: {STEP[st.setup.step] || st.setup.step}. Puedes salir de esta pantalla: sigue en segundo plano.</p>}
                {st.setup?.ok === false && st.setup.error && <p className="mb-1 text-[12px]" style={{ color: "var(--danger-ink)" }}>{st.setup.error}</p>}
                <pre ref={logRef} className="max-h-40 overflow-auto rounded-md border p-2 text-[11px]" style={{ borderColor: "var(--line)", whiteSpace: "pre-wrap" }} data-testid="sentidos-log">{(st.setup.log || []).join("\n")}</pre>
              </div>
            )}
            <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); run(() => api.sentidos.saveSettings({ idle_min: Number(st.settings.idle_min), warm: !!st.settings.warm }), "Ajustes de Sentidos guardados.").then(load); }}>
              <Field label="Parar el motor tras (minutos sin uso)" help="0 = no parar nunca. Un motor con los modelos cargados ocupa unos 2 GB de memoria.">
                <input className="field" type="number" min="0" max="1440" value={st.settings.idle_min} onChange={(e) => setSt({ ...st, settings: { ...st.settings, idle_min: e.target.value } })} />
              </Field>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!st.settings.warm} onChange={(e) => setSt({ ...st, settings: { ...st.settings, warm: e.target.checked } })} /> Cargar los modelos al arrancar (la primera consulta responde antes)</label>
              <button type="submit" className="btn" disabled={busy}>Guardar</button>
            </form>
          </div>
        )}
      </Section>

      <Section title="Analizar un sonido" className="mt-6">
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Origen del sonido">
            {[["library", "Descargado"], ["path", "Ruta del archivo"], ["url", "Enlace"]].map(([m, label]) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn btn-sm ${mode === m ? "btn-active" : ""}`} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          {mode === "library" && (sources.length === 0
            ? <Empty text="No hay audios ni vídeos descargados. Descarga uno desde Descargas, o usa una ruta o un enlace." />
            : (
              <Field label="Audio o vídeo descargado">
                <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="sentidos-source">
                  {sources.map((s) => <option key={s.path} value={s.path}>{s.title}{s.duration ? ` · ${formatDuration(s.duration)}` : ""} ({s.kind})</option>)}
                </select>
              </Field>
            ))}
          {mode === "path" && <Field label="Ruta del archivo" help="Una ruta absoluta de este equipo (mp3, wav, flac, m4a, mp4…)."><input className="field" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="C:\Audio\sonido.wav" /></Field>}
          {mode === "url" && <Field label="Enlace" help="Si no lo tienes guardado, se baja solo el audio y se guarda en la biblioteca."><input className="field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>}
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Lo que buscas o esperas" help="Para «Comprobar» y «Buscar» (en inglés rinde mejor: «a dog barking»)." className="sm:col-span-2"><input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="a door slamming" /></Field>
            <Field label="Desde (s)"><input className="field" type="number" min="0" step="0.1" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Hasta (s)"><input className="field" type="number" min="0" step="0.1" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <Field label="Detalle de la línea de tiempo y la hoja" help="Más detalle etiqueta más eventos y tarda más.">
            <select className="field sm:max-w-[200px]" value={detail} onChange={(e) => setDetail(e.target.value)}>
              <option value="low">Bajo</option><option value="normal">Normal</option><option value="high">Alto</option>
            </select>
          </Field>
          <div className="flex flex-wrap gap-2" data-testid="sentidos-tools">
            {TOOLS.map((t) => (
              <button key={t.tool} type="button" className="btn" title={t.help} disabled={!haveSource || queryMissing(t) || Boolean(working) || !st?.installed} onClick={() => analyse(t)}>
                {working === t.tool ? "Escuchando…" : t.label}
              </button>
            ))}
          </div>
          {!st?.installed && <p className="help text-[12px]">Prepara Sentidos arriba para poder analizar.</p>}
          {working && <p className="help text-[12px]">La primera consulta carga los modelos y puede tardar un minuto; las siguientes responden en segundos.</p>}
          {result && (
            <div className="rounded-md border p-3" style={{ borderColor: result.ok ? "var(--line)" : "var(--danger-line)" }} data-testid="sentidos-result">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <strong className="text-[14px]">{result.label}{result.source?.label ? ` · ${result.source.label}` : ""}</strong>
                {result.ok && result.text && <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(result.text).then(() => notify({ kind: "ok", text: "Copiado." }))}>Copiar</button>}
              </div>
              {result.ok ? (
                <>
                  {result.image_name && <a href={api.sentidos.sheetUrl(result.image_name)} target="_blank" rel="noreferrer"><img src={api.sentidos.sheetUrl(result.image_name)} alt="Hoja de sonido: espectrograma, onda, volumen y eventos" className="mb-2 max-w-full rounded border" style={{ borderColor: "var(--line)" }} /></a>}
                  <pre className="max-h-[420px] overflow-auto text-[12px]" style={{ whiteSpace: "pre-wrap" }}>{result.text}</pre>
                  <p className="help mt-1 text-[11px]">Las etiquetas son estimaciones de un modelo; la z dice cuánto se alejan del azar.</p>
                </>
              ) : <p className="text-[13px]" style={{ color: "var(--danger-ink)" }}>{result.error}</p>}
            </div>
          )}
        </div>
      </Section>

      <Section title="Buscar un sonido en los vídeos digeridos" className="mt-6">
        <form onSubmit={searchLibrary} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Qué suena" help="Palabras de la banda sonora de los digests: «orchestral», «piano», «cafe»…"><input className="field" value={lib.q} onChange={(e) => setLib({ ...lib, q: e.target.value })} placeholder="orchestral" required /></Field>
            <button type="submit" className="btn btn-primary" disabled={working === "lib" || !lib.q.trim()}>{working === "lib" ? "Buscando…" : "Buscar"}</button>
          </div>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={lib.deep} onChange={(e) => setLib({ ...lib, deep: e.target.checked })} /> Ordenar además los archivos descargados escuchándolos (lento, usa los modelos)</label>
        </form>
        {lib.out && (
          <div className="mt-3" data-testid="sentidos-search">
            {lib.out.indexed?.length ? (
              <ul>
                {lib.out.indexed.map((h) => (
                  <li key={`${h.link_id}-${h.ref}`} className="border-b border-[var(--line)] py-2 text-[13px]">
                    <a className="font-semibold hover:underline" href={`#/link/${h.link_id}`}>{h.title || h.link_id}</a>
                    <span className="help"> · {formatDuration(h.start_s)}–{formatDuration(h.end_s)}</span>
                    <div>{h.label}</div>
                    {h.also && <div className="help text-[12px]">AudioSet: {h.also}</div>}
                  </li>
                ))}
              </ul>
            ) : <p className="help text-[13px]">Ningún digest tiene esas palabras en su banda sonora.</p>}
            {lib.out.library && <pre className="mt-3 max-h-[320px] overflow-auto text-[12px]" style={{ whiteSpace: "pre-wrap" }}>{lib.out.library.ok ? lib.out.library.text : lib.out.library.error}</pre>}
          </div>
        )}
      </Section>
    </Page>
  );
}
