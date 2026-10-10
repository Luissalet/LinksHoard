import React, { useRef, useState, useEffect } from "react";
import { api } from "../api.js";

export default function ArticleQuestions({ link, onReload, onCitation }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const request = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; }; }, []);
  const ask = async (e) => {
    e.preventDefault();
    if (!question.trim() || busy) return;
    const epoch = ++request.current;
    setBusy(true); setError(""); setAnswer(null);
    try {
      const result = await api.links.ask(link.id, { question: question.trim() });
      if (active.current && epoch === request.current) setAnswer(result);
    } catch (e) {
      if (active.current && epoch === request.current) setError(e.message);
    } finally {
      if (active.current && epoch === request.current) setBusy(false);
    }
  };
  const changed = answer && (answer.status === "source_changed" || answer.source_version !== link.article_source.version);
  return <section className="article-questions" aria-labelledby="article-question-title">
    <h2 id="article-question-title" className="text-[16px] font-semibold">Preguntar al artículo</h2>
    <p className="help mt-1 text-[13px]">La respuesta enlaza a citas del texto guardado. Puedes comprobar su interpretación en el párrafo original.</p>
    <form onSubmit={ask} className="mt-3">
      <label className="label" htmlFor="article-question">Tu pregunta</label>
      <textarea id="article-question" className="field mt-1" rows={2} maxLength={2000} required
        value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="¿Qué argumentos aporta el artículo?" />
      <button className="btn btn-primary mt-2" type="submit" disabled={busy || !question.trim() || link.fetch_status !== "ok"}>
        {busy ? "Buscando en el texto…" : "Preguntar"}
      </button>
    </form>
    <div aria-live="polite" aria-busy={busy} className="mt-3">
      {error && <p role="alert" className="article-answer-warning">{error}</p>}
      {changed ? <div><p className="article-answer-warning">El artículo ha cambiado. Recárgalo para comprobar las citas y volver a preguntar.</p>
        <button className="btn btn-sm mt-2" type="button" onClick={onReload}>Recargar artículo</button></div>
        : answer && <>
          <p className="help mb-2">Respuesta a: {answer.question}</p>
          {answer.coverage?.partial && <p className="article-answer-warning mb-2">Solo se ha consultado parte del texto ({answer.coverage.included_chars.toLocaleString("es-ES")} de {answer.coverage.total_chars.toLocaleString("es-ES")} caracteres).</p>}
          {answer.message && <p className="help mb-2">{answer.message}</p>}
          {answer.sentences.map((sentence, i) => <p key={i} className="article-answer-sentence">
            {sentence.text}{" "}{sentence.citations.map((citation, j) => <React.Fragment key={j}>
              <a className="article-citation" href={citation.reader_url} title={citation.quote} onClick={() => onCitation(citation.paragraph_id, answer.source_version)}
                aria-label={`Ver párrafo ${citation.paragraph_index}: ${citation.quote}`}>
                Párrafo {citation.paragraph_index}
              </a>{" "}
            </React.Fragment>)}
          </p>)}
        </>}
    </div>
  </section>;
}
