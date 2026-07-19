// Minimaler Service Worker: cached die App-Shell als Offline-Fallback.
// WICHTIG: "Network-first" statt "Cache-first" - wir versuchen immer zuerst,
// die aktuelle Version vom Server zu laden, und greifen nur bei fehlender
// Verbindung auf den zwischengespeicherten Stand zurück. So sieht man nach
// einem Deploy sofort die neue Version, statt an einer veralteten Cache-Kopie
// hängen zu bleiben (Datenabrufe über /api/* etc. werden ohnehin nie gecacht).
//
// CACHE_NAME wird bei jedem Update dieser Datei erhöht - das sorgt zusätzlich
// dafür, dass activate() den alten Cache zuverlässig verwirft.
const CACHE_NAME = 'trainingsanalyse-shell-v2';
const SHELL_FILES = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/charts.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/webhook')) {
    return; // niemals cachen - immer live vom Server
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request)) // nur bei Netzwerkfehler auf Cache zurückfallen
  );
});
