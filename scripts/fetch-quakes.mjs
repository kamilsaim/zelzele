#!/usr/bin/env node
/**
 * AFAD + Kandilli (KOERI) deprem verisini cekip data/latest.json olarak yazar.
 * GitHub Actions icinde calisir; tarayici degil, o yuzden CORS yok.
 *
 * Cikti formati (tek tip, kaynaklar birlestirilmis ve tekillestirilmis):
 *   { updated: ISO8601, sources: {...}, count: n, quakes: [Quake, ...] }
 *   Quake = { id, time (ISO8601 UTC), lat, lon, depth, mag, magType, place, province, source }
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/latest.json');

/** Kac gun geriye gidilsin */
const DAYS = Number(process.env.DAYS || 30);
/** Turkiye ve yakin cevresi sinirlari */
const BOUNDS = { minLat: 34.0, maxLat: 43.5, minLon: 24.0, maxLon: 46.5 };

const UA = 'deprem-haritasi/1.0 (+https://github.com)';

// ---------------------------------------------------------------- yardimcilar

function pad(n) {
  return String(n).padStart(2, '0');
}

/** AFAD'in bekledigi "YYYY-MM-DD HH:mm:ss" formati (UTC) */
function afadStamp(d) {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** AFAD ve KOERI il adlarini farkli yaziyor (KUTAHYA / Kütahya). Tek yazima indir. */
const PROVINCES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya',
  'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik',
  'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli',
  'Diyarbakır', 'Düzce', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep',
  'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Iğdır', 'Isparta', 'İstanbul', 'İzmir',
  'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu', 'Kayseri', 'Kilis', 'Kırıkkale',
  'Kırklareli', 'Kırşehir', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Mardin',
  'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye', 'Rize', 'Sakarya',
  'Samsun', 'Şanlıurfa', 'Siirt', 'Sinop', 'Sivas', 'Şırnak', 'Tekirdağ', 'Tokat', 'Trabzon',
  'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak',
];

/** Turkce harfleri ASCII'ye indirip buyuk harfe cevirir: "Kütahya" -> "KUTAHYA" */
function fold(s) {
  return String(s)
    .replace(/[ıİi]/g, 'I').replace(/[şŞ]/g, 'S').replace(/[ğĞ]/g, 'G')
    .replace(/[üÜ]/g, 'U').replace(/[öÖ]/g, 'O').replace(/[çÇ]/g, 'C')
    .toUpperCase().replace(/[^A-Z]/g, '');
}

const PROVINCE_BY_FOLD = new Map(PROVINCES.map((p) => [fold(p), p]));

function normProvince(raw) {
  if (!raw) return '';
  return PROVINCE_BY_FOLD.get(fold(raw)) || raw.trim();
}

function inBounds(lat, lon) {
  return (
    lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat &&
    lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon
  );
}

async function get(url, { text = false, timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: text ? 'text/html,*/*' : 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (text) {
      // KOERI sayfasi ISO-8859-9 (Turkce) kodlu geliyor
      const buf = await res.arrayBuffer();
      return new TextDecoder('iso-8859-9').decode(buf);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------- AFAD

async function fetchAfad() {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 864e5);
  const url =
    'https://deprem.afad.gov.tr/apiv2/event/filter' +
    `?start=${encodeURIComponent(afadStamp(start))}` +
    `&end=${encodeURIComponent(afadStamp(end))}` +
    `&minlat=${BOUNDS.minLat}&maxlat=${BOUNDS.maxLat}` +
    `&minlon=${BOUNDS.minLon}&maxlon=${BOUNDS.maxLon}` +
    '&orderby=timedesc&limit=5000';

  const rows = await get(url);
  if (!Array.isArray(rows)) throw new Error('AFAD beklenmeyen govde');

  return rows.map((r) => {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    return {
      id: `afad-${r.eventID}`,
      // AFAD "date" alani UTC, sonunda Z olmadan geliyor
      time: new Date(`${String(r.date).replace(' ', 'T').replace(/Z$/, '')}Z`).toISOString(),
      lat,
      lon,
      depth: Number(r.depth),
      mag: Number(r.magnitude),
      magType: (r.type || 'ML').toUpperCase(),
      place: (r.location || '').trim(),
      province: normProvince(r.province),
      source: 'AFAD',
    };
  });
}

// -------------------------------------------------------------------- KOERI

/**
 * KOERI son 500 depremi sabit genislikli metin olarak yayinliyor.
 * Satir orn:
 * 2026.08.14 09:12:33  38.1234   26.5678      7.2   -.-  2.1  -.-   YER ADI (IL)   Ilksel
 */
function parseKoeri(html) {
  const pre = html.split('<pre>')[1]?.split('</pre>')[0];
  if (!pre) throw new Error('KOERI <pre> blogu bulunamadi');

  const line =
    /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+(-\.-|[\d.]+)\s+(-\.-|[\d.]+)\s+(-\.-|[\d.]+)\s+(.+?)\s{2,}(\S.*)$/;

  const out = [];
  for (const raw of pre.split('\n')) {
    const m = raw.trim().match(line);
    if (!m) continue;
    const [, y, mo, d, hh, mm, ss, lat, lon, depth, md, ml, mw, place, quality] = m;

    // KOERI saatleri TSI (UTC+3)
    const time = new Date(Date.UTC(+y, +mo - 1, +d, +hh - 3, +mm, +ss));

    const num = (v) => (v === '-.-' ? null : Number(v));
    const mag = num(mw) ?? num(ml) ?? num(md);
    if (mag == null) continue;
    const magType = num(mw) != null ? 'MW' : num(ml) != null ? 'ML' : 'MD';

    const cleaned = place.replace(/\s+/g, ' ').trim();
    const province = normProvince(
      cleaned.match(/\(([^)]+)\)\s*$/)?.[1]?.split('-').pop()?.trim() || '',
    );

    out.push({
      // KOERI'nin kararli bir event id'si yok; zaman+konumdan uretiyoruz
      id: `koeri-${time.getTime()}-${lat}-${lon}`,
      time: time.toISOString(),
      lat: Number(lat),
      lon: Number(lon),
      depth: Number(depth),
      mag,
      magType,
      place: cleaned,
      province,
      source: 'KOERI',
      revised: !/ilksel/i.test(quality),
    });
  }
  if (!out.length) throw new Error('KOERI: hic satir ayristirilamadi');
  return out;
}

async function fetchKoeri() {
  const html = await get('http://www.koeri.boun.edu.tr/scripts/lst0.asp', { text: true });
  return parseKoeri(html);
}

// ------------------------------------------------------------- birlestirme

/**
 * Ayni depremi iki kaynak da bildirdiginde tek kayda indirger.
 * Esik: 90 saniye ve ~20 km icinde, buyukluk farki 1.0'dan kucuk.
 */
function dedupe(quakes) {
  const sorted = [...quakes].sort((a, b) => new Date(b.time) - new Date(a.time));
  const kept = [];

  for (const q of sorted) {
    const t = new Date(q.time).getTime();
    const dup = kept.find((k) => {
      const dt = Math.abs(new Date(k.time).getTime() - t);
      if (dt > 90_000) return false;
      if (Math.abs(k.mag - q.mag) > 1.0) return false;
      const dLat = (k.lat - q.lat) * 111;
      const dLon = (k.lon - q.lon) * 111 * Math.cos((q.lat * Math.PI) / 180);
      return Math.hypot(dLat, dLon) < 20;
    });

    if (!dup) {
      kept.push(q);
      continue;
    }
    // AFAD kaydini otorite kabul et, ama KOERI'nin yer adi daha tarifliyse sakla
    dup.alsoIn = [...new Set([...(dup.alsoIn || []), q.source])];
    if (q.place.length > (dup.place || '').length) dup.place = q.place;
  }
  return kept;
}

// --------------------------------------------------------------------- main

async function main() {
  const sources = {};
  const collected = [];

  // AFAD once: resmi kaynak, event id'si kararli
  for (const [name, fn] of [['afad', fetchAfad], ['koeri', fetchKoeri]]) {
    try {
      const rows = (await fn()).filter(
        (q) => Number.isFinite(q.lat) && Number.isFinite(q.lon) &&
               Number.isFinite(q.mag) && inBounds(q.lat, q.lon),
      );
      collected.push(...rows);
      sources[name] = { ok: true, count: rows.length };
      console.log(`${name}: ${rows.length} kayit`);
    } catch (err) {
      sources[name] = { ok: false, error: String(err.message || err) };
      console.error(`${name} basarisiz: ${err.message}`);
    }
  }

  if (!collected.length) {
    // Her iki kaynak da coktuyse mevcut dosyayi ezme
    console.error('Hicbir kaynaktan veri alinamadi; latest.json korunuyor.');
    process.exit(1);
  }

  const quakes = dedupe(collected).slice(0, 4000);
  const payload = {
    updated: new Date().toISOString(),
    sources,
    days: DAYS,
    count: quakes.length,
    quakes,
  };

  // Icerik degismediyse gereksiz commit uretme
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'));
    const same =
      prev.count === payload.count &&
      prev.quakes?.[0]?.id === payload.quakes[0]?.id &&
      prev.quakes?.[0]?.mag === payload.quakes[0]?.mag;
    if (same) {
      console.log('Degisiklik yok, dosya guncellenmedi.');
      return;
    }
  } catch { /* ilk calistirma */ }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), 'utf8');
  console.log(`Yazildi: ${quakes.length} deprem -> data/latest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
