// Links Hoard browser extension: the toolbar button sends the current tab to Links as the browser shows it, then opens it
// folded. A web page goes as its rendered HTML (what you see signed in); a PDF, DOCX or EPUB goes as its bytes, fetched with
// your session. The page is handed to Links from a Links tab of its own, so the app receives it as a same-origin request.
const DEFAULT_URL = "http://127.0.0.1:5181";
const DOCUMENT_URL = /\.(pdf|docx|epub)(?:$|[?#])/i;

async function linksUrl() {
  const { linksUrl: stored } = await chrome.storage.local.get("linksUrl");
  return (stored || DEFAULT_URL).replace(/\/+$/, "");
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** What the tab shows: { url, title, html } for a page, { url, title, data_base64, content_type } for a document. */
async function tabPayload(tab) {
  let page = null;
  if (!DOCUMENT_URL.test(tab.url)) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
        url: location.href, title: document.title, contentType: document.contentType, html: document.documentElement.outerHTML,
      }) });
      page = res?.result || null;
    } catch { page = null; }
  }
  if (page && /html|xml/i.test(page.contentType || "")) return { url: page.url, title: page.title, html: page.html };
  const response = await fetch(tab.url, { credentials: "include" });
  if (!response.ok) throw new Error(`No se pudo leer el documento (HTTP ${response.status}).`);
  return { url: tab.url, title: tab.title || "", content_type: response.headers.get("content-type") || "", data_base64: base64(await response.arrayBuffer()) };
}

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => { if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); } });
  });
}

/** Send a tab to Links and show it folded; returns what Links answered. */
async function captureTab(tab) {
  const payload = await tabPayload(tab);
  const base = await linksUrl();
  const target = await chrome.tabs.create({ url: `${base}/#/bandeja`, index: tab.index + 1, active: true });
  await waitLoaded(target.id);
  const [res] = await chrome.scripting.executeScript({ target: { tabId: target.id }, world: "MAIN", args: [payload], func: async (body) => {
    const response = await fetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: out.error || `HTTP ${response.status}` };
    location.hash = out.reader_url;
    return { ok: true, id: out.id, title: out.title, existing: out.existing, word_count: out.word_count, kind: out.kind };
  } });
  return res?.result || { ok: false, error: "Links no respondió." };
}

async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const out = await captureTab(tab);
    await badge(out.ok ? "✓" : "!", out.ok ? "#3a7a52" : "#a8322f");
    if (!out.ok) await chrome.action.setTitle({ title: `Links Hoard: ${out.error}` });
  } catch (error) {
    await badge("!", "#a8322f");
    await chrome.action.setTitle({ title: `Links Hoard: ${error.message}` });
  }
});

// for the options page and for scripted use
self.captureTab = captureTab;
