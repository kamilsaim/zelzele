/**
 * Deprem kaynaklari — sunucu tarafi surumu.
 *
 * Tarayicidaki js/data.js ile ayni mantik, ama burada CORS engeli yok:
 * AFAD'in JSON ucunu ve Kandilli'nin metin listesini dogrudan okuyabiliyoruz.
 */

export interface Quake {
  id: string;
  time: string;      // ISO 8601, UTC
  lat: number;
  lon: number;
  depth: number;
  mag: number;
  magType: string;
  place: string;
  province: string;
  source: string;
}

const BOUNDS = { minLat: 34.0, maxLat: 43.5, minLon: 24.0, maxLon: 46.5 };

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

function fold(s: string): string {
  return s
    .replace(/[ıİi]/g, 'I').replace(/[şŞ]/g, 'S').replace(/[ğĞ]/g, 'G')
    .replace(/[üÜ]/g, 'U').replace(/[öÖ]/g, 'O').replace(/[çÇ]/g, 'C')
    .toUpperCase().replace(/[^A-Z]/g, '');
}

const BY_FOLD = new Map(PROVINCES.map((p) => [fold(p), p]));

/** AFAD "KUTAHYA", Kandilli "Kütahya" yaziyor — tek yazima indir */
export function normProvince(raw: string | null | undefined): string {
  if (!raw) return '';
  return BY_FOLD.get(fold(raw)) ?? raw.trim();
}

const inBounds = (lat: number, lon: number) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat &&
  lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon;

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/* ----------------------------------------------------------------- AFAD */

async function fetchAfad(hours: number): Promise<Quake[]> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600_000);
  const url = 'https://deprem.afad.gov.tr/apiv2/event/filter' +
    `?start=${encodeURIComponent(stamp(start))}&end=${encodeURIComponent(stamp(end))}` +
    `&minlat=${BOUNDS.minLat}&maxlat=${BOUNDS.maxLat}` +
    `&minlon=${BOUNDS.minLon}&maxlon=${BOUNDS.maxLon}&orderby=timedesc&limit=500`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`AFAD HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('AFAD beklenmeyen gövde');

  return rows.map((r: Record<string, unknown>) => ({
    id: `afad-${r.eventID}`,
    time: new Date(`${String(r.date).replace(' ', 'T').replace(/Z$/, '')}Z`).toISOString(),
    lat: Number(r.latitude),
    lon: Number(r.longitude),
    depth: Number(r.depth) || 0,
    mag: Number(r.magnitude),
    magType: String(r.type ?? 'ML').toUpperCase(),
    place: String(r.location ?? '').trim(),
    province: normProvince(String(r.province ?? '')),
    source: 'AFAD',
  }));
}

/* ---------------------------------------------------------------- KOERI */

async function fetchKoeri(): Promise<Quake[]> {
  const res = await fetch('http://www.koeri.boun.edu.tr/scripts/lst0.asp', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`KOERI HTTP ${res.status}`);

  // Sayfa ISO-8859-9 (Turkce) kodlu
  const html = new TextDecoder('iso-8859-9').decode(await res.arrayBuffer());
  const pre = html.split('<pre>')[1]?.split('</pre>')[0];
  if (!pre) throw new Error('KOERI <pre> bloğu yok');

  const line =
    /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+(-\.-|[\d.]+)\s+(-\.-|[\d.]+)\s+(-\.-|[\d.]+)\s+(.+?)\s{2,}(\S.*)$/;

  const out: Quake[] = [];
  for (const raw of pre.split('\n')) {
    const m = raw.trim().match(line);
    if (!m) continue;
    const [, y, mo, d, hh, mm, ss, lat, lon, depth, md, ml, mw, placeRaw] = m;

    // KOERI saatleri TSI (UTC+3)
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +hh - 3, +mm, +ss));
    const num = (v: string) => (v === '-.-' ? null : Number(v));
    const mag = num(mw) ?? num(ml) ?? num(md);
    if (mag === null) continue;

    const place = placeRaw.replace(/\s+/g, ' ').trim();
    out.push({
      id: `koeri-${t.getTime()}-${lat}-${lon}`,
      time: t.toISOString(),
      lat: Number(lat),
      lon: Number(lon),
      depth: Number(depth) || 0,
      mag,
      magType: num(mw) !== null ? 'MW' : num(ml) !== null ? 'ML' : 'MD',
      place,
      province: normProvince(place.match(/\(([^)]+)\)\s*$/)?.[1]?.split('-').pop() ?? ''),
      source: 'KOERI',
    });
  }
  if (!out.length) throw new Error('KOERI: satır ayrıştırılamadı');
  return out;
}

/* ----------------------------------------------------------- birlestirme */

/** Ayni depremin iki kaynaktaki kaydini tek kayda indirger */
export function merge(lists: Quake[][]): Quake[] {
  const all = lists.flat()
    .filter((q) =>
      Number.isFinite(q.lat) && Number.isFinite(q.lon) &&
      Number.isFinite(q.mag) && inBounds(q.lat, q.lon))
    .sort((a, b) => +new Date(b.time) - +new Date(a.time));

  const kept: Quake[] = [];
  for (const q of all) {
    const t = +new Date(q.time);
    const dup = kept.find((k) => {
      if (Math.abs(+new Date(k.time) - t) > 90_000) return false;
      if (Math.abs(k.mag - q.mag) > 1.0) return false;
      const dLat = (k.lat - q.lat) * 111;
      const dLon = (k.lon - q.lon) * 111 * Math.cos((q.lat * Math.PI) / 180);
      return Math.hypot(dLat, dLon) < 20;
    });
    if (dup) {
      if (q.place.length > dup.place.length) dup.place = q.place;
      if (!dup.province && q.province) dup.province = q.province;
      continue;
    }
    kept.push(q);
  }
  return kept;
}

/** Her iki kaynagi paralel dener; en az biri tutarsa sonuc doner */
export async function fetchQuakes(hours = 3): Promise<{ quakes: Quake[]; errors: string[] }> {
  const settled = await Promise.allSettled([fetchAfad(hours), fetchKoeri()]);
  const lists: Quake[][] = [];
  const errors: string[] = [];

  for (const r of settled) {
    if (r.status === 'fulfilled') lists.push(r.value);
    else errors.push(String(r.reason?.message ?? r.reason));
  }
  return { quakes: lists.length ? merge(lists) : [], errors };
}

/** Iki nokta arasi buyuk daire mesafesi, km */
export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
