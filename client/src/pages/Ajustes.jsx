import React, { useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Page, Section, Field, useAction } from "../components/ui.jsx";

function bookmarkletHref(origin) {
  const code = `javascript:(function(){location.href=${JSON.stringify(origin)}+'/share?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);})();`;
  return code;
}

export default function Ajustes() {
  const { notify, refresh, dataDir, version, ftsEnabled } = useApp();
  const [format, setFormat] = useState("netscape");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [result, setResult] = useState(null);
  const [run, busy] = useAction(notify);

  const origin = window.location.origin;

  const runImport = async (e) => {
    e.preventDefault();
    if (!content.trim()) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const out = await run(() => api.import({ format, content, tags: tagList }), "Importación completada.");
    if (out) { setResult(out); setContent(""); refresh(); }
  };

  return (
    <Page title="Ajustes" description="Bookmarklet, instalación como app, importación y datos.">
      <Section title="Bookmarklet" aside={<span className="help text-[12px]">Arrástralo a tu barra de marcadores</span>}>
        <p className="help mb-3">Al pulsarlo desde cualquier página, la guarda en Links Hoard.</p>
        <a href={bookmarkletHref(origin)} className="btn btn-primary" onClick={(e) => e.preventDefault()} draggable="true">📥 Guardar en Links Hoard</a>
        <p className="help mt-3">O copia el código y créalo tú mismo como marcador nuevo:</p>
        <textarea className="field mt-1" style={{ fontFamily: "Consolas, monospace", fontSize: 11 }} rows={3} readOnly value={bookmarkletHref(origin)} onFocus={(e) => e.target.select()} />
      </Section>

      <Section title="Instalar como app" className="mt-4">
        <p className="help">
          En Android (Chrome), abre <code>{origin}</code>, pulsa el menú (⋮) y elige «Añadir a pantalla de inicio». Una vez instalada,
          puedes usar «Compartir» desde cualquier app o el navegador y elegir Links Hoard: la página se guardará automáticamente.
        </p>
        <p className="help mt-2">En escritorio, el icono de instalación aparece en la barra de direcciones de Chrome/Edge.</p>
      </Section>

      <Section title="Importar" className="mt-4">
        <form onSubmit={runImport} className="grid gap-3">
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-[13px]"><input type="radio" checked={format === "netscape"} onChange={() => setFormat("netscape")} /> Marcadores (HTML de Netscape)</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="radio" checked={format === "urls"} onChange={() => setFormat("urls")} /> Lista de URLs (una por línea)</label>
          </div>
          <Field label="Contenido" help="Pega aquí el HTML exportado por tu navegador, o una lista de URLs.">
            <textarea className="field" rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder={format === "netscape" ? "<!DOCTYPE NETSCAPE-Bookmark-file-1>…" : "https://ejemplo.com/uno\nhttps://ejemplo.com/dos"} />
          </Field>
          <Field label="Etiquetas para todos" help="Opcional, separadas por comas.">
            <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="importado" />
          </Field>
          <div><button type="submit" className="btn btn-primary" disabled={busy}>Importar</button></div>
        </form>
        {result && (
          <p className="help mt-3">Encontrados: {result.found} · Añadidos: {result.added} · Ya existían: {result.skipped}</p>
        )}
      </Section>

      <Section title="Datos" className="mt-4">
        <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
          <div><dt className="label">Carpeta de datos</dt><dd style={{ fontFamily: "Consolas, monospace", fontSize: 12 }}>{dataDir}</dd></div>
          <div><dt className="label">Versión</dt><dd>{version}</dd></div>
          <div><dt className="label">Búsqueda</dt><dd>{ftsEnabled ? "Texto completo (FTS5)" : "Búsqueda simple (LIKE) — FTS5 no disponible en este SQLite"}</dd></div>
        </dl>
      </Section>
    </Page>
  );
}
