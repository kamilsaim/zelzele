/**
 * Uyarilar.
 *
 * Iki ayri mekanizma var, karistirmamak onemli:
 *
 *  - **Yerel uyari**: uygulama acikken yeni deprem geldiginde ekranda uyari,
 *    ses ve titresim. Sunucu gerektirmez, her tarayicida calisir.
 *
 *  - **Push**: uygulama kapaliyken de gelen bildirim. Cihazin abonelik
 *    bilgisi sunucuya kaydedilir, depremi sunucu tespit edip gonderir.
 *    Android/masaustunde dogrudan, iOS'ta yalnizca ana ekrana eklenmis
 *    uygulamada calisir (Apple sarti).
 *
 *  - **iPhone uygulamasi** (IOS_APP): Web Push yok; Capacitor'in
 *    PushNotifications eklentisiyle APNs jetonu alinir ve sunucuya
 *    `apns:<jeton>` ucu olarak kaydedilir. Kurallar ve islemler ayni.
 */

import { toast, distKm, fmtTime, b64urlToBytes, store } from './util.js';
import { PUSH, IOS_APP } from './config.js';
import { state, settings } from './state.js';

/* ------------------------------------------------------------ yerel uyari */

export function beep() {
  if (!settings.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [880, 660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const at = now + i * 0.22;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.22);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* ses cikmazsa uyari yine de gorunur */ }
}

/**
 * Yeni gelen depremler icin kullaniciyi uyarir.
 * @returns {object|null} uyari verilen deprem, yoksa null
 */
export function alertNew(fresh) {
  const worthy = fresh
    .filter((q) => q.mag >= settings.notifyMag)
    .sort((a, b) => b.mag - a.mag);

  if (!worthy.length) {
    if (fresh.length) toast(`${fresh.length} yeni deprem kaydedildi`);
    return null;
  }

  const q = worthy[0];
  const near = state.me
    ? ` · size ${Math.round(distKm(state.me.lat, state.me.lon, q.lat, q.lon))} km`
    : '';
  const title = `${q.mag.toFixed(1)} büyüklüğünde deprem`;
  const body = `${q.place}${near}\n${fmtTime.format(new Date(q.time))} · ${q.depth.toFixed(0)} km derinlik`;

  toast(`${title} — ${q.place}`, true);
  beep();
  if (navigator.vibrate) navigator.vibrate([200, 90, 200, 90, 400]);

  if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body, icon: 'icons/icon-192.png', tag: q.id, renotify: true,
      });
    } catch { /* bazi tarayicilar sayfa baglaminda Notification kurmaya izin vermez */ }
  }
  return q;
}

/* -------------------------------------------------------------- izinler */

/** @returns {boolean} izin verildi mi */
export async function ensurePermission() {
  // Uygulama icinde Notification API yok; ekrandaki uyari ve ses yine calisir
  if (IOS_APP && !('Notification' in window)) return true;
  if (!('Notification' in window)) {
    toast('Bu tarayıcı bildirim desteklemiyor. Uyarılar yine de ekranda görünür.');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    toast('Bildirim izni reddedilmiş. Tarayıcı ayarlarından açman gerek.', true);
    return false;
  }
  return (await Notification.requestPermission()) === 'granted';
}

/* ----------------------------------------------------------------- push */

const APNS_PREFIX = 'apns:';

/** iPhone uygulamasinda Capacitor'in push eklentisi; tarayicida undefined */
const nativePush = () => (IOS_APP ? window.Capacitor?.Plugins?.PushNotifications : undefined);

/** iOS bildirim izni (sistem penceresi). @returns {boolean} verildi mi */
async function nativePermission() {
  const P = nativePush();
  let { receive } = await P.checkPermissions();
  if (receive !== 'granted' && receive !== 'denied') {
    ({ receive } = await P.requestPermissions());
  }
  if (receive === 'denied') {
    toast("Bildirim izni kapalı. iPhone Ayarlar → Zelzele → Bildirimler'den açabilirsin.", true);
  }
  return receive === 'granted';
}

/** APNs'e kaydolup cihaz jetonunu (onaltilik) alir */
async function apnsToken() {
  const P = nativePush();
  let finish;
  const result = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  // Dinleyiciler register()'dan once kurulmali, yoksa yanit kacabilir
  const handles = await Promise.all([
    P.addListener('registration', (t) => finish.resolve(String(t.value).toLowerCase())),
    P.addListener('registrationError', (e) => finish.reject(new Error(e?.error || 'APNs kaydı başarısız'))),
  ]);
  const timer = setTimeout(() => finish.reject(new Error('APNs yanıt vermedi')), 20000);
  try {
    await P.register();
    return await result;
  } finally {
    clearTimeout(timer);
    for (const h of handles) h.remove();
  }
}

/** Bu cihazin sunucudaki ucu; kayitli degilse null */
async function currentEndpoint() {
  if (IOS_APP) {
    const token = store.get('apnsToken', null);
    return token ? APNS_PREFIX + token : null;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/** Cihazi ayirt eden kalici kimlik — kurallari guncellerken kullanilir */
function deviceId() {
  let id = store.get('deviceId', null);
  if (!id) {
    id = crypto.randomUUID();
    store.set('deviceId', id);
  }
  return id;
}

/** Kullanicinin su anki push kurallari */
export function pushRules() {
  return {
    min_mag: settings.pushMag,
    max_km: state.me ? settings.pushKm : 0,
    // Sunucuya yalnizca ~1 km hassasiyet gider (gizlilik.html'de boyle beyan
    // edildi); en kucuk bildirim yaricapi onlarca km oldugu icin fark etmez.
    lat: state.me ? Math.round(state.me.lat * 100) / 100 : null,
    lon: state.me ? Math.round(state.me.lon * 100) / 100 : null,
    cities: settings.pushCities ? state.cities : [],
  };
}

async function callPush(action, payload) {
  const res = await fetch(PUSH.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, device_id: deviceId(), ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function pushSupported() {
  if (IOS_APP) return !!nativePush();
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * iOS'ta push yalnizca ana ekrana eklenmis uygulamada calisir.
 * @returns {string|null} engel aciklamasi, engel yoksa null
 */
export function pushBlocker() {
  if (IOS_APP) return nativePush() ? null : 'Bu sürümde bildirim desteği yok; uygulamayı güncelle.';
  if (!pushSupported()) return 'Bu tarayıcı arka plan bildirimini desteklemiyor.';

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;

  if (isIOS && !standalone) {
    return 'iPhone ve iPad\'de arka plan bildirimi için uygulamayı önce ana ekrana eklemen gerekiyor: Paylaş → Ana Ekrana Ekle.';
  }
  return null;
}

/** Cihazi push'a kaydeder. @returns {boolean} basarili mi */
export async function subscribePush() {
  const blocker = pushBlocker();
  if (blocker) { toast(blocker, true); return false; }

  if (IOS_APP) {
    if (!(await nativePermission())) return false;
    const token = await apnsToken();
    await callPush('subscribe', { apns_token: token, rules: pushRules() });
    store.set('apnsToken', token);
    return true;
  }

  if (!(await ensurePermission())) { toast('Bildirim izni verilmedi.'); return false; }

  const reg = await navigator.serviceWorker.ready;

  // Zaten abone olabilir; VAPID anahtari degistiyse eskisini birak
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const current = new Uint8Array(sub.options.applicationServerKey || new ArrayBuffer(0));
    const wanted = b64urlToBytes(PUSH.vapidPublicKey);
    const same = current.length === wanted.length && current.every((b, i) => b === wanted[i]);
    if (!same) { await sub.unsubscribe(); sub = null; }
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(PUSH.vapidPublicKey),
    });
  }

  await callPush('subscribe', { subscription: sub.toJSON(), rules: pushRules() });
  return true;
}

/** Kurallari sunucuda gunceller; abone degilse sessizce gecer */
export async function syncPushRules() {
  if (!settings.push || !pushSupported()) return;
  try {
    const endpoint = await currentEndpoint();
    if (!endpoint) return;
    await callPush('update', { endpoint, rules: pushRules() });
  } catch (err) {
    console.warn('push kuralları güncellenemedi:', err.message);
  }
}

export async function unsubscribePush() {
  if (IOS_APP) {
    const endpoint = await currentEndpoint();
    if (endpoint) await callPush('unsubscribe', { endpoint }).catch(() => {});
    store.set('apnsToken', null);
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await callPush('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch (err) {
    console.warn('push aboneliği kaldırılamadı:', err.message);
  }
}

/** Sunucudan bu cihaza deneme bildirimi ister */
export async function sendTestPush() {
  const endpoint = await currentEndpoint();
  if (!endpoint) throw new Error('Bu cihaz henüz kayıtlı değil.');
  return callPush('test', { endpoint });
}

/**
 * iPhone uygulamasi acilisinda bir kez cagrilir.
 *
 *  - Bildirime dokunulunca `onOpen(depremId)` cagrilir. Capacitor bu olayi
 *    dinleyici eklenene kadar saklar; uygulama bildirimle soguk acilsa da gelir.
 *  - Apple jetonu zaman zaman degistirir; her acilista yeniden alinir ve
 *    degismisse sunucudaki kayit tazelenir (eskisi APNs'ten 410 alip silinir).
 */
export async function initNativePush(onOpen) {
  const P = nativePush();
  if (!P) return;

  P.addListener('pushNotificationActionPerformed', (action) => {
    const id = action?.notification?.data?.id;
    if (id && id !== 'test') onOpen(String(id));
  });

  if (!settings.push) return;
  try {
    if ((await P.checkPermissions()).receive !== 'granted') return;
    const token = await apnsToken();
    if (token !== store.get('apnsToken', null)) {
      await callPush('subscribe', { apns_token: token, rules: pushRules() });
      store.set('apnsToken', token);
    }
  } catch (err) {
    console.warn('APNs jetonu tazelenemedi:', err.message);
  }
}
