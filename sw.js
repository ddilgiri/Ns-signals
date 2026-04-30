/**
 * NSE F&O Signal Engine — Service Worker v5
 * ─────────────────────────────────────────
 * Strategy:
 *  • Static assets (HTML, JS, icons, manifest) → cache-first with network update
 *  • All API routes → network-only (never cached)
 *  • POST requests → always network-only
 */

const CACHE_NAME = 'fno-pwa-v5';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// API route prefixes that must NEVER be cached
const API_ROUTES = [
  '/login', '/logout', '/health',
  '/quote', '/candles', '/market-bias', '/market-status',
  '/fii-dii', '/option-chain', '/option-ltp', '/signal-analysis',
  '/news-sentiment', '/mcx', '/pcr',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept non-GET requests
  if (e.request.method !== 'GET') return;

  // Never cache API routes (regardless of hostname)
  if (API_ROUTES.some(p => url.pathname.startsWith(p))) return;

  // Never cache cross-origin requests (CDN, external APIs)
  if (url.origin !== self.location.origin) return;

  // Cache-first for static assets; fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request)
        .then(resp => {
          if (resp.ok && resp.status < 400) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached); // offline fallback to cache
      return cached || networkFetch;
    })
  );
});
