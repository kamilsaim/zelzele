/**
 * Filtreleme ve deprem listesi.
 */

import { $, el, ago, fold, distKm } from './util.js';
import { magColor, DESKTOP_MIN } from './config.js';
import { state, emit } from './state.js';

/** Aktif filtrelerden gecen depremler, secili siralamayla */
export function filtered() {
  const cutoff = Date.now() - state.hours * 3600 * 1000;
  const needle = fold(state.query.trim());
  const me = state.me;

  const out = state.quakes.filter((q) => {
    if (new Date(q.time).getTime() < cutoff) return false;
    if (q.mag < state.minMag) return false;
    if (state.maxKm > 0 && me && distKm(me.lat, me.lon, q.lat, q.lon) > state.maxKm) return false;
    if (needle && !fold(q.place).includes(needle) && !fold(q.province).includes(needle)) return false;
    return true;
  });

  if (state.sortBy === 'mag') {
    out.sort((a, b) => b.mag - a.mag || new Date(b.time) - new Date(a.time));
  } else if (state.sortBy === 'dist' && me) {
    out.sort((a, b) =>
      distKm(me.lat, me.lon, a.lat, a.lon) - distKm(me.lat, me.lon, b.lat, b.lon));
  } else {
    out.sort((a, b) => new Date(b.time) - new Date(a.time));
  }
  return out;
}

/**
  * Bir depremin liste satiri — hem listede hem ozet ekraninda kullanilir.
  *
  * Dokunusun ne yaptigi ekrana gore degisir: masaustunde harita zaten yanda
  * durdugu icin isaretciye gidilir, telefonda ayrinti sayfasi acilir.
  */
export function quakeRow(q, { selected = false } = {}) {
  const row = el('button', 'qitem' + (selected ? ' sel' : ''));
  row.dataset.id = q.id;

  const mag = el('div', 'qmag', q.mag.toFixed(1));
  mag.style.background = magColor(q.mag);

  const body = el('div', 'qbody');
  body.append(el('div', 'qplace', q.place || 'Bilinmeyen konum'));

  const bits = [ago(q.time), `${q.depth.toFixed(0)} km derinlik`];
  if (state.me) bits.push(`${Math.round(distKm(state.me.lat, state.me.lon, q.lat, q.lon))} km uzakta`);
  body.append(el('div', 'qsub', bits.join(' · ')));

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('class', 'qchev');
  const tip = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tip.setAttribute('d', 'M9 5l7 7-7 7');
  chevron.append(tip);

  row.append(mag, body, chevron);
  row.onclick = () => emit(
    window.innerWidth >= DESKTOP_MIN ? 'quake:selected' : 'quake:detail', q.id,
  );
  return row;
}

export function renderList(list) {
  const box = $('#list');
  box.textContent = '';
  $('#listCount').textContent = list.length ? `${list.length} deprem` : 'eşleşen deprem yok';

  if (!list.length) {
    box.append(el('div', 'empty',
      'Bu filtrelerle deprem bulunamadı. Zaman aralığını genişletmeyi dene.'));
    return;
  }

  const frag = document.createDocumentFragment();
  // 400'den fazlasini cizmek listeyi yavaslatir, kullaniciya da faydasi yok
  for (const q of list.slice(0, 400)) {
    frag.append(quakeRow(q, { selected: q.id === state.selected }));
  }
  box.append(frag);
}

/** Secili satiri isaretler ve gorunur alana kaydirir */
export function highlightRow(id) {
  for (const node of document.querySelectorAll('.qitem')) {
    node.classList.toggle('sel', node.dataset.id === id);
  }
  const node = document.querySelector(`.qitem[data-id="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
