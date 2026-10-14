import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Section, Field } from "./ui.jsx";

/** Settings of the video digest (server/videodigest.js). */
export default function DigestSettings({ run, busy }) {
  const [s, setS] = useState(null);
  useEffect(() => { api.videoDigest.settings().then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    const out = await run(() => api.videoDigest.saveSettings({
      export_dir: s.export_dir.trim(), download_height: Number(s.download_height), ocr: !!s.ocr, ocr_lang: s.ocr_lang,
      vision: !!s.vision, vision_max: Number(s.vision_max), llm: !!s.llm, summary_lang: s.summary_lang,
    }), "Ajustes del digest guardados.");
    if (out) setS(out);
  };
  return (
    <Section title="Digest de vídeos" className="mt-4">
      <form onSubmit={save} className="grid gap-3">
        <Field label="Copiar cada digest también a" help="Opcional. Una carpeta donde dejar una copia de cada digest (fecha-título), para leerla desde otro sitio. Vacío = solo en la carpeta de datos.">
          <input className="field" value={s.export_dir} onChange={(e) => set("export_dir", e.target.value)} placeholder="D:\\digests" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Calidad al descargar" help="Más resolución = texto en pantalla más legible.">
            <select className="field" value={s.download_height} onChange={(e) => set("download_height", e.target.value)}>
              {[480, 720, 1080].map((h) => <option key={h} value={h}>{h}p</option>)}
            </select>
          </Field>
          <Field label="Idioma del resumen">
            <select className="field" value={s.summary_lang} onChange={(e) => set("summary_lang", e.target.value)}>
              <option value="es">Español</option><option value="en">English</option>
            </select>
          </Field>
          <Field label="Planos descritos como máximo" help="Con un modelo de visión servido.">
            <input className="field" type="number" min="0" max="400" value={s.vision_max} onChange={(e) => set("vision_max", e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!s.ocr} onChange={(e) => set("ocr", e.target.checked)} /> Leer el texto en pantalla (OCR de Kafka's Hoard o Tesseract)</label>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!s.vision} onChange={(e) => set("vision", e.target.checked)} /> Describir los planos con un modelo de visión (si el Hub sirve uno)</label>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!s.llm} onChange={(e) => set("llm", e.target.checked)} /> Capítulos y resumen con el modelo de texto del Hub</label>
        <div><button type="submit" className="btn btn-primary" disabled={busy}>Guardar</button></div>
      </form>
    </Section>
  );
}
