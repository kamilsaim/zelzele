/**
 * Service worker.
 *
 * Iki farkli strateji:
 *  - Uygulama kabugu (html/css/js/ikon/harita karolari): once onbellek, arkada tazele.
 *    Uygulama internetsiz de aciliyor.
 *  - Deprem verisi (data/*.json): once ag. Guncel veri her zaman onceliklidir;
 *    ag yoksa son basarili yanit gosterilir (bayat ama hic yoktan iyi).
 */

const VERSION = 'v1';
const SHELL = `deprem-shell-${VERSION}`;
const DATA = `deprem-data-${VERSION}`;
const TILES = `deprem-tiles-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // Tek bir CDN dosyasi patlarsa kurulum komple basarisiz olmasin
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => ![SHELL, DATA, TILES].includes(k)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/** Once ag, basarisiz olursa onbellek. Guncellik onemli olan istekler icin. */
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

/** Once onbellek, arka planda tazele. Nadiren degisen varliklar icin. */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Canli API'ler asla onbelleklenmez — bayat deprem verisi yaniltici olur
  if (url.hostname.includes('afad.gov.tr') || url.hostname.includes('orhanayd.com')) return;

  // Depo verisi: her zaman once ag
  if (url.pathname.endsWith('latest.json') || url.pathname.includes('/data/')) {
    e.respondWith(networkFirst(request, DATA));
    return;
  }

  // Harita karolari: onbellekten hizli gelsin
  if (url.hostname.includes('basemaps.cartocdn.com')) {
    e.respondWith(staleWhileRevalidate(request, TILES));
    return;
  }

  // Sayfa gezinmeleri: agdan dene, yoksa onbellekteki uygulamayi ac
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() => caches.match('./index.html', { cacheName: SHELL })
        .then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  e.respondWith(staleWhileRevalidate(request, SHELL));
});
