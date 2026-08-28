/**
 * Veri katmani.
 *
 * Uc kaynak paralel denenir:
 *   1. data/latest.json  — ayni origin, her zaman calisir (GitHub Actions tazeler)
 *   2. AFAD apiv2        — canli, ama CORS'a takilabilir
 *   3. Kandilli aynasi   — canli, ucuncu tarafin hizmeti, kapanabilir
 *
 * Hangisi/hangileri yanit verirse kayitlar birlestirilir ve ayni deprem
 * tekillestirilir. Hicbiri tutmazsa eldeki veri korunur.
 */

import { withTimeout } from './util.js';
import { PROVINCES } from './config.js';

/* --------------------------------------------------------- normallestirme */

/** ASCII'ye indirger: "Kütahya" -> "KUTAHYA" */
function foldHard(s) {
  return String(s)
    .replace(/[ıİi]/g, 'I').replace(/[şŞ]/g, 'S').replace(/[ğĞ]/g, 'G')
    .replace(/[üÜ]/g, 'U').replace(/[öÖ]/g, 'O').replace(/[çÇ]/g, 'C')
    .toUpperCase().replace(/[^A-Z]/g, '');
}

const PROVINCE_BY_FOLD = new Map(PROVINCES.map((p) => [foldHard(p), p]));

/** AFAD "KUTAHYA", Kandilli "Kütahya" yaziyor — tek yazima indir */
export function normProvince(raw) {
  if (!raw) return '';
  return PROVINCE_BY_FOLD.get(foldHard(raw)) || String(raw).trim();
}

/** Farkli kaynaklarin alanlarini tek bicime indirger; bozuk kayda null doner */
function normalize(raw, fallbackSource) {
  const lat = Number(raw.lat), lon = Number(raw.lon), mag = Number(raw.mag);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) return null;
  return {
    id: raw.id,
    time: raw.time,
    lat, lon, mag,
    depth: Number(raw.depth) || 0,
    magType: raw.magType || 'ML',
    place: raw.place || '',
    province: normProvince(raw.province),
    source: raw.source || fallbackSource,
    alsoIn: raw.alsoIn || [],
  };
}

/* ------------------------------------------------------------- kaynaklar */

/** 1. Depodaki JSON — ayni origin oldugu icin CORS yok, taban veri budur */
async function loadRepo() {
  const res = await fetch(`data/latest.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return {
    updated: json.updated,
    quakes: (json.quakes || []).map((q) => normalize(q, 'REPO')).filter(Boolean),
  };
}

const pad = (n) => String(n).padStart(2, '0');
const afadStamp = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** 2. AFAD canli ucu. CORS basligi yoksa tarayici engeller — beklenen durum. */
async function loadAfadLive() {
  const end = new Date();
  const start = new Date(end - 36 * 3600 * 1000);
  const url = 'https://deprem.afad.gov.tr/apiv2/event/filter' +
    `?start=${encodeURIComponent(afadStamp(start))}&end=${encodeURIComponent(afadStamp(end))}` +
    '&minlat=34&maxlat=43.5&minlon=24&maxlon=46.5&orderby=timedesc&limit=800';

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('beklenmeyen gövde');

  return rows.map((r) => normalize({
    id: `afad-${r.eventID}`,
    time: new Date(`${String(r.date).replace(' ', 'T').replace(/Z$/, '')}Z`).toISOString(),
    lat: r.latitude, lon: r.longitude, depth: r.depth, mag: r.magnitude,
    magType: (r.type || 'ML').toUpperCase(),
    place: (r.location || '').trim(),
    province: (r.province || '').trim(),
    source: 'AFAD',
  })).filter(Boolean);
}

/** 3. Kandilli topluluk aynasi — acik kalirsa canli, kapanirsa atlanir */
async function loadKoeriLive() {
  const res = await fetch('https://api.orhanayd.com/kandilli-rasathanesi-api/live.php');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.result || json.data || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('boş yanıt');

  return rows.map((r) => {
    // Ayna TSI (UTC+3) saatiyle "YYYY.MM.DD HH:mm:ss" doner
    const m = String(r.date || '').match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]));
    const place = (r.title || r.location || '').replace(/\s+/g, ' ').trim();
    const mag = Number(r.mag ?? r.ml ?? r.size?.ml);
    return normalize({
      id: `koeri-${t.getTime()}-${r.latitude}-${r.longitude}`,
      time: t.toISOString(), lat: r.latitude, lon: r.longitude,
      depth: r.depth, mag, magType: 'ML', place,
      province: place.match(/\(([^)]+)\)\s*$/)?.[1]?.split('-').pop()?.trim() || '',
      source: 'KOERI',
    });
  }).filter(Boolean);
}

/* ----------------------------------------------------------- birlestirme */

/**
 * Ayni depremin farkli kaynaklardaki kaydini tek kayda indirger.
 * Esik: 90 saniye, 20 km, 1.0 buyukluk farki. Ilk goren (en yeni siralamada
 * once gelen) kayit tutulur, digeri `alsoIn` olarak isaretlenir.
 */
export function mergeQuakes(lists) {
  const all = lists.flat().sort((a, b) => new Date(b.time) - new Date(a.time));
  const kept = [];
  const seen = new Set();

  for (const q of all) {
    if (seen.has(q.id)) continue;
    const t = new Date(q.time).getTime();

    const dup = kept.find((k) => {
      if (Math.abs(new Date(k.time).getTime() - t) > 90000) return false;
      if (Math.abs(k.mag - q.mag) > 1.0) return false;
      const dLat = (k.lat - q.lat) * 111;
      const dLon = (k.lon - q.lon) * 111 * Math.cos(q.lat * Math.PI / 180);
      return Math.hypot(dLat, dLon) < 20;
    });

    if (dup) {
      if (dup.source !== q.source && !dup.alsoIn.includes(q.source)) dup.alsoIn.push(q.source);
      // Daha tarifli yer adini sakla
      if (q.place.length > dup.place.length) dup.place = q.place;
      if (!dup.province && q.province) dup.province = q.province;
      continue;
    }
    seen.add(q.id);
    kept.push(q);
  }
  return kept;
}

/**
 * Push bildirimiyle gelip service worker'in onbellege yazdigi depremler.
 *
 * Neden gerekli: data/latest.json GitHub Actions ile guncelleniyor ve bu
 * bazen saatlerce gecikebiliyor. Push ise sunucudan canli gonderiliyor —
 * bu yuzden genelde depodaki veriden daha guncel. Bu kayitlari diger
 * kaynaklarla birlestirmezsek, kullanici bildirimi gorup uygulamayi actiginda
 * o depremi bulamaz.
 */
async function loadPending() {
  if (!('caches' in self)) return [];
  try {
    const cache = await self.caches.open('zelzele-pending');
    const res = await cache.match('/__pending_quakes__');
    if (!res) return [];
    const list = await res.json();
    return list.map((q) => normalize(q, 'PUSH')).filter(Boolean);
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- cekim */

/**
 * Tum kaynaklari paralel dener.
 * @returns {{ok: boolean, quakes: [], sources: {}, updated: string|null}}
 */
export async function fetchAll() {
  const attempts = [
    ['repo', loadRepo(), 8000],
    ['afad', loadAfadLive(), 9000],
    ['koeri', loadKoeriLive(), 9000],
  ];

  const [results, pending] = await Promise.all([
    Promise.all(attempts.map(async ([name, promise, ms]) => {
      try {
        const out = await withTimeout(promise, ms, name);
        return {
          name, ok: true,
          quakes: Array.isArray(out) ? out : out.quakes,
          updated: out.updated,
        };
      } catch (err) {
        return { name, ok: false, error: err.message || String(err), quakes: [] };
      }
    })),
    loadPending(),
  ]);

  const sources = Object.fromEntries(results.map((r) =>
    [r.name, r.ok ? { ok: true, count: r.quakes.length } : { ok: false, error: r.error }]));

  const good = results.filter((r) => r.ok && r.quakes.length);
  if (!good.length && !pending.length) return { ok: false, quakes: [], sources, updated: null };

  const lists = good.map((r) => r.quakes);
  if (pending.length) lists.push(pending);

  return {
    ok: true,
    quakes: mergeQuakes(lists),
    sources,
    updated: good.find((r) => r.name === 'repo')?.updated || new Date().toISOString(),
    live: good.some((r) => r.name !== 'repo') || pending.length > 0,
  };
}
