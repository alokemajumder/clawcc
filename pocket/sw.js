'use strict';

const CACHE_NAME = 'clawcc-pocket-v1';
const ASSETS = [
  '/pocket/',
  '/pocket/index.html',
  '/pocket/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'ClawCC Alert', body: 'New notification' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'ClawCC Alert', {
      body: data.body || '',
      tag: data.tag || 'clawcc-alert',
      data: data.url || '/pocket/'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      if (windowClients.length > 0) {
        windowClients[0].focus();
      } else {
        clients.openWindow(event.notification.data || '/pocket/');
      }
    })
  );
});
