/** Domain context only. The shared launcher and Faustus own chat and execution. */
export const COPILOT_REFRESH = "links:copilot-refresh";
export const COPILOT_CONTEXT = "links:copilot-context-request";

export function changedFields(before = {}, after) {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key] !== value));
}

export function refreshDraft(before, draft, latest) {
  return before ? { ...latest, ...changedFields(before, draft) } : latest;
}

export async function linksContext({ route, getLink, forms = [], editor = {}, selection = "" }) {
  const match = route.match(/^link\/([^?]+)(?:\?(.*))?$/);
  let link = null;
  if (match && match[1] !== "new") {
    try { link = await getLink(decodeURIComponent(match[1])); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  const query = new URLSearchParams(match?.[2] || "");
  const objects = link ? [{ kind: "link", object_id: String(link.id) }] : [];
  const paragraph = query.get("paragraph");
  if (link && paragraph && query.get("version") === link.article_source?.version &&
      link.article_source.paragraphs.some(p => p.id === paragraph)) {
    objects.push({ kind: "paragraph", object_id: paragraph });
  }
  return {
    ...(link ? { project: { external_project_id: String(link.id), title: link.title || link.url } } : {}),
    active_objects: objects,
    selection: selection ? { kind: "text", text: selection } : null,
    view: { route, section: match ? "reader" : route.split("?")[0], locale: "es",
      forms, editor, native_read_tool: "read_link" },
  };
}

export function viewFields(doc) {
  return [...doc.querySelectorAll("main input, main textarea, main select")]
    .filter(field => !field.readOnly && !["password", "file", "hidden"].includes(field.type))
    .map(field => ({
      label: field.getAttribute("aria-label") || field.closest("label")?.querySelector(".label")?.textContent ||
        field.closest("label")?.textContent.trim() || field.placeholder || field.name || field.tagName.toLowerCase(),
      value: ["checkbox", "radio"].includes(field.type) ? field.checked : field.value,
    }));
}
