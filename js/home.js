/**
 * Özet ekranı — uygulama açıldığında ilk görülen yer.
 *
 * Amaç: kullanıcı hiçbir yere dokunmadan "şu an durum ne?" sorusunun
 * cevabını görsün. Son deprem, günün özeti, yakınındakiler.
 */

import { $, el, ago, fmtFull, fmtClock, distKm } from './util.js';
import { magColor } from './config.js';
import { state, emit } from './state.js';
import { quakeRow } from './list.js';

/** Son 24 saatin depremleri — özet hep bu pencereye bakar, filtreden bağımsız */
function lastDay() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return state.quakes.filter((q) => new Date(q.time).getTime() >= cutoff);
}

/* --------------------------------------------------------- son deprem */

function latestCard(q) {
  const card = el('section', 'hero');

  const top = el('div', 'hero-top');
  const badge = el('div', 'hero-mag', q.mag.toFixed(1));
  badge.style.background = magColor(q.mag);

  const head = el('div', 'hero-head');
  head.append(
    el('div', 'hero-kicker', 'Son kaydedilen deprem'),
    el('div', 'hero-place', q.place || 'Bilinmeyen konum'),
    el('div', 'hero-when', `${fmtClock.format(new Date(q.time))} · ${ago(q.time)}`),
  );
  top.append(badge, head);
  card.append(top);

  const facts = el('div', 'hero-facts');
  const fact = (k, v) => {
    const box = el('div', 'fact');
    box.append(el('div', 'fk', k), el('div', 'fv', v));
    return box;
  };

  facts.append(fact('Derinlik', `${q.depth.toFixed(1)} km`));
  facts.append(fact('Ölçek', q.magType));
  if (state.me) {
    facts.append(fact('Size uzaklık',
      `${Math.round(distKm(state.me.lat, state.me.lon, q.lat, q.lon))} km`));
  }
  facts.append(fact('Kaynak', [q.source, ...q.alsoIn].join(' + ')));

  // Tek sayida kunye kalirsa sonuncusu iki sutuna yayilsin, bos hucre olmasin
  if (facts.children.length % 2) facts.lastChild.style.gridColumn = 'span 2';
  card.append(facts);

  const actions = el('div', 'hero-actions');
  const see = el('button', 'btn primary', 'Haritada gör');
  see.onclick = () => emit('quake:selected', q.id);
  const detail = el('button', 'btn', 'Ayrıntı');
  detail.onclick = () => emit('quake:detail', q.id);
  actions.append(see, detail);
  card.append(actions);

  return card;
}

/* ------------------------------------------------------------ günün özeti */

function summaryCard(day) {
  const biggest = day.length ? day.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;

  const wrap = el('section', 'block');
  wrap.append(el('h2', 'blockhead', 'Son 24 saat'));

  const grid = el('div', 'stats');
  // Sifir bir uyari degil; yalnizca gercekten kayit varsa renklendir
  const cell = (label, count, tint) => {
    const box = el('div', 'stat');
    const v = el('div', 'v', String(count));
    if (tint && count > 0) v.style.color = tint;
    box.append(v, el('div', 'k', label));
    return box;
  };

  const over3 = day.filter((q) => q.mag >= 3).length;
  const over4 = day.filter((q) => q.mag >= 4).length;

  const biggestCell = el('div', 'stat');
  const bv = el('div', 'v', biggest ? biggest.mag.toFixed(1) : '—');
  if (biggest) bv.style.color = magColor(biggest.mag);
  biggestCell.append(bv, el('div', 'k', 'En büyük'));

  grid.append(
    cell('Toplam deprem', day.length),
    cell('3.0 ve üzeri', over3, '#fb923c'),
    cell('4.0 ve üzeri', over4, '#ef4444'),
    biggestCell,
  );
  wrap.append(grid);
  return wrap;
}

/* ------------------------------------------------------------- yakınımda */

function nearbyCard(day) {
  if (!state.me) {
    const card = el('section', 'block callout');
    card.append(
      el('h2', 'blockhead', 'Yakınındakileri gör'),
      el('p', 'note', 'Konumunu paylaşırsan depremlerin sana kaç kilometre uzakta olduğunu hesaplar, yakınında bir şey olduğunda bildirim gönderebilirim. Konum cihazından çıkmaz.'),
    );
    const btn = el('button', 'btn primary', 'Konumumu kullan');
    btn.onclick = () => emit('locate:request');
    card.append(btn);
    return card;
  }

  const near = day
    .map((q) => ({ q, km: distKm(state.me.lat, state.me.lon, q.lat, q.lon) }))
    .filter((x) => x.km <= 250)
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);

  const card = el('section', 'block');
  card.append(el('h2', 'blockhead', '250 km çevrende'));

  if (!near.length) {
    card.append(el('p', 'note', 'Son 24 saatte çevrende kayıtlı deprem yok.'));
    return card;
  }
  const list = el('div', 'rows');
  for (const { q } of near) list.append(quakeRow(q));
  card.append(list);
  return card;
}

/* --------------------------------------------------------------- son liste */

function recentCard(day) {
  const card = el('section', 'block');

  const head = el('div', 'blockrow');
  head.append(el('h2', 'blockhead', 'Son depremler'));
  const more = el('button', 'linkbtn', 'Tümü →');
  more.onclick = () => emit('screen:go', 'list');
  head.append(more);
  card.append(head);

  const list = el('div', 'rows');
  for (const q of day.slice(0, 6)) list.append(quakeRow(q));
  card.append(list);
  return card;
}

/* ------------------------------------------------------------------ dışarı */

export function renderHome() {
  const pane = $('#scr-home');
  pane.textContent = '';

  if (!state.quakes.length) {
    pane.append(el('div', 'empty', 'Veri yükleniyor…'));
    return;
  }

  const day = lastDay();
  const latest = state.quakes[0];

  pane.append(latestCard(latest));
  pane.append(summaryCard(day));
  pane.append(nearbyCard(day));
  if (day.length > 3) pane.append(recentCard(day));

  const foot = el('p', 'note homefoot');
  foot.textContent = state.updated
    ? `Veri güncellendi: ${fmtFull.format(new Date(state.updated))}`
    : '';
  pane.append(foot);
}
