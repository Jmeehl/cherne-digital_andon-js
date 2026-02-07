// public/sw.js
const CACHE_NAME = "cherne-assist-v1";

// Add only truly static assets here.
// You can expand this list later if desired.
const STATIC_ASSETS = [
  "/styles.css",
  "/nav.js",
  "/dashboard.js",
  "/history.js",
  "/cell.js",
  "/assets/logo.svg",
  "/assets/chime.mp3",
  "/assets/cherne-assist-192.png",
  "/assets/cherne-assist-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

// Strategy:
// - API: network-first (fresh data), fallback cache if offline
// - Static: cache-first
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  // Don't interfere with socket.io
  if (url.pathname.startsWith("/socket.io")) return;

  // API calls: network-first
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else: cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});