/**
 * apns.ts dogrulama testi.
 *
 *   node worker/apns.test.mjs
 *
 * Gercek .p8 yerine burada uretilen bir P-256 anahtari kullanilir. Apple'in
 * yaptigi kontrol de budur: saglayici JWT'sinin imzasini anahtarin acik
 * yarisiyla dogrulamak. Ag cagrisi yapilmaz; fetch sahtesiyle yonlendirme
 * (production -> sandbox) ve sonuc eslemesi denenir.
 */

import assert from 'node:assert/strict';
import { sendApns, apnsProviderToken, apnsBody } from './apns.ts';

const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push(['✓', name]); }
  catch (err) { checks.push(['✗', `${name}\n      ${err.message}`]); }
}

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const p8 = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
const keys = { p8, keyId: 'ABC123DEFG', teamId: 'NBTXFU47EV', topic: 'com.kamilsaim.zelzele' };

const jwt = await apnsProviderToken(keys);
const [h, c, s] = jwt.split('.');

await check('JWT imzası açık anahtarla doğrulandı', async () => {
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`),
  );
  assert.equal(ok, true);
});

await check('JWT başlığı ve iddiaları Apple biçiminde', () => {
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(head, { alg: 'ES256', kid: keys.keyId });
  assert.equal(claims.iss, keys.teamId);
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
});

const payload = JSON.stringify({ title: '4.6 büyüklüğünde deprem', body: 'Sındırgı', id: 'afad-1', mag: 4.6 });

await check('Web Push gövdesi APNs biçimine çevriliyor', () => {
  const b = JSON.parse(apnsBody(payload));
  assert.deepEqual(b.aps.alert, { title: '4.6 büyüklüğünde deprem', body: 'Sındırgı' });
  assert.equal(b.aps.sound, 'default');
  assert.equal(b.id, 'afad-1');
  assert.equal(b.mag, 4.6);
  assert.equal(b.title, undefined);
});

/** Sahte APNs: host -> [durum, neden] */
function fakeApns(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).host;
    calls.push({ host, init });
    const [status, reason] = answers[host];
    return new Response(status === 200 ? '' : JSON.stringify({ reason }), { status });
  };
  return calls;
}

await check('production kabul ederse sandbox denenmez', async () => {
  const calls = fakeApns({ 'api.push.apple.com': [200] });
  const r = await sendApns('ab'.repeat(32), payload, keys, jwt, { collapseId: 'afad-1', urgency: 'normal' });
  assert.equal(r.ok, true);
  assert.equal(r.env, 'production');
  assert.equal(calls.length, 1);
  const hd = calls[0].init.headers;
  assert.equal(hd['apns-topic'], keys.topic);
  assert.equal(hd['apns-collapse-id'], 'afad-1');
  assert.equal(hd['apns-priority'], '5');
  assert.equal(hd.authorization, `bearer ${jwt}`);
});

await check('BadDeviceToken -> sandbox (Xcode geliştirme sürümü)', async () => {
  const calls = fakeApns({
    'api.push.apple.com': [400, 'BadDeviceToken'],
    'api.sandbox.push.apple.com': [200],
  });
  const r = await sendApns('ab'.repeat(32), payload, keys, jwt);
  assert.equal(r.ok, true);
  assert.equal(r.env, 'sandbox');
  assert.equal(r.gone, false);
  assert.equal(calls.length, 2);
});

await check('iki ortamda BadDeviceToken -> kayıt silinir', async () => {
  fakeApns({
    'api.push.apple.com': [400, 'BadDeviceToken'],
    'api.sandbox.push.apple.com': [400, 'BadDeviceToken'],
  });
  const r = await sendApns('ab'.repeat(32), payload, keys, jwt);
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
});

await check('410 Unregistered -> kayıt silinir', async () => {
  fakeApns({ 'api.push.apple.com': [410, 'Unregistered'] });
  const r = await sendApns('ab'.repeat(32), payload, keys, jwt);
  assert.equal(r.gone, true);
});

await check('InvalidProviderToken -> jeton yenilenmeli, kayıt silinmez', async () => {
  fakeApns({ 'api.push.apple.com': [403, 'InvalidProviderToken'] });
  const r = await sendApns('ab'.repeat(32), payload, keys, jwt);
  assert.equal(r.badProvider, true);
  assert.equal(r.gone, false);
  assert.equal(r.error, 'InvalidProviderToken');
});

/* ------------------------------------------------------------- rapor */

console.log('\nAPNs doğrulaması\n');
for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(([m]) => m === '✗').length;
console.log(`\n  ${checks.length - failed}/${checks.length} geçti\n`);
if (failed) process.exit(1);
