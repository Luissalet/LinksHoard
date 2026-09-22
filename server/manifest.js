// Web app manifest with a share_target (installable on Android, shares
// straight into GET /share) plus a minimal service worker for installability.
export function manifest() {
  return {
    name: "Links Hoard",
    short_name: "Links Hoard",
    start_url: "/#/bandeja",
    display: "standalone",
    background_color: "#f7f7fb",
    theme_color: "#2f5d8a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    share_target: {
      action: "/share",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}

export function serviceWorker() {
  return `// Minimal service worker: enables installability, no offline caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;
}
