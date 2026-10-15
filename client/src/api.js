// Thin fetch wrapper. Every error surfaces as an Error with the server message.
async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw Object.assign(new Error(data?.error || `Error ${response.status}`), { status: response.status });
  return data;
}

const qs = (params) => {
  const clean = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return clean.length ? `?${new URLSearchParams(clean)}` : "";
};

export const api = {
  state: () => request("GET", "/api/state"),
  links: {
    list: (filter) => request("GET", `/api/links${qs(filter)}`),
    get: (id) => request("GET", `/api/links/${id}`),
    ask: (id, data) => request("POST", `/api/links/${id}/ask`, data),
    create: (data) => request("POST", "/api/links", data),
    update: (id, data) => request("PATCH", `/api/links/${id}`, data),
    remove: (id) => request("DELETE", `/api/links/${id}`),
    read: (id) => request("POST", `/api/links/${id}/read`),
    unread: (id) => request("POST", `/api/links/${id}/unread`),
    archive: (id, archived = true) => request("POST", `/api/links/${id}/archive`, { archived }),
    favorite: (id, favorite = true) => request("POST", `/api/links/${id}/favorite`, { favorite }),
    refetch: (id) => request("POST", `/api/links/${id}/refetch`),
    video: (id) => request("GET", `/api/links/${id}/video`),
    analyzeVideo: (id, data = {}) => request("POST", `/api/links/${id}/video/analyze`, data),
    uploadVideo: async (id, file) => {
      const response = await fetch(`/api/links/${id}/video/file?name=${encodeURIComponent(file.name)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
      return data;
    },
  },
  highlights: {
    list: (linkId) => request("GET", `/api/links/${linkId}/highlights`),
    create: (linkId, data) => request("POST", `/api/links/${linkId}/highlights`, data),
    update: (id, data) => request("PATCH", `/api/highlights/${id}`, data),
    remove: (id) => request("DELETE", `/api/highlights/${id}`),
    toCards: (id, deck) => request("POST", `/api/highlights/${id}/to-cards`, deck ? { deck } : {}),
    linkToCards: (linkId, deck) => request("POST", `/api/links/${linkId}/cards`, deck ? { deck } : {}),
  },
  videoSearch: (q) => request("GET", `/api/video/search${qs({ q })}`),
  videoDigest: {
    start: (data) => request("POST", "/api/video-digests", data),
    list: () => request("GET", "/api/video-digests"),
    get: (id, level, range = {}) => request("GET", `/api/links/${id}/digest${qs({ level, ...range })}`),
    run: (id, data = {}) => request("POST", `/api/links/${id}/digest`, data),
    ask: (id, question) => request("POST", `/api/links/${id}/digest/ask`, { question }),
    search: (q, id) => request("GET", `/api/video-digests/search${qs({ q, id })}`),
    settings: () => request("GET", "/api/video-digests/settings"),
    saveSettings: (data) => request("PUT", "/api/video-digests/settings", data),
    fileUrl: (id, name) => `/api/links/${id}/digest/files/${name}`,
    frameUrl: (id, t, width = 960) => `/api/links/${id}/digest/frame${qs({ t, width })}`,
  },
  resurface: (count) => request("GET", `/api/resurface${qs({ count })}`),
  settings: {
    get: () => request("GET", "/api/settings"),
    save: (data) => request("POST", "/api/settings", data),
  },
  watches: {
    list: () => request("GET", "/api/watches"),
    add: (data) => request("POST", "/api/watches", data),
    update: (id, data) => request("PATCH", `/api/watches/${id}`, data),
    remove: (id) => request("DELETE", `/api/watches/${id}`),
    check: (id) => request("POST", `/api/watches/${id}/check`),
    checkDue: () => request("POST", "/api/watches/check"),
    items: (filter) => request("GET", `/api/watch-items${qs(filter)}`),
    dismiss: (id, dismissed = true) => request("POST", `/api/watch-items/${id}/${dismissed ? "dismiss" : "undismiss"}`),
  },
  media: {
    list: (filter) => request("GET", `/api/media${qs(filter)}`),
    get: (id) => request("GET", `/api/media/${id}`),
    start: (data) => request("POST", "/api/media", data),
    cancel: (id) => request("POST", `/api/media/${id}/cancel`),
    retry: (id) => request("POST", `/api/media/${id}/retry`),
    remove: (id, files = false) => request("DELETE", `/api/media/${id}${files ? "?files=1" : ""}`),
    reveal: (id, i = 0) => request("POST", `/api/media/${id}/reveal`, { i }),
    tools: (refresh = false) => request("GET", `/api/media/tools${refresh ? "?refresh=1" : ""}`),
    updateTools: () => request("POST", "/api/media/tools/update", {}),
    settings: () => request("GET", "/api/media/settings"),
    saveSettings: (data) => request("PUT", "/api/media/settings", data),
    fileUrl: (id, i = 0) => `/api/media/${id}/file?i=${i}`,
  },
  sessions: {
    list: () => request("GET", "/api/sessions"),
    login: (site) => request("POST", `/api/sessions/${encodeURIComponent(site)}/login`, {}),
    finish: () => request("POST", "/api/sessions/finish", {}),
    cancel: () => request("POST", "/api/sessions/cancel", {}),
    logout: (site) => request("DELETE", `/api/sessions/${encodeURIComponent(site)}`),
    setBrowser: (browser) => request("PUT", "/api/sessions/settings", { browser }),
  },
  tags: () => request("GET", "/api/tags"),
  sites: () => request("GET", "/api/sites"),
  import: (data) => request("POST", "/api/import", data),
  digest: (since) => request("GET", `/api/digest${qs({ since })}`),
};
