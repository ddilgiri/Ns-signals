// NSE F&O Signal Engine — Service Worker v1
const CACHE = 'fno-v139'; // bumped 2026-09-13 -- v4.7 verification bump, chasing a raw-HTML-tags
// display bug in Activity Log (Priority movers line) that couldn't be reproduced from code
// inspection alone; code on GitHub is confirmed correct (addLog html=true flag present).
const ASSETS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Always network-first for API calls
  if (e.request.url.includes('localhost:3001') || e.request.url.includes('angelbroking')) {
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push notification support
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: '⚡ New Signal', body: 'Check the app' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'fno-signal',
      renotify: true
    })
  );
});

