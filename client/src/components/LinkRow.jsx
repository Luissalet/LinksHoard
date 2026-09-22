import React from "react";
import { formatDate, kindLabel, siteColor, siteInitial } from "../format.js";

export function SiteChip({ site }) {
  return <span className="site-chip" style={{ background: siteColor(site) }} title={site}>{siteInitial(site)}</span>;
}

export function FetchBadge({ status }) {
  if (status === "pending") return <span className="chip chip-warn">Descargando…</span>;
  if (status === "failed") return <span className="chip chip-danger">Fallo al descargar</span>;
  return null;
}

export default function LinkRow({ link, selected, onOpen, onToggleRead, onToggleArchive, onToggleFavorite, onSelect }) {
  return (
    <li className={`link-row ${selected ? "bg-[var(--soft)]" : ""}`}>
      <button type="button" className="mt-1 shrink-0" aria-label={link.read_at ? "Marcar sin leer" : "Marcar leído"} onClick={() => onToggleRead(link)}>
        <SiteChip site={link.site} />
      </button>
      <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onOpen(link)} onMouseEnter={() => onSelect?.(link.id)}>
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-[14px]" style={{ opacity: link.read_at ? 0.65 : 1 }}>{link.title || link.url}</span>
          {link.favorite && <span aria-label="Favorito" title="Favorito">★</span>}
        </div>
        <div className="help mt-0.5 truncate text-[12px]">{link.site} · {formatDate(link.saved_at)}</div>
        {link.excerpt && <p className="help mt-1 line-clamp-2 text-[12.5px]" style={{ color: "var(--muted)" }}>{link.excerpt}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="chip">{kindLabel(link.kind)}</span>
          <FetchBadge status={link.fetch_status} />
          {link.tags.map((t) => <span key={t} className="chip chip-accent">{t}</span>)}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <button type="button" className="btn btn-sm btn-icon" title={link.favorite ? "Quitar favorito" : "Marcar favorito"} onClick={() => onToggleFavorite(link)}>{link.favorite ? "★" : "☆"}</button>
        <button type="button" className="btn btn-sm btn-icon" title={link.archived ? "Desarchivar" : "Archivar"} onClick={() => onToggleArchive(link)}>{link.archived ? "↩" : "🗄"}</button>
      </div>
    </li>
  );
}
