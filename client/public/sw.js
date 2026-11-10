const CACHE_NAME = 'dogfight-v1.0.0';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/ship.png',
  '/asteroid.png',
  '/shoot.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Do not intercept or cache WebSocket, API, health, or metrics requests
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname === '/metrics' ||
    url.pathname === '/health' ||
    url.pathname === '/ready'
  ) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => caches.match('/index.html'))
      );
    })
  );
});
