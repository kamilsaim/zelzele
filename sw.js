/**
 * Zelzele service worker.
 *
 * Iki isi var:
 *  1. Onbellek. Uygulama kabugu onbellekten acilir (internetsiz de calisir),
 *     deprem verisi ise her zaman once agdan istenir — bayat deprem verisi
 *     gostermek yaniltici olur.
 *  2. Push. Sunucudan gelen bildirimi gosterir ve tiklaninca uygulamayi
 *     ilgili depremde acar.
 */

const VERSION = 'v11';
const SHELL = `zelzele-shell-${VERSION}`;
const DATA = `zelzele-data-${VERSION}`;
const TILES = `zelzele-tiles-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/util.js',
  './js/config.js',
  './js/state.js',
  './js/data.js',
  './js/map.js',
  './js/list.js',
  './js/analysis.js',
  './js/notify.js',
  './js/home.js',
  './js/detail.js',
  './js/safearea.js',
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
      .then(() => self.clients.claim())
      // Yeni surum devraldiginda acik sekmeler eski kodla kalmasin
      .then(async () => {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.postMessage({ type: 'sw-updated' });
      }),
  );
});

/* --------------------------------------------------------------- fetch */

/** Once ag, olmazsa onbellek. Guncelligi onemli olan istekler icin. */
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

  // Canli API'ler ve push sunucusu onbelleklenmez
  if (/afad\.gov\.tr|orhanayd\.com|supabase\.co/.test(url.hostname)) return;

  if (url.pathname.endsWith('latest.json') || url.pathname.includes('/data/')) {
    e.respondWith(networkFirst(request, DATA));
    return;
  }

  if (url.hostname.includes('basemaps.cartocdn.com')) {
    e.respondWith(staleWhileRevalidate(request, TILES));
    return;
  }

  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() =>
        caches.match('./index.html', { cacheName: SHELL })
          .then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  /*
   * Kendi HTML/JS dosyalarimiz ve manifest once agdan gelmeli.
   *
   * Onbellekten verirsek yeni index.html ile eski app.js ayni sayfada
   * bulusabiliyor ve uygulama artik var olmayan bir fonksiyonu cagirip
   * aciliyor. Dosyalar kucuk; agdan almanin maliyeti bu riske degmez.
   * Ag yoksa onbellek yine devrede, cevrimdisi calisma bozulmuyor.
   */
  if (url.origin === self.location.origin && /(\.(js|html)|manifest\.json)$/.test(url.pathname)) {
    e.respondWith(networkFirst(request, SHELL));
    return;
  }

  // Ikonlar ve CDN kutuphaneleri surumle birlikte degismiyor
  e.respondWith(staleWhileRevalidate(request, SHELL));
});

/* ---------------------------------------------------------------- push */

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'Zelzele', body: e.data?.text() || 'Yeni deprem kaydedildi' };
  }

  const title = data.title || 'Zelzele';
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    // Ayni deprem iki kez gelirse tek bildirim olarak birlessin
    tag: data.id || 'zelzele',
    renotify: true,
    // Buyuk depremlerde kullanici gorene kadar ekranda kalsin
    requireInteraction: (data.mag ?? 0) >= 5,
    vibrate: [200, 90, 200, 90, 400],
    timestamp: data.time ? new Date(data.time).getTime() : Date.now(),
    data: { id: data.id, url: data.url || './' },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { id, url } = e.notification.data || {};

  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: 'window', includeUncontrolled: true,
    });

    // Uygulama zaten aciksa yeni sekme acma, oradaki depreme git
    for (const client of clients) {
      if (client.url.includes(self.registration.scope)) {
        await client.focus();
        if (id) client.postMessage({ type: 'focus-quake', id });
        return;
      }
    }
    await self.clients.openWindow(url || './');
  })());
});
