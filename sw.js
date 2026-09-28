// NSE F&O Signal Engine — Service Worker v1
const CACHE = 'fno-v155'; // bumped 2026-09-28 -- FIX: VWAP was frozen at the real
// session's VWAP for every projected candle (never rolled forward like EMA20/50
// were), so once price projected away from it the VWAP-vote kept firing the SAME
// direction every step, self-reinforcing an artificial monotonic red/green run.
// VWAP now rolls forward with each projected candle's typical price, same as EMA.
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

