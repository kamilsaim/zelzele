/**
 * Web Push — RFC 8291 (aes128gcm sifreleme) ve RFC 8292 (VAPID kimligi).
 *
 * Harici bagimlilik yok; her sey WebCrypto ile yapiliyor. Boylece Deno,
 * Cloudflare Workers ve modern Node ayni kodu calistirabilir.
 *
 * Kullanim:
 *   const res = await sendPush(subscription, JSON.stringify(payload), vapid);
 */

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** 65 baytlik sikistirilmamis nokta, base64url */
  publicKey: string;
  /** P-256 ozel anahtari (JWK'daki d), base64url */
  privateKey: string;
  /** mailto: veya https: — push servisinin bize ulasabilecegi adres */
  subject: string;
}

/* ------------------------------------------------------------- kodlama */

const enc = new TextEncoder();

export function b64urlToBytes(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ---------------------------------------------------------------- HKDF */

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF-Extract: tuzu anahtar, IKM'yi veri kabul eden HMAC */
const hkdfExtract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt, ikm);

/** HKDF-Expand — burada hep <=32 bayt istendigi icin tek tur yeterli */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const block = await hmac(prk, concat(info, new Uint8Array([1])));
  return block.slice(0, len);
}

/* ---------------------------------------------------------------- VAPID */

/**
 * VAPID acik anahtari 0x04||X||Y bicimindedir; imzalama icin JWK gerekiyor.
 * X ve Y'yi acik anahtardan cikarip ozel anahtarla birlestiriyoruz.
 */
async function importVapidKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlToBytes(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID açık anahtarı 65 baytlık sıkıştırılmamış nokta olmalı');
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: vapid.privateKey,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** Push servisine kendimizi tanitan Authorization basligi */
async function vapidAuthHeader(endpoint: string, vapid: VapidKeys): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject,
  };

  const unsigned =
    `${bytesToB64url(enc.encode(JSON.stringify(header)))}.` +
    `${bytesToB64url(enc.encode(JSON.stringify(claims)))}`;

  const key = await importVapidKey(vapid);
  // WebCrypto ECDSA zaten ham r||s uretir; JWT'nin bekledigi bicim de bu
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned),
  );

  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}

/* ------------------------------------------------------------ sifreleme */

/**
 * Govdeyi aes128gcm ile sifreler (RFC 8291).
 *
 * Cikti duzeni:
 *   salt(16) | kayit boyu(4) | anahtar uzunlugu(1) | sunucu acik anahtari(65) | sifreli metin
 */
async function encryptPayload(
  payload: string,
  clientPublicKeyB64: string,
  authSecretB64: string,
): Promise<Uint8Array> {
  const clientPublic = b64urlToBytes(clientPublicKeyB64);
  const authSecret = b64urlToBytes(authSecretB64);

  // Bu gonderime ozel gecici anahtar cifti
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256,
    ),
  );

  // Ortak sirdan giris anahtar malzemesi (IKM) uret
  const prkKey = await hkdfExtract(authSecret, shared);
  const keyInfo = concat(
    enc.encode('WebPush: info\0'),
    clientPublic,
    serverPublic,
  );
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);

  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);

  // 0x02 = "son kayit" dolgu ayraci
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);

  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

/* -------------------------------------------------------------- gonderim */

export interface PushResult {
  ok: boolean;
  status: number;
  /** Abonelik kalici olarak gecersiz — kaydi silmeliyiz */
  gone: boolean;
  error?: string;
}

export async function sendPush(
  sub: PushSubscription,
  payload: string,
  vapid: VapidKeys,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<PushResult> {
  try {
    const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
    const auth = await vapidAuthHeader(sub.endpoint, vapid);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? 3600),
        Urgency: opts.urgency ?? 'high',
      },
      body,
    });

    // 404/410: kullanici bildirimi kapatti ya da uygulamayi kaldirdi
    const gone = res.status === 404 || res.status === 410;
    return {
      ok: res.ok,
      status: res.status,
      gone,
      error: res.ok ? undefined : (await res.text().catch(() => '')).slice(0, 300),
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: String((err as Error).message || err) };
  }
}
