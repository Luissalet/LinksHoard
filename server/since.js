// "Since when" as people and assistants say it. The family shares one
// vocabulary (an ISO date, an age like "2h" or "hace 3 días", a word like
// "hoy", "esta semana", "last month", or epoch seconds): it lives in the
// vendored hoard-link.js, the same words hoard_link/since.py accepts in the
// Python apps. Returns an ISO timestamp comparable with saved_at, or null.
export { resolveSince, SINCE_HELP } from "./hoard-link.js";
