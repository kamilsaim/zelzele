/**
 * webpush.ts dogrulama testi.
 *
 *   node worker/webpush.test.mjs
 *
 * Iki seyi kanitlar:
 *
 *  1. **Sifreleme** — tarayicinin yaptigi cozme islemini burada tekrar edip
 *     duz metnin aynen geri geldigini gosteriyoruz. Bu, RFC 8291'i dogru
 *     uyguladigimizin kaniti; yanlis olsaydi cozme AES-GCM etiketinde patlardi.
 *
 *  2. **VAPID** — uretilen JWT'nin imzasini acik anahtarla dogruluyoruz.
 *     Push servisinin yaptigi kontrol tam olarak budur.
 *
 * Not: webpush.ts TypeScript, ama Deno'ya ozgu hicbir sey icermiyor.
 * Node 23.6+ tipleri kendisi soyuyor, o yuzden dogrudan import edilebiliyor.
 */

import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';

// Node'un global crypto'su zaten WebCrypto, ama emin olalim
if (!globalThis.crypto?.subtle) globalThis.crypto = crypto;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdfExpand(prk, info, len) {
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/* ====================================================================
   Tarayici tarafi: abonelik uret ve gelen govdeyi coz
   ==================================================================== */

/** Tarayicinin pushManager.subscribe() ile urettigi seyin esdegeri */
async function makeFakeSubscription() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));

  return {
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/deneme-uc-adresi',
      keys: { p256dh: b64url(p256dh), auth: b64url(auth) },
    },
    privateKey: pair.privateKey,
    publicRaw: p256dh,
    authSecret: auth,
  };
}

/** sendPush'un urettigi govdeyi, tarayicinin yaptigi gibi cozer */
async function decryptBody(body, client) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const serverPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const serverKey = await crypto.subtle.importKey(
    'raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverKey }, client.privateKey, 256,
  ));

  const prkKey = await hmac(client.authSecret, shared);
  const keyInfo = concat(enc.encode('WebPush: info\0'), client.publicRaw, serverPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext),
  );

  // Son bayt dolgu ayraci (0x02)
  assert.equal(plain[plain.length - 1], 2, 'dolgu ayracı 0x02 olmalı');
  return dec.decode(plain.slice(0, -1));
}

/* ====================================================================
   Testler
   ==================================================================== */

const { sendPush, bytesToB64url, b64urlToBytes } = await import('./webpush.ts');

let captured = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  captured = { url, headers: init.headers, body: init.body };
  return new Response('', { status: 201 });
};

// --- gercek VAPID cifti (uygulamanin kullandigi ile ayni uretim yolu) ---
const vapidPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const vapidJwk = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
const vapidPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));

const vapid = {
  publicKey: b64url(vapidPublicRaw),
  privateKey: vapidJwk.d,
  subject: 'mailto:test@example.com',
};

const client = await makeFakeSubscription();
const payload = JSON.stringify({
  title: '4.7 büyüklüğünde deprem',
  body: 'PÜTÜRGE (MALATYA)\n14:32 · size 82 km · 7 km derinlik · AFAD',
  id: 'afad-999999',
  mag: 4.7,
});

const result = await sendPush(client.subscription, payload, vapid);
globalThis.fetch = realFetch;

const checks = [];
function check(name, fn) {
  try { fn(); checks.push(['✓', name]); }
  catch (err) { checks.push(['✗', `${name} — ${err.message}`]); process.exitCode = 1; }
}

check('gönderim başarılı raporlandı', () => {
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
});

check('doğru uca POST edildi', () => {
  assert.equal(captured.url, client.subscription.endpoint);
});

check('aes128gcm başlıkları var', () => {
  assert.equal(captured.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(captured.headers['Content-Type'], 'application/octet-stream');
  assert.ok(Number(captured.headers.TTL) > 0);
});

check('gövde yapısı RFC 8291 düzeninde', () => {
  const body = captured.body;
  assert.ok(body.length > 16 + 4 + 1 + 65, 'gövde çok kısa');
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, 'kayıt boyu 4096 olmalı');
  assert.equal(body[20], 65, 'sunucu anahtarı 65 bayt olmalı');
  assert.equal(body[21], 0x04, 'sıkıştırılmamış nokta 0x04 ile başlamalı');
});

// EN ONEMLI TEST: tarayicinin cozdugu gibi cozulebiliyor mu?
let decrypted = null;
await (async () => {
  try {
    decrypted = await decryptBody(captured.body, client);
    checks.push(['✓', 'şifreli gövde çözülebildi (AES-GCM etiketi doğrulandı)']);
  } catch (err) {
    checks.push(['✗', `şifre çözme başarısız — ${err.message}`]);
    process.exitCode = 1;
  }
})();

check('çözülen metin gönderilenle birebir aynı', () => {
  assert.equal(decrypted, payload);
});

check('Türkçe karakterler bozulmadı', () => {
  const obj = JSON.parse(decrypted);
  assert.match(obj.title, /büyüklüğünde/);
  assert.match(obj.body, /PÜTÜRGE/);
});

// --- VAPID imzasi ---
const authHeader = captured.headers.Authorization;

check('Authorization başlığı vapid biçiminde', () => {
  assert.match(authHeader, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

let jwtOk = false;
await (async () => {
  const token = authHeader.match(/t=([^,]+)/)[1];
  const [h, p, s] = token.split('.');
  const signed = enc.encode(`${h}.${p}`);
  jwtOk = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, vapidPair.publicKey, fromB64url(s), signed,
  );
})();

check('JWT imzası açık anahtarla doğrulandı', () => {
  assert.equal(jwtOk, true);
});

check('JWT iddiaları doğru', () => {
  const token = authHeader.match(/t=([^,]+)/)[1];
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'aud uç adresinin origin\'i olmalı');
  assert.equal(claims.sub, vapid.subject);
  assert.ok(claims.exp > Date.now() / 1000, 'exp gelecekte olmalı');
  assert.ok(claims.exp < Date.now() / 1000 + 24 * 3600, 'exp 24 saati aşmamalı (RFC 8292)');
});

check('k parametresi açık anahtarla eşleşiyor', () => {
  assert.equal(authHeader.match(/k=([\w-]+)$/)[1], vapid.publicKey);
});

// --- base64url yardimcilari ---
check('base64url gidiş-dönüş kayıpsız', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  assert.deepEqual(b64urlToBytes(bytesToB64url(bytes)), bytes);
});

/* ------------------------------------------------------------- rapor */

console.log('\nweb push doğrulaması\n');
for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(([m]) => m === '✗').length;
console.log(`\n  ${checks.length - failed}/${checks.length} geçti\n`);
