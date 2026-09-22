// Formatting helpers shared across pages.

const KIND_LABEL = { article: "Artículo", video: "Vídeo", pdf: "PDF", image: "Imagen", other: "Otro" };
export const kindLabel = (kind) => KIND_LABEL[kind] || "Otro";

const PALETTE = ["#2f5d8a", "#8a5a2f", "#3a7a52", "#7a3a6a", "#a8622f", "#3a6a7a", "#6a5a8a", "#7a2f3a"];
export function siteColor(site) {
  if (!site) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < site.length; i++) hash = (hash * 31 + site.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
export function siteInitial(site) {
  return (site || "?").replace(/^www\./, "").charAt(0).toUpperCase();
}

/** Relative-ish date: "hoy", "ayer", "hace N días" or a short date. */
export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  if (days > 1 && days < 7) return `hace ${days} días`;
  return date.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function readingTime(wordCount) {
  if (!wordCount) return "";
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} min de lectura`;
}
