/**
 * Uygulama sabitleri. Deger degistirmek isteyen tek yere baksin diye burada toplu.
 */

/**
 * Uygulama surumu. Ayarlar ekraninda gosteriliyor.
 *
 * Neden gerekli: iOS ana ekran uygulamalari service worker'i cok gec
 * guncelliyor. Kullanici bir sorun bildirdiginde hangi surumu calistirdigini
 * bilmeden tahmin yurutmek zorunda kaliyoruz. Surum gorunur olunca bu
 * belirsizlik ortadan kalkiyor.
 */
export const APP_VERSION = '1.1.2';

/** Turkiye ve yakin cevresi — harita acilisinda ve veri filtresinde kullanilir */
export const TR_BOUNDS = [[35.5, 25.2], [42.5, 45.2]];

/** Buyukluge gore renk. Kucukten buyuge artan aciliyet. */
export const MAG_STOPS = [
  { min: 5.0, color: '#a21caf', label: '5.0+' },
  { min: 4.0, color: '#ef4444', label: '4.0 – 5.0' },
  { min: 3.0, color: '#fb923c', label: '3.0 – 4.0' },
  { min: 2.0, color: '#facc15', label: '2.0 – 3.0' },
  { min: -Infinity, color: '#38bdf8', label: '2.0 altı' },
];

export const magColor = (m) => MAG_STOPS.find((s) => m >= s.min).color;

/** Buyukluk arttikca yaricap hizlanarak buyusun — enerji ussel artar */
export const magRadius = (m) => 3 + Math.pow(Math.max(m, 0), 2.05) * 0.72;

/** Bu pencereye giren depremler haritada yanip soner */
export const RECENT_MS = 30 * 60 * 1000;

/** Otomatik yenileme araligi */
export const REFRESH_MS = 60 * 1000;

/** Masaustu / mobil ayrimi — CSS ile ayni esik */
export const DESKTOP_MIN = 861;

/**
 * Push sunucusu. Abonelikler burada saklanir ve bildirimi bu gonderir.
 * Supabase Edge Function; ayrintilar worker/README.md icinde.
 */
export const PUSH = {
  endpoint: 'https://pdxnpnlwrtswwifevlil.supabase.co/functions/v1/zlzl-push',
  /** VAPID acik anahtari — gizli degil, tarayiciya verilmek uzere uretildi */
  vapidPublicKey: 'BEnYu3pMGQNkapRD-j467pQwR_uKsVYULmqLZ3r9Y8ENO8OL4IL27Xelwh06R5Gbt6CnWj5sKT2nkqQzTds3YAE',
};

/** 81 il — favori sehir seciminde ve il adi normallestirmede kullanilir */
export const PROVINCES = [
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
