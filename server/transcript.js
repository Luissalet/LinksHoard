// Import available YouTube captions without downloading the video.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyFetchResult } from "./links.js";
import { excerptOf, wordCount } from "./extract.js";

const exec = promisify(execFile);

export function isYouTube(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com";
  } catch { return false; }
}

export function vttText(vtt) {
  const cues = [];
  for (const block of String(vtt).replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const time = lines.findIndex((line) => /-->/.test(line));
    if (time < 0) continue;
    const text = lines.slice(time + 1).join(" ")
      .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const previous = cues.at(-1);
    if (previous === text || previous?.startsWith(text)) continue;
    if (previous && text.startsWith(previous)) cues[cues.length - 1] = text;
    else cues.push(text);
  }
  return cues.join(" ").trim();
}

async function runYtDlp(args) {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  await exec(python, ["-m", "yt_dlp", ...args], { timeout: 90_000, windowsHide: true, maxBuffer: 2_000_000 });
}

export async function importTranscript(link, run = runYtDlp) {
  if (!isYouTube(link.url)) throw Object.assign(new Error("Solo se admiten vídeos de YouTube guardados."), { status: 400 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "links-transcript-"));
  try {
    const args = ["--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs",
      "--sub-langs", "es.*,en.*", "--sub-format", "vtt", "--output", path.join(dir, "captions.%(ext)s"), link.url];
    try { await run(args); }
    catch (error) {
      const reason = error?.code === "ENOENT" ? "Instala Python y yt-dlp para importar subtítulos."
        : `No se pudieron obtener subtítulos: ${String(error?.stderr || error?.message || error).slice(0, 250)}`;
      throw Object.assign(new Error(reason), { status: 400 });
    }
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".vtt"));
    files.sort((a, b) => Number(!/\.es(?:[-.]|$)/i.test(a)) - Number(!/\.es(?:[-.]|$)/i.test(b)) || a.localeCompare(b));
    if (!files.length) throw Object.assign(new Error("Este vídeo no ofrece subtítulos en español o inglés."), { status: 400 });
    const selected = files[0];
    const text = vttText(await fs.readFile(path.join(dir, selected), "utf8"));
    if (!text) throw Object.assign(new Error("Los subtítulos están vacíos."), { status: 400 });
    const language = /\.es(?:[-.]|$)/i.test(selected) ? "es" : "en";
    const stored = text.slice(0, 200_000);
    const updated = applyFetchResult(link.id, { content_text: stored,
      excerpt: excerptOf(stored), word_count: wordCount(stored), lang: language,
      kind: "video", fetch_status: "ok", fetch_error: "" });
    return { id: link.id, language, word_count: updated.word_count, text_preview: updated.excerpt };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
