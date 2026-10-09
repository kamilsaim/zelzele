/**
 * Zelzele push ucu — Supabase Edge Function (`zlzl-push`).
 *
 * Iki tur cagri alir:
 *
 *  A) Tarayicidan (verify_jwt kapali, CORS acik)
 *       subscribe   — cihazi kaydeder / kurallarini gunceller
 *       update      — yalnizca kurallari gunceller
 *       unsubscribe — kaydi siler
 *       test        — o cihaza deneme bildirimi gonderir
 *       feed (GET)  — son 24 saatin depremleri; uygulamanin canli veri kaynagi
 *
 *  B) Zamanlanmis is (pg_cron -> pg_net, x-zlzl-secret basligiyla)
 *       dispatch    — yeni depremleri bulur, kurallara uyan cihazlara gonderir
 *
 * Iki tur abone var: tarayici/Android (Web Push, VAPID) ve iPhone uygulamasi
 * (APNs, `endpoint = "apns:<jeton>"`). Hangisine nasil gidecegine `deliver` karar verir.
 *
 * Kurallarin hangisi tutarsa bildirim gider (VEYA mantigi):
 *   1. Buyukluk >= min_mag                      (Turkiye geneli)
 *   2. Mesafe <= max_km ve buyukluk >= 3.0      (yakinimdaki)
 *   3. Il, takip listesinde ve buyukluk >= 3.0  (sehirlerim)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush, type VapidKeys } from './webpush.ts';
import { sendApns, apnsProviderToken, APNS_PREFIX, type ApnsKeys } from './apns.ts';
import { fetchQuakes, distKm, type Quake } from './quakes.ts';

/** Yakinlik ve sehir kurallarinin alt siniri — bunun altinda bildirim gitmez */
const LOCAL_MIN_MAG = 3.0;

/** Gondericinin geriye bakacagi pencere. Cron 5 dakikada bir kosar; pay birakiyoruz. */
const LOOKBACK_MIN = 90;

/**
 * Uygulamaya verilen canli pencere. data/latest.json'u yazan GitHub Actions
 * cron'u pratikte 3-7 saatte bir calisiyor; bu bosluk her zaman kapansin.
 */
const FEED_HOURS = 24;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-zlzl-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

interface Config {
  vapid_public: string;
  vapid_private: string;
  subject: string;
  dispatch_secret: string;
  apns_key_p8: string | null;
  apns_key_id: string | null;
  apns_team_id: string | null;
  apns_topic: string | null;
  apns_jwt: string | null;
  apns_jwt_at: string | null;
}

async function loadConfig(): Promise<Config> {
  const { data, error } = await admin
    .from('zlzl_config')
    .select('vapid_public, vapid_private, subject, dispatch_secret, apns_key_p8, apns_key_id, apns_team_id, apns_topic, apns_jwt, apns_jwt_at')
    .eq('id', 1)
    .single();
  if (error || !data) throw new Error('zlzl_config okunamadı');
  return data as Config;
}

const vapidFrom = (c: Config): VapidKeys => ({
  publicKey: c.vapid_public,
  privateKey: c.vapid_private,
  subject: c.subject,
});

function apnsFrom(c: Config): ApnsKeys | null {
  if (!c.apns_key_p8 || !c.apns_key_id || !c.apns_team_id || !c.apns_topic) return null;
  return { p8: c.apns_key_p8, keyId: c.apns_key_id, teamId: c.apns_team_id, topic: c.apns_topic };
}

/**
 * Apple saglayici jetonu en fazla 60 dk gecerli ve 20 dk'dan sik yenilenirse
 * 429 TooManyProviderTokenUpdates doner. Edge ornekleri kisa omurlu oldugundan
 * jeton zlzl_config'te 50 dk saklanir.
 */
async function apnsJwt(c: Config, force = false): Promise<string> {
  const keys = apnsFrom(c);
  if (!keys) throw new Error('APNs ayarı yok (zlzl_config.apns_*)');
  if (!force && c.apns_jwt && c.apns_jwt_at &&
      Date.now() - new Date(c.apns_jwt_at).getTime() < 50 * 60_000) {
    return c.apns_jwt;
  }
  const jwt = await apnsProviderToken(keys);
  const at = new Date().toISOString();
  await admin.from('zlzl_config').update({ apns_jwt: jwt, apns_jwt_at: at }).eq('id', 1);
  c.apns_jwt = jwt;
  c.apns_jwt_at = at;
  return jwt;
}

/* ====================================================================
   Teslim: Web Push ya da APNs
   ==================================================================== */

interface Delivery { ok: boolean; status: number; gone: boolean; error?: string }

/**
 * Ayni turda paralel APNs gonderimleri tek saglayici jetonunu paylassin;
 * Apple reddederse de yalnizca bir kez yenilensin (sik yenileme 429 alir).
 */
let jwtPending: Promise<string> | null = null;
let refreshPending: Promise<string> | null = null;

async function deliver(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  config: Config,
  opts: { urgency?: 'normal' | 'high'; collapseId?: string } = {},
): Promise<Delivery> {
  if (!sub.endpoint.startsWith(APNS_PREFIX)) {
    return sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload, vapidFrom(config), { urgency: opts.urgency },
    );
  }

  const keys = apnsFrom(config);
  if (!keys) return { ok: false, status: 0, gone: false, error: 'APNs ayarı yok' };
  const token = sub.endpoint.slice(APNS_PREFIX.length);

  try {
    jwtPending ??= apnsJwt(config).finally(() => { jwtPending = null; });
    const used = await jwtPending;
    let res = await sendApns(token, payload, keys, used, opts);
    if (res.badProvider) {
      const fresh = config.apns_jwt && config.apns_jwt !== used
        ? config.apns_jwt
        : await (refreshPending ??= apnsJwt(config, true).finally(() => { refreshPending = null; }));
      res = await sendApns(token, payload, keys, fresh, opts);
    }
    return res;
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: String((err as Error).message || err) };
  }
}

/* ====================================================================
   Bildirim metni
   ==================================================================== */

interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
  min_mag: number;
  max_km: number;
  lat: number | null;
  lon: number | null;
  cities: string[];
}

/** Bu deprem bu aboneye gonderilmeli mi? Gonderilecekse nedenini de doner. */
function matches(q: Quake, sub: Sub): string | null {
  if (q.mag >= sub.min_mag) return 'genel';

  if (q.mag >= LOCAL_MIN_MAG && sub.max_km > 0 && sub.lat !== null && sub.lon !== null) {
    if (distKm(sub.lat, sub.lon, q.lat, q.lon) <= sub.max_km) return 'yakin';
  }

  if (q.mag >= LOCAL_MIN_MAG && sub.cities.length && q.province) {
    if (sub.cities.includes(q.province)) return 'sehir';
  }
  return null;
}

function payloadFor(q: Quake, reason: string, sub: Sub) {
  const bits: string[] = [];
  if (reason === 'yakin' && sub.lat !== null && sub.lon !== null) {
    bits.push(`size ${Math.round(distKm(sub.lat, sub.lon, q.lat, q.lon))} km`);
  }
  bits.push(`${q.depth.toFixed(0)} km derinlik`);

  const clock = new Date(q.time).toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul',
  });

  return JSON.stringify({
    // Kurumun kaydettigi bir olcum oldugunu acikca soyluyoruz; tahmin degil.
    title: `${q.mag.toFixed(1)} büyüklüğünde deprem`,
    body: `${q.place || 'Bilinmeyen konum'}\n${clock} · ${bits.join(' · ')} · ${q.source}`,
    id: q.id,
    mag: q.mag,
    time: q.time,
    // Tam deprem kaydi: sw.js bunu onbellege yazar, uygulama data/latest.json
    // henuz guncellenmemisse bile bildirimi tetikleyen depremi hemen gosterir.
    lat: q.lat,
    lon: q.lon,
    depth: q.depth,
    magType: q.magType,
    place: q.place,
    province: q.province,
    source: q.source,
    url: './',
  });
}

/* ====================================================================
   Gonderim
   ==================================================================== */

async function dispatch(config: Config) {
  const { quakes, errors } = await fetchQuakes(FEED_HOURS);

  if (!quakes.length) {
    return { ok: false, reason: 'kaynaklara ulaşılamadı', errors };
  }

  // Uygulamanin okudugu canli veriyi tazele. Kandilli listesi gunlerce
  // geriye gidiyor; pencereyi burada kirpiyoruz ki yanit kucuk kalsin.
  const feedCutoff = Date.now() - FEED_HOURS * 3600_000;
  const { error: feedErr } = await admin.from('zlzl_feed').upsert({
    id: 1,
    quakes: quakes.filter((q) => +new Date(q.time) >= feedCutoff),
    errors,
    updated_at: new Date().toISOString(),
  });
  if (feedErr) console.error('feed yazılamadı', feedErr.message);

  // Yalnizca yakin gecmisteki depremler. Yoksa ilk calistirmada gecmis
  // butun depremler bildirim olarak giderdi.
  const cutoff = Date.now() - LOOKBACK_MIN * 60_000;
  const recent = quakes.filter((q) => +new Date(q.time) >= cutoff);

  const { data: subsRaw, error: subErr } = await admin
    .from('zlzl_subs')
    .select('endpoint, p256dh, auth, min_mag, max_km, lat, lon, cities');
  if (subErr) throw subErr;

  const subs = (subsRaw ?? []) as Sub[];
  if (!subs.length || !recent.length) {
    await admin.from('zlzl_config').update({ last_run: new Date().toISOString() }).eq('id', 1);
    return { ok: true, subs: subs.length, candidates: recent.length, sent: 0 };
  }

  // Daha once gonderilmis (abonelik, deprem) ciftlerini bir kerede cek
  const { data: sentRaw } = await admin
    .from('zlzl_sent')
    .select('endpoint, quake_id')
    .in('quake_id', recent.map((q) => q.id));

  const already = new Set((sentRaw ?? []).map((r) => `${r.endpoint}|${r.quake_id}`));

  const jobs: { sub: Sub; quake: Quake; reason: string }[] = [];
  for (const sub of subs) {
    for (const q of recent) {
      if (already.has(`${sub.endpoint}|${q.id}`)) continue;
      const reason = matches(q, sub);
      if (reason) jobs.push({ sub, quake: q, reason });
    }
  }

  if (!jobs.length) {
    await admin.from('zlzl_config').update({ last_run: new Date().toISOString() }).eq('id', 1);
    return { ok: true, subs: subs.length, candidates: recent.length, sent: 0 };
  }

  const results = await Promise.all(jobs.map(async ({ sub, quake, reason }) => {
    const res = await deliver(sub, payloadFor(quake, reason, sub), config, {
      urgency: quake.mag >= 5 ? 'high' : 'normal',
      collapseId: quake.id,
    });
    return { sub, quake, res };
  }));

  const sentRows = results
    .filter((r) => r.res.ok)
    .map((r) => ({ endpoint: r.sub.endpoint, quake_id: r.quake.id }));

  // Gonderileni hemen isaretle ki bir sonraki turda tekrarlanmasin
  if (sentRows.length) {
    await admin.from('zlzl_sent').upsert(sentRows, { onConflict: 'endpoint,quake_id' });
    await admin
      .from('zlzl_subs')
      .update({ last_sent: new Date().toISOString(), fail_count: 0 })
      .in('endpoint', [...new Set(sentRows.map((r) => r.endpoint))]);
  }

  // Kalici olarak olu abonelikleri temizle
  const gone = [...new Set(results.filter((r) => r.res.gone).map((r) => r.sub.endpoint))];
  if (gone.length) await admin.from('zlzl_subs').delete().in('endpoint', gone);

  const failed = results.filter((r) => !r.res.ok && !r.res.gone);
  for (const f of failed) console.error('push başarısız', f.res.status, f.res.error);

  await admin.from('zlzl_config').update({ last_run: new Date().toISOString() }).eq('id', 1);
  // rpc() bir Promise degil, yalnizca `then` tasiyor; `.catch` zinciri
  // TypeError firlatip turu 500 ile bitiriyordu. Hata `error` alaninda doner.
  const { error: pruneErr } = await admin.rpc('zlzl_prune_sent');
  if (pruneErr) console.error('zlzl_prune_sent', pruneErr.message);

  return {
    ok: true,
    subs: subs.length,
    candidates: recent.length,
    sent: sentRows.length,
    removed: gone.length,
    failed: failed.length,
    errors,
  };
}

/* ====================================================================
   HTTP
   ==================================================================== */

interface Rules {
  min_mag?: number;
  max_km?: number;
  lat?: number | null;
  lon?: number | null;
  cities?: string[];
}

/** Disaridan gelen kurallari guvenli araliklara sikistirir */
function sanitizeRules(rules: Rules = {}) {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    min_mag: clamp(rules.min_mag, 2, 7, 4),
    max_km: clamp(rules.max_km, 0, 1000, 0),
    lat: Number.isFinite(Number(rules.lat)) ? Number(rules.lat) : null,
    lon: Number.isFinite(Number(rules.lon)) ? Number(rules.lon) : null,
    cities: Array.isArray(rules.cities)
      ? rules.cities.filter((c) => typeof c === 'string').slice(0, 81)
      : [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * Uygulamanin canli veri kaynagi. GET oldugu ve ozel baslik tasimadigi icin
 * tarayici on istek (preflight) atmaz. Veri en fazla 5 dakikalik oldugundan
 * kisa bir sure onbelleklenebilir.
 */
async function feed(): Promise<Response> {
  const { data, error } = await admin
    .from('zlzl_feed')
    .select('quakes, errors, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return new Response(JSON.stringify({
    updated: data?.updated_at ?? null,
    quakes: data?.quakes ?? [],
    errors: data?.errors ?? [],
  }), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (req.method === 'GET') {
    if (new URL(req.url).searchParams.get('action') !== 'feed') {
      return json({ error: 'bilinmeyen işlem' }, 400);
    }
    try {
      return await feed();
    } catch (err) {
      console.error(err);
      return json({ error: String((err as Error).message ?? err) }, 500);
    }
  }

  if (req.method !== 'POST') return json({ error: 'yalnızca GET veya POST' }, 405);

  try {
    const config = await loadConfig();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    /* -------------------------------------------------- zamanlanmis is */
    if (action === 'dispatch') {
      if (req.headers.get('x-zlzl-secret') !== config.dispatch_secret) {
        return json({ error: 'yetkisiz' }, 401);
      }
      return json(await dispatch(config));
    }

    /* ------------------------------------------------------- tarayici */
    if (action === 'subscribe' && body.apns_token) {
      // iPhone uygulamasi: APNs cihaz jetonu (onaltilik)
      const token = String(body.apns_token);
      if (!/^[0-9a-f]{64,200}$/i.test(token)) return json({ error: 'geçersiz jeton' }, 400);

      const { error } = await admin.from('zlzl_subs').upsert({
        endpoint: APNS_PREFIX + token.toLowerCase(),
        p256dh: '',
        auth: '',
        device_id: body.device_id,
        ...sanitizeRules(body.rules),
      }, { onConflict: 'endpoint' });
      if (error) throw error;

      return json({ ok: true });
    }

    if (action === 'subscribe') {
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return json({ error: 'abonelik bilgisi eksik' }, 400);
      }
      if (!/^https:\/\//.test(sub.endpoint)) return json({ error: 'geçersiz uç' }, 400);

      const { error } = await admin.from('zlzl_subs').upsert({
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        device_id: body.device_id,
        ...sanitizeRules(body.rules),
      }, { onConflict: 'endpoint' });
      if (error) throw error;

      return json({ ok: true });
    }

    if (action === 'update') {
      if (!body.endpoint) return json({ error: 'uç eksik' }, 400);
      const { error } = await admin
        .from('zlzl_subs')
        .update(sanitizeRules(body.rules))
        .eq('endpoint', body.endpoint)
        .eq('device_id', body.device_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'unsubscribe') {
      if (!body.endpoint) return json({ error: 'uç eksik' }, 400);
      await admin.from('zlzl_subs').delete()
        .eq('endpoint', body.endpoint)
        .eq('device_id', body.device_id);
      return json({ ok: true });
    }

    if (action === 'test') {
      // Cihaz kimligi de eslesmeli; yalnizca ucu bilen baskasi deneme tetikleyemesin
      const { data } = await admin
        .from('zlzl_subs')
        .select('endpoint, p256dh, auth')
        .eq('endpoint', body.endpoint)
        .eq('device_id', body.device_id)
        .single();
      if (!data) return json({ error: 'cihaz kayıtlı değil' }, 404);

      const res = await deliver(
        data,
        JSON.stringify({
          title: 'Zelzele bildirimleri çalışıyor',
          body: 'Bu bir deneme bildirimi. Gerçek bir deprem kaydı değildir.',
          id: 'test',
          mag: 0,
        }),
        config,
      );
      if (!res.ok) return json({ error: `push servisi ${res.status}: ${res.error}` }, 502);
      return json({ ok: true });
    }

    return json({ error: 'bilinmeyen işlem' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: String((err as Error).message ?? err) }, 500);
  }
});
