// Tiny HTML page for the PWA share target and the bookmarklet: saves the
// shared URL and shows "Guardado" (or the reason it failed).
function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderSharePage({ ok, existing, link, message }) {
  const heading = ok ? "Guardado" : "No se pudo guardar";
  const body = ok
    ? `<p>${escapeHtml(existing ? "Ya lo tenías guardado." : "Se ha añadido a tu Bandeja.")}</p>
       <p class="title">${escapeHtml(link.url_original)}</p>`
    : `<p>${escapeHtml(message || "Inténtalo de nuevo.")}</p>`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${heading} · Links Hoard</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; background: #f7f7fb; color: #232336; margin: 0; padding: 40px 20px; text-align: center; }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border: 1px solid #e2e2ee; border-radius: 12px; padding: 32px 24px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  .title { font-size: 13px; color: #5b5b73; word-break: break-all; }
  a { color: #2f5d8a; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    ${body}
    <p><a href="/#/bandeja">Volver a Links Hoard</a></p>
  </div>
</body>
</html>`;
}
