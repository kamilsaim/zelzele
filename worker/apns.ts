/**
 * APNs — iPhone uygulamasina (Capacitor kabugu) bildirim.
 *
 * iOS uygulamasi WKWebView'dir; orada service worker push yok. Uygulama
 * `@capacitor/push-notifications` ile APNs jetonu alir ve `zlzl_subs`'a
 * `endpoint = "apns:<jeton>"` olarak kaydolur. Gonderici ucun bu onekine
 * bakip buraya yonlendirir; kurallar ve `zlzl_sent` aynen calisir.
 *
 * webpush.ts gibi bagimliliksiz: saglayici JWT'si (ES256) WebCrypto ile
 * imzalaniyor. WebCrypto ECDSA ham r||s uretir — JWT'nin bekledigi bicim.
 */

import { bytesToB64url } from './webpush.ts';

export const APNS_PREFIX = 'apns:';

export interface ApnsKeys {
  /** .p8 dosyasinin icerigi (PEM) */
  p8: string;
  keyId: string;
  teamId: string;
  /** Uygulamanin bundle id'si */
  topic: string;
}

const enc = new TextEncoder();

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

/** Apple saglayici jetonu. En fazla 60 dk gecerli; cagiran onbelleklemeli. */
export async function apnsProviderToken(keys: ApnsKeys): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(keys.p8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const unsigned =
    `${bytesToB64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: keys.keyId })))}.` +
    `${bytesToB64url(enc.encode(JSON.stringify({ iss: keys.teamId, iat: Math.floor(Date.now() / 1000) })))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `${unsigned}.${bytesToB64url(sig)}`;
}

/**
 * Web Push govdesini (title, body + deprem alanlari) APNs bicimine cevirir.
 * Ozel alanlar Capacitor'da `notification.data` olarak uygulamaya duser.
 */
export function apnsBody(payload: string): string {
  const { title, body, ...rest } = JSON.parse(payload);
  return JSON.stringify({
    aps: { alert: { title, body }, sound: 'default' },
    ...rest,
  });
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** Jeton kalici olarak gecersiz — kaydi silmeliyiz */
  gone: boolean;
  error?: string;
  /** Saglayici jetonu reddedildi; yenisiyle bir kez daha denenmeli */
  badProvider?: boolean;
  env?: 'production' | 'sandbox';
}

async function post(
  host: string, token: string, jwt: string, body: string, topic: string,
  opts: { ttl?: number; urgency?: string; collapseId?: string },
) {
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': opts.urgency === 'normal' ? '5' : '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + (opts.ttl ?? 3600)),
    'content-type': 'application/json',
  };
  // Ayni deprem iki kez giderse cihazda tek bildirim kalsin (en fazla 64 bayt)
  if (opts.collapseId) headers['apns-collapse-id'] = opts.collapseId.slice(0, 64);

  const res = await fetch(`https://${host}/3/device/${token}`, { method: 'POST', headers, body });
  const reason = res.ok
    ? undefined
    : ((await res.json().catch(() => ({}))) as { reason?: string }).reason ?? `HTTP ${res.status}`;
  return { status: res.status, reason };
}

/**
 * Xcode'dan kurulan gelistirme surumunun jetonu sandbox'a, TestFlight/App
 * Store surumununki production'a aittir; istemci hangisi oldugunu bilmez.
 * Once production, `BadDeviceToken` gelirse sandbox denenir.
 */
export async function sendApns(
  token: string,
  payload: string,
  keys: ApnsKeys,
  jwt: string,
  opts: { ttl?: number; urgency?: string; collapseId?: string } = {},
): Promise<ApnsResult> {
  try {
    const body = apnsBody(payload);
    let env: 'production' | 'sandbox' = 'production';
    let r = await post('api.push.apple.com', token, jwt, body, keys.topic, opts);
    if (r.status === 400 && r.reason === 'BadDeviceToken') {
      env = 'sandbox';
      r = await post('api.sandbox.push.apple.com', token, jwt, body, keys.topic, opts);
    }
    const ok = r.status === 200;
    return {
      ok,
      status: r.status,
      env,
      // 410 Unregistered: uygulama silindi ya da bildirim kapatildi.
      // Iki ortamda da BadDeviceToken: jeton bu uygulamaya ait degil.
      gone: r.status === 410 || (r.status === 400 && r.reason === 'BadDeviceToken'),
      badProvider: r.status === 403 &&
        (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken'),
      error: ok ? undefined : r.reason,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: String((err as Error).message || err) };
  }
}
