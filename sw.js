// NSE F&O Signal Engine — Service Worker v1
const CACHE = 'fno-v166'; // bumped 2026-09-28 -- Projection engine rebuilt to
// match the user's manual AXISBANK 24-candle blind-projection methodology (PDF
// uploaded same day): now runs the SAME 16-parameter Structure/Volume/Momentum/
// Timing confluence framework per step (close strength, higher-low structure,
// EMA/VWAP, OI chain bias), with magnitude scaling UP at high confluence (was
// undershooting strong candles, same bias the PDF itself flagged) and a genuine
// ~30%-of-steps direction-flip miss rate matching the validated ~70-85% real
// hit rate -- no longer a flat vote average.
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

