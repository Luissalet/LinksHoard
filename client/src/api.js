// Thin fetch wrapper. Every error surfaces as an Error with the server message.
async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
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
    create: (data) => request("POST", "/api/links", data),
    update: (id, data) => request("PATCH", `/api/links/${id}`, data),
    remove: (id) => request("DELETE", `/api/links/${id}`),
    read: (id) => request("POST", `/api/links/${id}/read`),
    unread: (id) => request("POST", `/api/links/${id}/unread`),
    archive: (id, archived = true) => request("POST", `/api/links/${id}/archive`, { archived }),
    favorite: (id, favorite = true) => request("POST", `/api/links/${id}/favorite`, { favorite }),
    refetch: (id) => request("POST", `/api/links/${id}/refetch`),
  },
  highlights: {
    list: (linkId) => request("GET", `/api/links/${linkId}/highlights`),
    create: (linkId, data) => request("POST", `/api/links/${linkId}/highlights`, data),
    update: (id, data) => request("PATCH", `/api/highlights/${id}`, data),
    remove: (id) => request("DELETE", `/api/highlights/${id}`),
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
  tags: () => request("GET", "/api/tags"),
  sites: () => request("GET", "/api/sites"),
  import: (data) => request("POST", "/api/import", data),
  digest: (since) => request("GET", `/api/digest${qs({ since })}`),
};
