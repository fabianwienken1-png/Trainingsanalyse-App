// Minimaler Service Worker: cached die App-Shell für schnelle Ladezeiten und
// Offline-Start (Datenabrufe über /api/* laufen bewusst immer live, kein
// Offline-Caching von Trainingsdaten, damit nie veraltete Werte angezeigt werden).

const CACHE_NAME = 'trainingsanalyse-shell-v1';
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
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
