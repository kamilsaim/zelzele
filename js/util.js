/**
 * Genel yardimcilar. Bu dosya hicbir seye bagli degil; digerleri buna baglanir.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ----------------------------------------------------------------- zaman */

export const fmtTime = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

export const fmtClock = new Intl.DateTimeFormat('tr-TR', {
  hour: '2-digit', minute: '2-digit',
});

export const fmtFull = new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium', timeStyle: 'medium',
});

/** "3 dk once" gibi okunabilir goreli zaman */
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}

/* --------------------------------------------------------------- cografya */

/** Iki nokta arasi buyuk daire mesafesi, km */
export function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ metin */

/** Turkce arama: "kutahya" yazan "Kütahya"yi bulsun */
export function fold(s) {
  return String(s).toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

/* ------------------------------------------------------------------ depo */

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('zelzele.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('zelzele.' + key, JSON.stringify(value)); } catch {}
  },
};

/* ----------------------------------------------------------------- bildir */

let toastTimer;

/** Ekranin ustunde kisa suren bildirim serigi */
export function toast(message, urgent = false) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.classList.toggle('alert', urgent);
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), urgent ? 7000 : 3400);
}

/* ------------------------------------------------------------------- ag */

/** Verilen sureyi asan istegi iptal eder; kaynak yavassa uygulamayi kilitlemesin */
export async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: zaman aşımı`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

/** base64url -> Uint8Array (push abonelik anahtari icin) */
export function b64urlToBytes(b64url) {
  const b64 = (b64url + '='.repeat((4 - b64url.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Uint8Array/ArrayBuffer -> base64url */
export function bytesToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
