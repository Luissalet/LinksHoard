import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, Empty, useAction } from "../components/ui.jsx";
import { DIGEST_STATUS } from "../components/VideoDigest.jsx";
import { formatDuration } from "../format.js";
import { LoginButton } from "../components/SiteLogin.jsx";

const CHIP = { done: "chip chip-ok", partial: "chip chip-warn", failed: "chip chip-danger", queued: "chip", running: "chip chip-accent" };

/** Video digests: paste a link (a tweet with a video, YouTube, a reel) and get a text dossier an assistant can read cheaply. */
export default function Videos() {
  const { notify } = useApp();
  const [run, busy] = useAction(notify);
  const [url, setUrl] = useState("");
  const [focus, setFocus] = useState("");
  const [items, setItems] = useState(null);

  const load = useCallback(async () => { try { setItems((await api.videoDigest.list()).digests); } catch { setItems([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const active = (items || []).some((d) => ["queued", "running"].includes(d.status));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const submit = async (e) => {
    e.preventDefault();
    const out = await run(() => api.videoDigest.start({ url: url.trim(), focus: focus.trim() || undefined }), "Digest en marcha: descarga, transcripción y lectura de pantalla en este equipo.");
    if (out) { setUrl(""); setFocus(""); load(); }
  };

  return (
    <Page title="Vídeos" description="Digiere un vídeo (un tweet con vídeo, YouTube, un reel…) en texto por capas: ficha y resumen, índice por capítulos, texto en pantalla y transcripción literal. Todo se procesa en este equipo; un asistente lo lee por MCP (video_digest) gastando una fracción de lo que costaría ver los fotogramas.">
      <Section title="Digerir un vídeo">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[2fr_1.4fr_auto] sm:items-end">
          <Field label="Enlace"><input className="field" placeholder="https://x.com/…/status/… o https://youtu.be/…" value={url} onChange={(e) => setUrl(e.target.value)} required /></Field>
          <Field label="Foco (opcional)"><input className="field" placeholder="Qué buscas en el vídeo" value={focus} onChange={(e) => setFocus(e.target.value)} /></Field>
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>Digerir</button>
        </form>
      </Section>
      <Section title="Digests" className="mt-6">
        {items === null ? <p className="help">Cargando…</p> : items.length === 0 ? <Empty text="Todavía no has digerido ningún vídeo." /> : (
          <ul data-testid="digest-list">
            {items.map((d) => (
              <li key={d.link_id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2">
                <a className="min-w-0 flex-1 truncate font-semibold text-[14px] hover:underline" href={`#/link/${d.link_id}`}>{d.title || d.url}</a>
                <span className="flex flex-wrap items-center gap-2 text-[12px]">
                  {d.duration_s ? <span className="help">{formatDuration(d.duration_s)}</span> : null}
                  {d.tokens ? <span className="chip">≈ {d.tokens} tokens</span> : null}
                  <span className={CHIP[d.status] || "chip"} title={d.detail || ""}>{d.status === "running" && d.stage ? `Procesando · ${d.stage}` : (DIGEST_STATUS[d.status] || d.status).replace(/\.$/, "")}</span>
                </span>
                {d.status === "failed" && d.error && <p className="w-full text-[12px]" style={{ color: "var(--danger-ink)" }}>{d.error}</p>}
                {d.status === "failed" && d.login && (
                  <LoginButton className="w-full" login={d.login} onSaved={() => run(() => api.videoDigest.run(d.link_id, {}), "Digest en marcha de nuevo con la sesión guardada.").then(load)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
