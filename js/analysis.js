/**
 * Analiz sekmesi — istatistik kartlari ve basit grafikler.
 * Grafikler elde cizilmis SVG; harici grafik kutuphanesi yok.
 */

import { $, el, distKm } from './util.js';
import { magColor } from './config.js';
import { state, emit } from './state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(w, h) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = '76px';
  return svg;
}

function rect(x, y, w, h) {
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('x', x); r.setAttribute('y', y);
  r.setAttribute('width', w); r.setAttribute('height', h);
  return r;
}

function svgTitle(text) {
  const t = document.createElementNS(SVG_NS, 'title');
  t.textContent = text;
  return t;
}

function card(title, note) {
  const box = el('div', 'card');
  box.append(el('h3', null, title), el('p', 'note', note));
  return box;
}

function statGrid(pairs) {
  const grid = el('div', 'stats');
  for (const [label, value] of pairs) {
    const cell = el('div', 'stat');
    cell.append(el('div', 'v', value), el('div', 'k', label));
    grid.append(cell);
  }
  return grid;
}

/** Etiket + oranli cubuk + sayi satirlarindan olusan liste */
function barList(rows, { color, onPick } = {}) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const box = el('div', 'bars');

  for (const [name, count, tint] of rows) {
    const row = el('div', 'bar');
    const track = el('div', 't');
    const fill = el('i');
    fill.style.width = `${(count / max) * 100}%`;
    if (tint || color) fill.style.background = tint || color;
    track.append(fill);

    row.append(el('div', 'n', name), track, el('div', 'c', String(count)));
    if (onPick) {
      row.style.cursor = 'pointer';
      row.onclick = () => onPick(name);
    }
    box.append(row);
  }
  return box;
}

/* ------------------------------------------------------------- kartlar */

/** Zaman icindeki deprem sayisi; sutun rengi o dilimin en buyugunu gosterir */
function timelineCard(list) {
  const buckets = state.hours <= 24 ? 24 : state.hours <= 168 ? 28 : 30;
  const span = state.hours * 3600 * 1000;
  const end = Date.now();
  const counts = new Array(buckets).fill(0);
  const peaks = new Array(buckets).fill(0);

  for (const q of list) {
    const i = Math.floor((new Date(q.time).getTime() - (end - span)) / (span / buckets));
    const idx = Math.min(buckets - 1, i);
    if (idx >= 0) { counts[idx]++; peaks[idx] = Math.max(peaks[idx], q.mag); }
  }

  const unit = state.hours <= 24 ? 'saatlik' : state.hours <= 168 ? '6 saatlik' : 'günlük';
  const box = card('Zaman dağılımı',
    `${unit} dilimlerde deprem sayısı, rengi en büyük sarsıntıyı gösterir`);

  const max = Math.max(...counts, 1);
  const W = 100, H = 46, bw = W / buckets;
  const svg = svgEl(W, H);

  counts.forEach((n, i) => {
    const h = (n / max) * H;
    const bar = rect(i * bw, H - h, Math.max(bw - 0.6, 0.4), Math.max(h, n ? 0.6 : 0));
    bar.setAttribute('fill', n ? magColor(peaks[i]) : 'var(--line)');
    bar.setAttribute('opacity', n ? '0.9' : '0.35');
    bar.append(svgTitle(`${n} deprem${peaks[i] ? ` · en büyük ${peaks[i].toFixed(1)}` : ''}`));
    svg.append(bar);
  });
  box.append(svg);

  // Eksen etiketleri HTML olarak — SVG orantisiz olceklendigi icin metin bozulur
  const axis = el('div', 'axis');
  axis.append(
    el('span', null, state.hours <= 24
      ? `${state.hours} saat önce`
      : `${Math.round(state.hours / 24)} gün önce`),
    el('span', null, 'şimdi'),
  );
  box.append(axis);
  return box;
}

function provinceCard(list) {
  const counts = new Map();
  for (const q of list) {
    const key = q.province || q.place.match(/\(([^)]+)\)/)?.[1] || 'Belirsiz / deniz';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const box = card('En sık deprem olan iller',
    `Seçili aralıkta ${counts.size} farklı bölgede kayıt var`);
  box.append(barList(top, { onPick: (name) => emit('filter:query', name) }));
  return box;
}

function magHistCard(list) {
  const edges = [0, 1, 2, 3, 4, 5, 6, 9];
  const counts = new Array(edges.length - 1).fill(0);

  for (const q of list) {
    for (let i = edges.length - 2; i >= 0; i--) {
      if (q.mag >= edges[i]) { counts[i]++; break; }
    }
  }

  const rows = counts
    .map((n, i) => [
      i === edges.length - 2 ? `${edges[i]}+` : `${edges[i]} – ${edges[i + 1]}`,
      n,
      magColor(edges[i] + 0.5),
    ])
    // Ust uctaki bos kovalari gizle, alttakileri sifir olsa da goster
    .filter(([, n], i) => n > 0 || i <= 5);

  const box = card('Büyüklük dağılımı',
    'Küçük depremler her zaman büyüklerden çok daha sıktır');
  box.append(barList(rows));
  return box;
}

function depthCard(list) {
  const bands = [
    ['0 – 10 km', (d) => d < 10],
    ['10 – 20 km', (d) => d >= 10 && d < 20],
    ['20 – 50 km', (d) => d >= 20 && d < 50],
    ['50 km +', (d) => d >= 50],
  ];
  const rows = bands.map(([name, test]) => [name, list.filter((q) => test(q.depth)).length]);
  const shallow = Math.round((rows[0][1] / list.length) * 100);

  const box = card('Derinlik dağılımı',
    `Depremlerin %${shallow}'i 10 km'den sığ — sığ olanlar yüzeyde daha şiddetli hissedilir`);
  box.append(barList(rows));
  return box;
}

/**
 * En buyuk depremin ardindan 100 km icinde olan sarsintilari sayar.
 * Kaba bir artci gostergesi; bilimsel bir kume analizi degil.
 */
function aftershockCard(list, main) {
  const t0 = new Date(main.time).getTime();
  const cluster = list.filter((q) =>
    q.id !== main.id &&
    new Date(q.time).getTime() > t0 &&
    distKm(main.lat, main.lon, q.lat, q.lon) < 100);

  const box = card('En büyük deprem ve artçıları',
    `${main.mag.toFixed(1)} — ${main.place || 'bilinmeyen konum'}`);

  const grid = statGrid([
    ['Sonraki sarsıntı', String(cluster.length)],
    ['100 km içinde', cluster.length
      ? `en büyüğü ${Math.max(...cluster.map((q) => q.mag)).toFixed(1)}`
      : '—'],
  ]);
  grid.classList.add('boxed');
  box.append(grid);

  const btn = el('button', 'btn', 'Haritada göster');
  btn.style.marginTop = '11px';
  btn.onclick = () => emit('quake:selected', main.id);
  box.append(btn);
  return box;
}

/* --------------------------------------------------------------- disari */

export function renderAnalysis(list) {
  const pane = $('#scr-analysis');
  pane.textContent = '';

  if (!list.length) {
    pane.append(el('div', 'empty', 'Analiz için yeterli veri yok.'));
    return;
  }

  const mags = list.map((q) => q.mag);
  const biggest = list.reduce((a, b) => (b.mag > a.mag ? b : a));
  const perDay = list.length / Math.max(state.hours / 24, 1 / 24);

  pane.append(statGrid([
    ['Toplam deprem', String(list.length)],
    ['En büyük', biggest.mag.toFixed(1)],
    ['Ortalama büyüklük', (mags.reduce((a, b) => a + b, 0) / mags.length).toFixed(2)],
    ['Günlük ortalama', perDay >= 10 ? String(Math.round(perDay)) : perDay.toFixed(1)],
  ]));

  pane.append(
    timelineCard(list),
    provinceCard(list),
    magHistCard(list),
    depthCard(list),
    aftershockCard(list, biggest),
  );
}
