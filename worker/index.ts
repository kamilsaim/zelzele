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
 *
 *  B) Zamanlanmis is (pg_cron -> pg_net, x-zlzl-secret basligiyla)
 *       dispatch    — yeni depremleri bulur, kurallara uyan cihazlara gonderir
 *
 * Kurallarin hangisi tutarsa bildirim gider (VEYA mantigi):
 *   1. Buyukluk >= min_mag                      (Turkiye geneli)
 *   2. Mesafe <= max_km ve buyukluk >= 3.0      (yakinimdaki)
 *   3. Il, takip listesinde ve buyukluk >= 3.0  (sehirlerim)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush, type VapidKeys } from './webpush.ts';
import { fetchQuakes, distKm, type Quake } from './quakes.ts';

/** Yakinlik ve sehir kurallarinin alt siniri — bunun altinda bildirim gitmez */
const LOCAL_MIN_MAG = 3.0;

/** Gondericinin geriye bakacagi pencere. Cron 5 dakikada bir kosar; pay birakiyoruz. */
const LOOKBACK_MIN = 90;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-zlzl-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
}

async function loadConfig(): Promise<Config> {
  const { data, error } = await admin
    .from('zlzl_config')
    .select('vapid_public, vapid_private, subject, dispatch_secret')
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
    url: './',
  });
}

/* ====================================================================
   Gonderim
   ==================================================================== */

async function dispatch(config: Config) {
  const vapid = vapidFrom(config);
  const { quakes, errors } = await fetchQuakes(6);

  if (!quakes.length) {
    return { ok: false, reason: 'kaynaklara ulaşılamadı', errors };
  }

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
    const res = await sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payloadFor(quake, reason, sub),
      vapid,
      { urgency: quake.mag >= 5 ? 'high' : 'normal' },
    );
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
  await admin.rpc('zlzl_prune_sent').catch(() => {});

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'yalnızca POST' }, 405);

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

      const res = await sendPush(
        { endpoint: data.endpoint, keys: { p256dh: data.p256dh, auth: data.auth } },
        JSON.stringify({
          title: 'Zelzele bildirimleri çalışıyor',
          body: 'Bu bir deneme bildirimi. Gerçek bir deprem kaydı değildir.',
          id: 'test',
          mag: 0,
        }),
        vapidFrom(config),
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
