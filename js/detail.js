/**
 * Deprem ayrıntı sayfası — listeden bir depreme dokunulduğunda alttan açılır.
 *
 * Haritadaki baloncuk hızlı bakış için; burası tam kayıt: koordinat, ölçek,
 * artçılar, paylaşma. Telefonda geri tuşu da bunu kapatır.
 */

import { $, el, escapeHtml, ago, fmtFull, distKm, toast } from './util.js';
import { magColor } from './config.js';
import { state, emit } from './state.js';

let open = false;

function row(key, value) {
  const r = el('div', 'drow');
  r.append(el('span', 'dk', key), el('span', 'dv', value));
  return r;
}

/** Bu depremden sonra 100 km içinde olan sarsıntılar */
function aftershocks(q) {
  const t0 = new Date(q.time).getTime();
  return state.quakes.filter((x) =>
    x.id !== q.id &&
    new Date(x.time).getTime() > t0 &&
    new Date(x.time).getTime() - t0 < 7 * 86400_000 &&
    distKm(q.lat, q.lon, x.lat, x.lon) < 100);
}

export function showDetail(id) {
  const q = state.quakes.find((x) => x.id === id);
  if (!q) return;

  const sheet = $('#detail');
  const body = $('#detailBody');
  body.textContent = '';

  /* --- başlık --- */
  const head = el('div', 'dhead');
  const badge = el('div', 'dmag', q.mag.toFixed(1));
  badge.style.background = magColor(q.mag);
  const title = el('div');
  title.append(
    el('div', 'dplace', q.place || 'Bilinmeyen konum'),
    el('div', 'dwhen', `${fmtFull.format(new Date(q.time))} · ${ago(q.time)}`),
  );
  head.append(badge, title);
  body.append(head);

  /* --- künye --- */
  const facts = el('div', 'drows');
  if (q.province) facts.append(row('İl', q.province));
  facts.append(row('Derinlik', `${q.depth.toFixed(1)} km`));
  facts.append(row('Büyüklük ölçeği', q.magType));
  facts.append(row('Enlem', q.lat.toFixed(4)));
  facts.append(row('Boylam', q.lon.toFixed(4)));
  if (state.me) {
    const km = Math.round(distKm(state.me.lat, state.me.lon, q.lat, q.lon));
    facts.append(row('Size uzaklık', `${km} km`));
  }
  facts.append(row('Kaynak', [q.source, ...q.alsoIn].join(' + ')));
  body.append(facts);

  /* --- artçılar --- */
  const after = aftershocks(q);
  if (after.length) {
    const note = el('div', 'dnote');
    note.append(
      el('b', null, `${after.length} sonraki sarsıntı`),
      el('span', null, ` — bu depremden sonra 100 km içinde kaydedildi, en büyüğü ${Math.max(...after.map((x) => x.mag)).toFixed(1)}.`),
    );
    body.append(note);
  }

  /* --- eylemler --- */
  const actions = el('div', 'dactions');

  const onMap = el('button', 'btn primary', 'Haritada göster');
  onMap.onclick = () => { hideDetail(); emit('quake:selected', q.id); };
  actions.append(onMap);

  const share = el('button', 'btn', 'Paylaş');
  share.onclick = async () => {
    const text =
      `${q.mag.toFixed(1)} büyüklüğünde deprem — ${q.place}\n` +
      `${fmtFull.format(new Date(q.time))} · ${q.depth.toFixed(1)} km derinlik\n` +
      `Kaynak: ${[q.source, ...q.alsoIn].join(' + ')}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Zelzele', text });
      } else {
        await navigator.clipboard.writeText(text);
        toast('Panoya kopyalandı');
      }
    } catch { /* kullanici vazgecti */ }
  };
  actions.append(share);

  body.append(actions);

  // Resmi kayit oldugunu her ekranda tekrar soyluyoruz
  body.append(el('p', 'note dfoot',
    'Bu kayıt AFAD ve Kandilli Rasathanesi verisinden alınmıştır. İlk yayınlanan büyüklükler kurumlar tarafından sonradan revize edilebilir.'));

  sheet.classList.add('show');
  open = true;
  // Geri tusu ayrintiyi kapatsin, uygulamadan cikmasin
  history.pushState({ detail: id }, '');
}

export function hideDetail({ fromHistory = false } = {}) {
  if (!open) return;
  $('#detail').classList.remove('show');
  open = false;
  if (!fromHistory && history.state?.detail) history.back();
}

export function initDetail() {
  $('#detailClose').onclick = () => hideDetail();
  $('#detailScrim').onclick = () => hideDetail();

  window.addEventListener('popstate', () => {
    if (open) hideDetail({ fromHistory: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDetail();
  });
}
