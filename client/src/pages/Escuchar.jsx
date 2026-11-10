import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, Empty, useAction } from "../components/ui.jsx";
import { useListen } from "../listen.jsx";
import { formatBytes } from "../format.js";

const STATUS = { queued: "En cola", running: "Generando", failed: "Falló", none: "Sin audio" };
const VOICES = ["es_ES-davefx-medium", "es_ES-sharvard-medium", "en_US-lessac-medium", "en_US-amy-medium", "en_GB-alba-medium"];

function Row({ item, children }) {
  const active = ["queued", "running"].includes(item.status);
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] py-2" data-testid="listen-row" data-id={item.link_id}>
      <a className="min-w-0 flex-1 truncate text-[14px] font-semibold hover:underline" href={`#/link/${item.link_id}`}>{item.title || item.url}</a>
      <span className="flex flex-wrap items-center gap-2 text-[12px]">
        {item.site && <span className="help">{item.site}</span>}
        {item.status === "done"
          ? <span className={item.finished ? "chip chip-ok" : "chip"}>{item.finished ? "Escuchado" : item.position_s > 1 ? `${item.position} de ${item.duration}` : item.duration}</span>
          : <span className={item.status === "failed" ? "chip chip-danger" : "chip chip-accent"} title={item.error || item.detail || ""}>{STATUS[item.status] || item.status}{active ? ` · ${Math.round((item.progress || 0) * 100)} %` : ""}</span>}
      </span>
      <span className="flex items-center gap-1">{children}</span>
      {item.status === "failed" && item.error && <p className="w-full text-[12px]" style={{ color: "var(--danger-ink)" }}>{item.error}</p>}
    </li>
  );
}

/** «Escuchar después» in order, and everything that has been narrated. */
export default function Escuchar() {
  const { notify } = useApp();
  const player = useListen();
  const [run, busy] = useAction(notify);
  const [data, setData] = useState(null);
  const [voice, setVoice] = useState("");

  const load = useCallback(async () => {
    try { const out = await api.listen.page(); setData(out); setVoice(out.settings.voice || ""); } catch { setData({ queue: [], library: [], settings: {} }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = data && [...data.queue, ...data.library].some((i) => ["queued", "running"].includes(i.status));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [active, load]);
  useEffect(() => {
    window.addEventListener("links:listen-changed", load);
    return () => window.removeEventListener("links:listen-changed", load);
  }, [load]);

  const after = async (fn, text) => { if (await run(fn, text)) { await load(); player.refreshQueue(); } };
  const move = (item, delta) => after(() => api.listen.queueAdd(item.link_id, item.queue_pos + delta));
  const saveVoice = async (value) => { setVoice(value); await run(() => api.listen.settings({ voice: value }), "Voz guardada: se usará en los audios nuevos."); };

  if (!data) return <p className="help p-8">Cargando…</p>;
  const total = data.library.reduce((n, i) => n + (i.bytes || 0), 0);
  return (
    <Page title="Escuchar" description="Los enlaces guardados, leídos en voz alta por Prospero's Hoard. La cola suena seguida, un audio tras otro, y cada uno recuerda dónde lo dejaste.">
      <Section title="Escuchar después" aside={data.queue.length > 0 && (
        <span className="flex gap-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => player.play(data.queue[0].link_id)} data-testid="queue-play">Escuchar la cola</button>
          <button type="button" className="btn btn-sm" onClick={() => after(() => api.listen.queueClear(), "Cola vaciada.")} disabled={busy}>Vaciar</button>
        </span>
      )}>
        {data.queue.length === 0 ? <Empty text="La cola está vacía. Abre un enlace y pulsa «Escuchar después»." /> : (
          <ol data-testid="listen-queue">
            {data.queue.map((item, i) => (
              <Row key={item.link_id} item={item}>
                <button type="button" className="btn btn-sm btn-icon" onClick={() => move(item, -1)} disabled={busy || i === 0} aria-label="Subir en la cola">↑</button>
                <button type="button" className="btn btn-sm btn-icon" onClick={() => move(item, 1)} disabled={busy || i === data.queue.length - 1} aria-label="Bajar en la cola">↓</button>
                <button type="button" className="btn btn-sm" onClick={() => player.play(item.link_id)}>Escuchar</button>
                <button type="button" className="btn btn-sm" onClick={() => after(() => api.listen.queueRemove(item.link_id))} disabled={busy}>Quitar</button>
              </Row>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Audios" className="mt-6" aside={data.library.length > 0 && <span className="help text-[12px]">{data.library.length} · {formatBytes(total)}</span>}>
        {data.library.length === 0 ? <Empty text="Todavía no has pasado ningún enlace a audio." /> : (
          <ul data-testid="listen-library">
            {data.library.map((item) => (
              <Row key={item.link_id} item={item}>
                {item.status === "done" && <button type="button" className="btn btn-sm" onClick={() => player.play(item.link_id)}>{item.position_s > 1 && !item.finished ? "Reanudar" : "Escuchar"}</button>}
                {item.status === "failed" && <button type="button" className="btn btn-sm" onClick={() => after(() => api.listen.start(item.link_id, {}), "Generando el audio de nuevo.")} disabled={busy}>Reintentar</button>}
                {!item.queued && <button type="button" className="btn btn-sm" onClick={() => after(() => api.listen.queueAdd(item.link_id), "Añadido a Escuchar después.")} disabled={busy}>Escuchar después</button>}
                <button type="button" className="btn btn-sm" onClick={() => after(() => api.listen.remove(item.link_id), "Audio borrado.")} disabled={busy}>Borrar audio</button>
              </Row>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Voz" className="mt-6">
        <Field label="Voz de lectura" help="Vacío: una voz en español o en inglés según el idioma del enlace. Vale cualquier voz instalada en Prospero's Hoard.">
          <input className="field" list="listen-voices" value={voice} placeholder="Automática según el idioma" onChange={(e) => setVoice(e.target.value)}
            onBlur={(e) => { if (e.target.value.trim() !== (data.settings.voice || "")) saveVoice(e.target.value.trim()); }} data-testid="listen-voice" />
          <datalist id="listen-voices">{VOICES.map((v) => <option key={v} value={v} />)}</datalist>
        </Field>
      </Section>
    </Page>
  );
}
