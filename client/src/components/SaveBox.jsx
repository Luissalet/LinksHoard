import React, { useState } from "react";
import { api } from "../api.js";
import { useAction } from "./ui.jsx";

/** Save box at the top of every list page: paste a URL + tags. */
export default function SaveBox({ notify, onSaved }) {
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [run, busy] = useAction(notify);

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const out = await run(() => api.links.create({ url: url.trim(), tags: tagList }), null);
    if (out) {
      notify({ kind: "ok", text: out.existing ? "Ya lo tenías guardado." : "Enlace guardado." });
      setUrl("");
      setTags("");
      onSaved?.();
    }
  };

  return (
    <form onSubmit={submit} className="panel mb-5 grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
      <label className="block">
        <span className="label">Pegar URL</span>
        <input className="field" type="url" required placeholder="https://ejemplo.com/articulo" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="block">
        <span className="label">Etiquetas</span>
        <input className="field" placeholder="lectura, ia" value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy}>Guardar</button>
    </form>
  );
}
