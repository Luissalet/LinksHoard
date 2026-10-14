// Pure parts of the video digest (see videodigest.js): cutting the whole video into visual segments from tiny grey thumbnails, grouping
// time into chapters, transcript paragraphs, screen-text cleaning, the token arithmetic and the markdown layers. No I/O here, so every
// rule can be tested on its own.
//
// The layers, cheapest first, are what an assistant reads instead of looking at the video:
//   card       - source, post text, duration, the generated summary and key points, what each layer costs
//   index      - one block per chapter: time span, generated title and summary, what is on screen (OCR excerpt) and which frame shows it
//   visual     - every visual segment: span, kind, generated description, the literal screen text, the frame file
//   transcript - the literal speech-to-text, in timed paragraphs
// Literal material (transcript, OCR) and generated material (titles, summaries, descriptions) are always labelled apart.

export const THUMB_W = 64;
export const THUMB_H = 36;
export const THUMB_BYTES = THUMB_W * THUMB_H;

export const clock = (t) => {
  const s = Math.max(0, Math.floor(Number(t) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
};

export const span = (a, b) => `${clock(a)}–${clock(b)}`;

/** "83", "83.5", "1:23", "1:02:03", "1m23s", "90s" -> seconds; null when it is not a time. */
export function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const colon = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (colon) return Number(colon[1] || 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
  const units = /^(?:(\d+)h)?\s*(?:(\d+)m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0);
  return null;
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

/** Rough tokens of text for a Claude-class model: ~3.5 characters per token for Spanish/English prose with markdown. */
export const textTokens = (text) => Math.ceil(String(text || "").length / 3.5);

/** Tokens of one image as such models bill it: the picture is first shrunk to at most 1568 px on the long edge and ~1.15 MP, then w*h/750. */
export function imageTokens(width, height) {
  let w = Number(width) || 0, h = Number(height) || 0;
  if (!w || !h) return 0;
  const edge = 1568 / Math.max(w, h);
  if (edge < 1) { w *= edge; h *= edge; }
  const area = 1_150_000 / (w * h);
  if (area < 1) { w *= Math.sqrt(area); h *= Math.sqrt(area); }
  return Math.ceil((w * h) / 750);
}

/** What looking at the video frame by frame would cost: one frame every `every` seconds at the source size scaled to 1280 px on the long edge. */
export function naiveFrameTokens(duration, width, height, every) {
  const d = Number(duration) || 0;
  if (!d || !width || !height) return 0;
  const k = Math.min(1, 1280 / Math.max(width, height));
  return Math.ceil(d / every) * imageTokens(Math.round(width * k), Math.round(height * k));
}

// ---------------------------------------------------------------------------
// visual segmentation
// ---------------------------------------------------------------------------

/** How many grey thumbnails per second to look at: dense for short clips, sparse for long talks. */
export function autoFps(duration) {
  const d = Number(duration) || 0;
  if (d <= 0) return 1;
  if (d <= 600) return 2;
  if (d <= 3600) return 1;
  return 0.5;
}

/** Mean absolute difference of two grey thumbnails, 0 (same) to 1. */
export function frameDiff(a, b) {
  if (!a || !b) return 1;
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

/** Raw grey video (THUMB_W x THUMB_H, one byte per pixel, frames back to back) as one Uint8Array per frame. */
export function splitThumbs(buffer, frameBytes = THUMB_BYTES) {
  const out = [];
  if (!buffer) return out;
  for (let off = 0; off + frameBytes <= buffer.length; off += frameBytes) out.push(buffer.subarray(off, off + frameBytes));
  return out;
}

/**
 * Cut a run of thumbnails (one every 1/fps s) into segments whose picture stays close to the segment's first frame (anchor). A segment
 * shorter than minSegS is not kept on its own: it joins the one before while that one is still short, so a montage of half-second cuts
 * becomes a few segments of a couple of seconds instead of one segment or dozens of flashes.
 * Returns [{ start, end, anchor }] with times in seconds and anchor = index of the thumbnail that stands for it (-1 without thumbnails).
 */
export function segmentThumbs(thumbs, fps, { threshold = 0.075, minSegS = 2, duration = 0 } = {}) {
  const step = 1 / (Number(fps) || 1);
  const total = Number(duration) > 0 ? Number(duration) : thumbs.length * step;
  if (!thumbs.length) return total ? [{ start: 0, end: total, anchor: -1 }] : [];
  const raw = [];
  let start = 0, anchor = 0;
  for (let i = 1; i < thumbs.length; i++) {
    if (frameDiff(thumbs[i], thumbs[anchor]) > threshold) {
      raw.push({ start: start * step, end: i * step, anchor });
      start = i;
      anchor = i;
    }
  }
  raw.push({ start: start * step, end: Math.max(total, start * step), anchor });
  const out = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    const len = (x) => x.end - x.start;
    if (last && len(last) < minSegS) { last.end = s.end; continue; }
    if (last && len(s) < minSegS && len(last) < 2 * minSegS) { last.end = s.end; continue; }
    out.push({ ...s });
  }
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < minSegS) {
    const tail = out.pop();
    out[out.length - 1].end = tail.end;
  }
  return out;
}

/** At most `max` segments: the adjacent pair whose anchors look most alike is merged first, again and again. */
export function capSegments(segs, thumbs, max) {
  const out = segs.map((s) => ({ ...s }));
  const cap = Math.max(1, Math.floor(max));
  if (out.length <= cap) return out;
  const d = (i) => frameDiff(thumbs[out[i].anchor], thumbs[out[i + 1].anchor]);
  const gaps = out.slice(0, -1).map((_, i) => d(i));
  while (out.length > cap) {
    let best = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i] < gaps[best]) best = i;
    out[best].end = out[best + 1].end;
    out.splice(best + 1, 1);
    gaps.splice(best, 1);
    if (best < gaps.length) gaps[best] = d(best);
    if (best > 0) gaps[best - 1] = d(best - 1);
  }
  return out;
}

/** For each segment, the index of an earlier, non-adjacent segment showing the same picture (a slide shown again), else null. */
export function markRepeats(segs, thumbs, threshold = 0.04) {
  return segs.map((s, i) => {
    if (s.anchor < 0) return null;
    for (let j = 0; j < i - 1; j++) {
      if (segs[j].anchor < 0) continue;
      if (frameDiff(thumbs[s.anchor], thumbs[segs[j].anchor]) < threshold) return j;
    }
    return null;
  });
}

/** The instant that stands for a segment: its middle, a little before the end of the video. */
export function segmentTime(seg, duration = 0) {
  const t = seg.start + Math.max(0, seg.end - seg.start) / 2;
  const last = Number(duration) > 0 ? Math.max(0, Number(duration) - 0.2) : t;
  return Math.round(Math.min(t, last) * 100) / 100;
}

// ---------------------------------------------------------------------------
// screen text
// ---------------------------------------------------------------------------

/** OCR output kept readable: no lines without at least two letters or digits, collapsed spaces, capped. */
export function cleanOcr(text, max = 1500) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => (l.match(/[\p{L}\p{N}]/gu) || []).length >= 2);
  let out = lines.join("\n");
  if (out.length > max) out = `${out.slice(0, max).replace(/\s+\S*$/, "")} …`;
  return out;
}

const words = (text) => new Set(String(text || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);

const trigrams = (text) => {
  const t = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  if (!out.size && t) out.add(t);
  return out;
};
const jaccard = (A, B) => {
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
};

/** How alike two texts are, 0 to 1: the better of the word overlap and the overlap of letter triplets with spacing ignored (OCR often
 * glues or splits words differently on two frames of the same screen). */
export function textSimilarity(a, b) {
  return Math.max(jaccard(words(a), words(b)), jaccard(trigrams(a), trigrams(b)));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/** Post texts from some sites arrive with HTML entities (&amp;, &#39;). */
export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// ---------------------------------------------------------------------------
// time structure
// ---------------------------------------------------------------------------

/** How long a chapter should be: the whole thing for a short clip, else a twelfth of the video between 45 s and 5 min. */
export function chapterTarget(duration) {
  const d = Number(duration) || 0;
  if (d <= 90) return Math.max(d, 1);
  return Math.min(300, Math.max(45, d / 12));
}

/**
 * Chapters cut where the picture changes (strong), at a pause in the speech (medium) or after a sentence (weak), as near as possible to
 * every `target` seconds. speech: [{start_s, end_s, text}], visual: [{start, end}]. Returns [{ start, end }].
 */
export function planChapters(duration, speech = [], visual = [], { target } = {}) {
  const dur = Number(duration) || Math.max(speech[speech.length - 1]?.end_s || 0, visual[visual.length - 1]?.end || 0);
  if (!dur) return [];
  const goal = target || chapterTarget(dur);
  if (dur <= goal * 1.5) return [{ start: 0, end: dur }];
  const cands = new Map();
  const add = (t, w) => {
    if (!(t > 0 && t < dur)) return;
    const k = Math.round(t * 10) / 10;
    cands.set(k, Math.max(cands.get(k) || 0, w));
  };
  for (const v of visual) add(v.start, 3);
  for (let i = 1; i < speech.length; i++) {
    const gap = speech[i].start_s - speech[i - 1].end_s;
    add(speech[i].start_s, gap >= 1.2 ? 1.5 : /[.?!…]["»”)]?$/.test(speech[i - 1].text) ? 0.8 : 0.3);
  }
  const times = [...cands.keys()].sort((a, b) => a - b);
  const out = [];
  let start = 0;
  while (dur - start > goal * 1.5) {
    const ideal = start + goal, lo = start + goal * 0.6, hi = start + goal * 1.5;
    let best = null, bestScore = -Infinity;
    for (const t of times) {
      if (t < lo) continue;
      if (t > hi) break;
      const score = cands.get(t) - (Math.abs(t - ideal) / goal) * 2;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    const cut = best ?? Math.round(ideal * 10) / 10;
    out.push({ start, end: cut });
    start = cut;
  }
  out.push({ start, end: dur });
  return out;
}

/** The items whose start falls in [start, end) (the last chapter also takes what starts at its end). */
export function within(items, start, end, { key = "start_s", last = false } = {}) {
  return items.filter((x) => x[key] >= start && (x[key] < end || (last && x[key] <= end)));
}

/** Timed paragraphs: a new one after a pause of gapS, or after maxS seconds once a sentence ends (2*maxS at most). */
export function paragraphs(speech, { maxS = 30, gapS = 2 } = {}) {
  const out = [];
  let cur = null;
  for (const s of speech) {
    const text = String(s.text || "").trim();
    if (!text) continue;
    const gap = cur ? s.start_s - cur.end_s : 0;
    const long = cur && s.start_s - cur.start_s >= maxS && /[.?!…]["»”)]?$/.test(cur.text);
    if (!cur || gap >= gapS || long || s.start_s - cur.start_s >= maxS * 2) {
      cur = { start_s: s.start_s, end_s: s.end_s, text, first: s.index ?? null };
      out.push(cur);
    } else {
      cur.text += ` ${text}`;
      cur.end_s = s.end_s;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// markdown layers
// ---------------------------------------------------------------------------

const KIND_ES = {
  talking_head: "persona hablando", screen: "pantalla / interfaz", slide: "diapositiva", code: "código", terminal: "terminal",
  chart: "gráfico", diagram: "diagrama", document: "documento", product: "producto", scene: "escena", text_card: "rótulo", other: "otro",
};
export const kindLabel = (k) => KIND_ES[k] || k || "";

const fence = (text) => {
  const body = String(text || "");
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}text\n${body}\n${ticks}`;
};
const oneLine = (text, max) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t;
};
const gen = (model) => `*(generado${model ? ` · ${model}` : ""})*`;

function sourceLines(m) {
  const lines = [];
  lines.push(`- **Fuente:** ${m.url || "(archivo local)"}${m.platform ? ` · ${m.platform}` : ""}`);
  const who = [m.uploader && `**Autor:** ${m.uploader}`, m.upload_date && `**Fecha:** ${m.upload_date}`, m.duration && `**Duración:** ${clock(m.duration)}`,
    m.width && m.height && `**Formato:** ${m.width}×${m.height}`, m.language && `**Idioma:** ${m.language}`].filter(Boolean);
  if (who.length) lines.push(`- ${who.join(" · ")}`);
  return lines;
}

/** The card: what the video is, the generated summary and what reading more would cost. */
export function renderCard(m, tokens = {}) {
  const out = [`# ${m.title || "Vídeo sin título"}`, ""];
  out.push(`> Digest de vídeo de Links Hoard (${m.generated_at || ""}). La transcripción y el texto en pantalla (OCR) son literales; lo marcado *(generado)* lo escribió un modelo local y puede equivocarse: compruébalo con su marca de tiempo.`, "");
  out.push("## Ficha", "", ...sourceLines(m));
  if (m.post_text) out.push("", "**Texto de la publicación** (literal):", "", fence(oneLine(m.post_text, 3000)));
  const s = m.summary;
  if (m.focus) out.push("", `**Foco pedido:** ${m.focus}`);
  if (s?.focus_answer) out.push("", `**Sobre el foco** ${gen(s.model)}: ${s.focus_answer}`);
  if (s?.tldr) out.push("", `**Resumen** ${gen(s.model)}: ${s.tldr}`);
  if (s?.key_points?.length) out.push("", `**Puntos clave** ${gen(s.model)}:`, ...s.key_points.map((p) => `- ${p}`));
  if (m.notes?.length) out.push("", "**Avisos:**", ...m.notes.map((n) => `- ${n}`));
  const t = tokens;
  if (t.full) {
    out.push("", "**Coste de leer más** (tokens aprox.):",
      `- index.md (capítulos): ~${t.index} · visual.md (pantalla, OCR): ~${t.visual} · transcript.md (literal): ~${t.transcript} · digest.md (todo): ~${t.full}`);
    if (t.overview_image) out.push(`- overview.jpg (mosaico de ${m.overview_tiles || 0} fotogramas con su tiempo): ~${t.overview_image}`);
    if (t.naive_5s) out.push(`- Para comparar, mirar el vídeo a un fotograma cada 5 s costaría ~${t.naive_5s}.`);
  }
  out.push("", "**Cómo pedir más:** video_digest_read (capa o tramo de tiempo), video_ask (pregunta con citas), video_find (buscar), video_frame (fotograma exacto en un instante).");
  return out.join("\n");
}

/** The index: one block per chapter. */
export function renderIndex(m) {
  const out = ["## Índice por capítulos", ""];
  if ((m.visual || []).some((v) => v.caption)) out.push(`> En los planos, *(gen.)* marca la descripción generada${m.vision_model ? ` por ${m.vision_model}` : ""}; «texto» es OCR literal.`, "");
  const chapters = m.chapters || [];
  if (!chapters.length) return [...out, "(sin capítulos: el vídeo no tiene ni voz ni imagen analizable)"].join("\n");
  const model = m.summary?.model || m.chapter_model || "";
  for (const c of chapters) {
    const star = c.focus ? " ★" : "";
    out.push(`### ${c.id} · [${span(c.start, c.end)}] ${c.title ? `${c.title} ${gen(model)}` : ""}${star}`.trimEnd());
    if (c.summary) out.push(`${c.summary} ${gen(model)}`);
    else if (c.said) out.push(`Dice (literal, inicio): «${oneLine(c.said, 220)}»`);
    const screens = (m.visual || []).filter((v) => v.start < c.end && v.end > c.start && v.same_as === null);
    // the index stays lean: at most five shots per chapter, the ones worth looking at first, in time order
    const shown = screens.filter((v) => v.ocr || v.caption || v.important)
      .map((v, i) => ({ v, i })).sort((a, b) => (b.v.important ? 1 : 0) - (a.v.important ? 1 : 0) || a.i - b.i)
      .slice(0, 5).sort((a, b) => a.i - b.i).map((x) => x.v);
    for (const v of shown) {
      const bits = [`v${v.idx} [${clock(v.start)}]`];
      if (v.kind) bits.push(kindLabel(v.kind));
      if (v.caption && (!v.ocr || v.important)) bits.push(`${oneLine(v.caption, 110)} *(gen.)*`);
      if (v.ocr) bits.push(`texto: «${oneLine(v.ocr, 140)}»`);
      if (v.important) bits.push("★ conviene verlo");
      bits.push(v.file);
      out.push(`- ${bits.join(" · ")}`);
    }
    if (screens.length > shown.length) out.push(`- (+${screens.length - shown.length} planos más en visual.md)`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** Every visual segment, with its literal screen text. */
export function renderVisual(m, { from = 0, to = Infinity } = {}) {
  const out = ["## Pista visual", ""];
  const items = (m.visual || []).filter((v) => v.end > from && v.start < to);
  if (!items.length) return [...out, "(sin imagen)"].join("\n");
  for (const v of items) {
    if (v.same_as !== null && v.same_as !== undefined) {
      out.push(`- **v${v.idx}** [${span(v.start, v.end)}] · vuelve el mismo plano que v${v.same_as}`);
      continue;
    }
    const head = [`**v${v.idx}** [${span(v.start, v.end)}]`, v.kind && kindLabel(v.kind), v.important && "★ conviene verlo", v.file].filter(Boolean);
    out.push(`- ${head.join(" · ")}`);
    if (v.caption) out.push(`  - Se ve ${gen(m.vision_model)}: ${v.caption}`);
    if (v.ocr_same_as !== null && v.ocr_same_as !== undefined) out.push(`  - Texto en pantalla: el mismo que v${v.ocr_same_as}`);
    else if (v.ocr) out.push("  - Texto en pantalla (OCR literal):", fence(v.ocr));
  }
  return out.join("\n").trimEnd();
}

/** The literal transcript in timed paragraphs. */
export function renderTranscript(m, { from = 0, to = Infinity } = {}) {
  const t = m.transcript || {};
  const how = [t.via, t.model, t.language].filter(Boolean).join(" · ");
  const out = [`## Transcripción (literal${how ? `, ${how}` : ""})`, ""];
  const speech = (t.segments || []).filter((s) => s.end_s > from && s.start_s < to);
  if (!speech.length) {
    out.push(t.status === "no_audio" ? "(el vídeo no tiene audio)" : t.status === "no_speech" ? "(no se detectó voz)"
      : `(sin transcripción: ${t.error || t.status || "no disponible"})`);
    return out.join("\n");
  }
  for (const p of paragraphs(speech)) out.push(`[${clock(p.start_s)}] ${p.text}`, "");
  return out.join("\n").trimEnd();
}

/** The whole dossier. */
export function renderDigest(m, tokens = {}) {
  return [renderCard(m, tokens), renderIndex(m), renderVisual(m), renderTranscript(m)].join("\n\n---\n\n") + "\n";
}
