// Import available YouTube captions without downloading the video. The lookup of yt-dlp, the caption download and the caption parser
// (rolling auto-captions collapsed) are the same ones the family's media_subtitles tool uses: media.js getSubtitles.
import { applyFetchResult } from "./links.js";
import { excerptOf, wordCount } from "./extract.js";
import { getSubtitles } from "./media.js";
import { vttText } from "./hoard-commons/media.js";

export { vttText };

export function isYouTube(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com";
  } catch { return false; }
}

/** Spanish first, then English; `getSubs` is the caption source (tests pass a fake). */
export async function importTranscript(link, getSubs = getSubtitles) {
  if (!isYouTube(link.url)) throw Object.assign(new Error("Solo se admiten vídeos de YouTube guardados."), { status: 400 });
  let subs;
  try {
    subs = await getSubs({ url: link.url, langs: ["es", "en"] });
  } catch (error) {
    if (error?.code === "NO_SUBTITLES") throw Object.assign(new Error("Este vídeo no ofrece subtítulos en español o inglés."), { status: 400 });
    if (error?.code === "BINARY_MISSING") throw Object.assign(new Error(error.message), { status: 400 });
    throw Object.assign(new Error(`No se pudieron obtener subtítulos: ${String(error?.message || error).slice(0, 250)}`), { status: 400 });
  }
  const text = String(subs?.text || "").trim();
  if (!text) throw Object.assign(new Error("Los subtítulos están vacíos."), { status: 400 });
  const language = /^es(?:[-_]|$)/i.test(subs.lang || "") ? "es" : "en";
  const stored = text.slice(0, 200_000);
  const updated = applyFetchResult(link.id, { content_text: stored,
    excerpt: excerptOf(stored), word_count: wordCount(stored), lang: language,
    kind: "video", fetch_status: "ok", fetch_error: "" });
  return { id: link.id, language, word_count: updated.word_count, text_preview: updated.excerpt };
}
