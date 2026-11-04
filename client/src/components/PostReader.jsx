import React, { useState } from "react";
import { api } from "../api.js";
import { useAction } from "./ui.jsx";

/** Read one social post (X, Instagram, Threads, TikTok…) as text, with the session signed in under Descargas → Sesiones. */
export default function PostReader({ notify, initialUrl = "", onSaved, onClose }) {
  const [url, setUrl] = useState(initialUrl);
  const [post, setPost] = useState(null);
  const [run, busy] = useAction(notify);

  const read = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setPost(null);
    const out = await run(() => api.posts.read(url.trim()));
    if (out) setPost(out);
  };
  const save = async () => {
    const out = await run(() => api.links.create({ url: post.url, tags: ["post"] }), null);
    if (out) { notify({ kind: "ok", text: out.existing ? "Ya lo tenías guardado." : "Post guardado en la biblioteca." }); onSaved?.(); }
  };

  return (
    <div className="panel mb-5" data-testid="post-reader">
      <form onSubmit={read} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="block">
          <span className="label">Leer un post</span>
          <input className="field" type="url" required placeholder="https://x.com/usuario/status/…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Leyendo…" : "Leer"}</button>
        <button type="button" className="btn" onClick={onClose}>Cerrar</button>
      </form>
      <p className="help mt-1 text-[12px]">Se abre en un navegador sin ventana con la sesión que hayas iniciado en Descargas → Sesiones. Si la red pide iniciar sesión, te lo dirá.</p>
      {post && (
        <div className="mt-3 grid gap-2">
          <div className="text-[13px]"><strong>{post.author || post.site || "Post"}</strong>{post.title ? <span className="help"> · {post.title}</span> : null}{post.site ? <span className="help"> · {post.site}{post.signed_in ? " (con sesión)" : ""}</span> : null}</div>
          {post.text ? <div className="text-[14px]" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>{post.text}</div> : <div className="help">El post no tiene texto.</div>}
          {post.card ? <div className="help text-[12px]" style={{ whiteSpace: "pre-wrap" }}>{post.card}</div> : null}
          {post.links?.length > 0 && (
            <ul className="text-[13px]" style={{ listStyle: "disc", paddingLeft: 20 }}>
              {post.links.map((l) => <li key={l.href}><a href={l.href} target="_blank" rel="noreferrer">{l.text || l.href}</a></li>)}
            </ul>
          )}
          <div><button type="button" className="btn" onClick={save} disabled={busy}>Guardar en la biblioteca</button></div>
        </div>
      )}
    </div>
  );
}
