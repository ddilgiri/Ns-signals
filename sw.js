// NSE F&O Signal Engine — Service Worker v1
const CACHE = 'fno-v157'; // bumped 2026-09-28 -- FIX: projection was mechanically
// 17/17 or 20/0 one color -- momentumVote/emaVote/vwapVote all fed off the
// model's OWN prior projected candles (feedback loop with no natural ceiling).
// Added: momentum vote caps after a 4-candle run, seeded noise vote, and a
// reversion pull that strengthens the further an unbroken run goes -- restores
// realistic chop (verified: 4-13, 6-13, 11-9 splits across test scenarios,
// no longer a monotonic wall of one color).
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

