/**
 * Uygulamayi kuran ve parcalari birbirine baglayan katman.
 * Butun arayuz olaylari burada dinlenir; is mantigi ilgili modulde durur.
 */

import { $, $$, el, toast, ago, fmtFull, distKm, store } from './util.js';
import { REFRESH_MS, DESKTOP_MIN, PROVINCES } from './config.js';
import { state, settings, setSetting, setFilter, emit, on } from './state.js';
import { fetchAll } from './data.js';
import {
  initMap, setTheme, drawQuakes, focusQuake, fitTurkey,
  toggleHeat, toggleFaults, showMe, flyToMe, renderLegend, getMap,
} from './map.js';
import { filtered, renderList, highlightRow } from './list.js';
import { renderAnalysis } from './analysis.js';
import {
  alertNew, beep, ensurePermission, subscribePush, unsubscribePush,
  syncPushRules, sendTestPush, pushBlocker, pushSupported,
} from './notify.js';

/* ======================================================================
   Cizim
   ====================================================================== */

function render() {
  const list = filtered();
  drawQuakes(list);
  renderList(list);
  if (!$('#tab-analysis').classList.contains('hide')) renderAnalysis(list);
}

/** Filtre degistiginde listeyi bastan goster */
function renderFromFilters() {
  render();
  $('#tab-list').scrollTop = 0;
}

/* ======================================================================
   Durum cubugu ve kaynaklar
   ====================================================================== */

function setStatus(kind, text, title = '') {
  const dot = $('#statusDot');
  dot.className = 'dot' + (
    kind === 'err' ? ' err' : kind === 'loading' ? ' stale' : kind === 'live' ? ' live' : '');
  $('#statusText').textContent = text;
  $('.status').title = title;
}

function renderSources() {
  const box = $('#srcStatus');
  box.textContent = '';
  const labels = {
    repo: 'Depo verisi (GitHub)',
    afad: 'AFAD canlı ucu',
    koeri: 'Kandilli aynası',
  };

  for (const [key, label] of Object.entries(labels)) {
    const s = state.sources[key];
    const row = el('div', 'srcline');
    row.append(el('span', 'dot' + (s?.ok ? '' : ' err')));
    row.append(el('span', null, s
      ? (s.ok ? `${label} — ${s.count} kayıt` : `${label} — ulaşılamadı`)
      : `${label} — denenmedi`));
    if (s && !s.ok) row.title = s.error;
    box.append(row);
  }

  if (state.updated) {
    const row = el('div', 'srcline', `Depo verisi güncellendi: ${fmtFull.format(new Date(state.updated))}`);
    row.style.color = 'var(--fg-mute)';
    box.append(row);
  }
}

/* ======================================================================
   Veri tazeleme
   ====================================================================== */

async function refresh({ quiet = false } = {}) {
  setStatus('loading', 'yenileniyor…');
  const result = await fetchAll();
  state.sources = result.sources;

  if (!result.ok) {
    setStatus('err', 'veri alınamadı');
    if (!quiet) toast('Hiçbir kaynağa ulaşılamadı. Bağlantını kontrol et.', true);
    renderSources();
    return;
  }

  // Yeni gelenleri, gorulen kimliklere eklemeden once tespit et
  const fresh = state.firstLoadDone
    ? result.quakes.filter((q) => !state.seenIds.has(q.id))
    : [];
  for (const q of result.quakes) state.seenIds.add(q.id);

  state.quakes = result.quakes;
  state.updated = result.updated;
  state.firstLoadDone = true;

  render();
  renderSources();

  const newest = result.quakes[0];
  const lagMin = newest ? Math.round((Date.now() - new Date(newest.time)) / 60000) : null;
  setStatus(
    result.live ? 'live' : 'ok',
    newest ? `son deprem ${ago(newest.time)}` : 'veri yok',
    `Kaynaklar: ${Object.entries(result.sources)
      .filter(([, s]) => s.ok).map(([n]) => n.toUpperCase()).join(', ')}` +
    (lagMin != null ? ` · en yeni kayıt ${lagMin} dk önce` : ''),
  );

  if (fresh.length) {
    const alerted = alertNew(fresh);
    if (alerted) focusQuake(alerted, 8);
  }
}

/* ======================================================================
   Sekmeler ve panel
   ====================================================================== */

function showPanel(name) {
  for (const btn of $$('.tabs button')) btn.classList.toggle('on', btn.dataset.tab === name);
  for (const tab of ['list', 'analysis', 'settings']) {
    $(`#tab-${tab}`).classList.toggle('hide', tab !== name);
  }
  if (name === 'analysis') renderAnalysis(filtered());
  if (window.innerWidth < DESKTOP_MIN) $('#panel').classList.remove('min');
}

/* ======================================================================
   Ayar bilesenleri
   ====================================================================== */

/**
 * Anahtar dugmesini bagla.
 * @param onChange async (yeniDeger) => false donerse degisiklik geri alinir
 */
function bindSwitch(sel, key, onChange) {
  const sw = $(sel);
  const paint = () => sw.classList.toggle('on', !!settings[key]);
  paint();

  const toggle = async () => {
    if (sw.dataset.busy) return;
    sw.dataset.busy = '1';
    try {
      const next = !settings[key];
      if (onChange && (await onChange(next)) === false) return;
      setSetting(key, next);
      paint();
    } finally {
      delete sw.dataset.busy;
    }
  };

  sw.onclick = toggle;
  sw.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };
}

/** Kaydirici + yanindaki deger etiketi */
function bindSlider(sel, outSel, key, { decimals = 0, onDone } = {}) {
  const input = $(sel);
  const out = $(outSel);
  const paint = () => { out.textContent = Number(settings[key] ?? state[key]).toFixed(decimals); };
  input.value = settings[key] ?? state[key];
  paint();

  input.oninput = () => {
    const value = Number(input.value);
    if (key in settings) setSetting(key, value); else setFilter(key, value);
    paint();
  };
  if (onDone) input.onchange = onDone;
  return { paint, input };
}

/* ======================================================================
   Favori sehirler
   ====================================================================== */

function renderCities() {
  const box = $('#cityList');
  box.textContent = '';

  if (!state.cities.length) {
    box.append(el('p', 'note', 'Henüz şehir eklemedin. Eklediğin şehirlerde deprem olduğunda bildirim alırsın.'));
  }

  for (const name of state.cities) {
    const chip = el('button', 'citychip');
    chip.append(el('span', null, name), el('span', 'x', '×'));
    chip.title = `${name} takibini bırak`;
    chip.onclick = () => {
      setFilter('cities', state.cities.filter((c) => c !== name));
      renderCities();
      syncPushRules();
    };
    box.append(chip);
  }
}

function initCityPicker() {
  const select = $('#cityPick');
  for (const name of PROVINCES) select.append(new Option(name, name));

  select.onchange = () => {
    const name = select.value;
    select.value = '';
    if (!name || state.cities.includes(name)) return;
    setFilter('cities', [...state.cities, name].sort((a, b) => a.localeCompare(b, 'tr')));
    renderCities();
    syncPushRules();
    toast(`${name} takibe alındı`);
  };
  renderCities();
}

/* ======================================================================
   Konum
   ====================================================================== */

function applyMe() {
  showMe(state.me, settings.push && settings.pushKm ? settings.pushKm : 0);
  $('#pushKmRow').classList.toggle('disabled', !state.me);
  $('#distFilterRow').classList.toggle('disabled', !state.me);
}

function locate() {
  if (!navigator.geolocation) return toast('Tarayıcın konum desteklemiyor.');
  toast('Konum alınıyor…');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setFilter('me', { lat: pos.coords.latitude, lon: pos.coords.longitude });
      applyMe();
      flyToMe(state.me);

      const nearest = [...state.quakes].sort((a, b) =>
        distKm(state.me.lat, state.me.lon, a.lat, a.lon) -
        distKm(state.me.lat, state.me.lon, b.lat, b.lon))[0];
      if (nearest) {
        const km = Math.round(distKm(state.me.lat, state.me.lon, nearest.lat, nearest.lon));
        toast(`Size en yakın: ${nearest.mag.toFixed(1)} — ${nearest.place} (${km} km)`);
      }
      render();
      syncPushRules();
    },
    () => toast('Konum alınamadı. Tarayıcı izinlerini kontrol et.'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

/* ======================================================================
   Mobil alt panel
   ====================================================================== */

function initSheet() {
  const panel = $('#panel');
  const grip = $('#grip');
  let startY = 0, startH = 0, dragging = false;
  const height = () => panel.getBoundingClientRect().height;

  grip.addEventListener('pointerdown', (e) => {
    if (window.innerWidth >= DESKTOP_MIN) return;
    dragging = true;
    startY = e.clientY;
    startH = height();
    panel.style.transition = 'none';
    grip.setPointerCapture(e.pointerId);
  });

  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = Math.min(window.innerHeight * 0.92, Math.max(52, startH - (e.clientY - startY)));
    panel.style.height = `${h}px`;
  });

  grip.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const ratio = height() / window.innerHeight;
    panel.style.height = '';
    panel.classList.remove('min', 'full');
    if (ratio < 0.22) panel.classList.add('min');
    else if (ratio > 0.66) panel.classList.add('full');
    setTimeout(() => getMap().invalidateSize(), 300);
  });

  grip.addEventListener('click', () => {
    if (window.innerWidth >= DESKTOP_MIN) return;
    panel.classList.toggle('full');
    panel.classList.remove('min');
    setTimeout(() => getMap().invalidateSize(), 300);
  });
}

/* ======================================================================
   Kurulum
   ====================================================================== */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('meta[name=theme-color]').setAttribute('content', theme === 'light' ? '#ffffff' : '#0b1120');
  setTheme(theme);
  store.set('theme', theme);
}

let autoTimer = null;
function setupAutoRefresh(on_) {
  clearInterval(autoTimer);
  if (on_) {
    autoTimer = setInterval(() => {
      if (!document.hidden) refresh({ quiet: true });
    }, REFRESH_MS);
  }
}

function wireEvents() {
  // -- sekmeler
  for (const btn of $$('.tabs button')) btn.onclick = () => showPanel(btn.dataset.tab);

  // -- zaman araligi
  $('#rangeChips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    setFilter('hours', Number(chip.dataset.h));
    for (const c of $$('#rangeChips .chip')) c.classList.toggle('on', c === chip);
    renderFromFilters();
  };

  // -- arama (yazarken bekle)
  let queryTimer;
  $('#q').oninput = (e) => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      state.query = e.target.value;
      renderFromFilters();
    }, 180);
  };

  // -- en az buyukluk
  const minMag = $('#minMag');
  minMag.value = state.minMag;
  $('#minMagOut').textContent = state.minMag;
  minMag.oninput = () => {
    setFilter('minMag', Number(minMag.value));
    $('#minMagOut').textContent = state.minMag;
    renderFromFilters();
  };

  // -- mesafe filtresi
  $('#maxKm').onchange = (e) => {
    const km = Number(e.target.value);
    if (km > 0 && !state.me) {
      toast('Önce konum iznini ver (haritadaki hedef simgesi).');
      e.target.value = state.maxKm;
      return;
    }
    setFilter('maxKm', km);
    renderFromFilters();
  };
  $('#maxKm').value = state.maxKm;

  // -- siralama
  $('#sortBy').onchange = (e) => {
    if (e.target.value === 'dist' && !state.me) {
      toast('Önce konum iznini ver (haritadaki hedef simgesi).');
      e.target.value = state.sortBy;
      return;
    }
    state.sortBy = e.target.value;
    renderFromFilters();
  };

  // -- ust cubuk
  $('#btnRefresh').onclick = () => refresh();
  $('#btnTheme').onclick = () =>
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

  // -- harita kontrolleri
  $('#btnLocate').onclick = locate;
  $('#btnFit').onclick = fitTurkey;
  $('#btnHeat').onclick = (e) =>
    e.currentTarget.classList.toggle('on', toggleHeat(filtered()));
  $('#btnFaults').onclick = async (e) => {
    const result = await toggleFaults();
    if (result === null) {
      toast('Fay hattı verisi yok — data/faults.geojson ekleyebilirsin.');
      return;
    }
    e.currentTarget.classList.toggle('on', result);
  };

  // -- yerel uyari ayarlari
  bindSwitch('#swNotify', 'notify', async (on_) => (on_ ? ensurePermission() : true));
  bindSwitch('#swSound', 'sound', (on_) => { if (on_) beep(); return true; });
  bindSwitch('#swAuto', 'auto', (on_) => { setupAutoRefresh(on_); return true; });
  bindSlider('#notifyMag', '#notifyMagOut', 'notifyMag', { decimals: 1 });

  // -- push
  bindSwitch('#swPush', 'push', async (on_) => {
    if (!on_) {
      await unsubscribePush();
      applyMe();
      toast('Arka plan bildirimleri kapatıldı.');
      return true;
    }
    toast('Cihaz kaydediliyor…');
    try {
      if (!(await subscribePush())) return false;
      applyMe();
      toast('Arka plan bildirimleri açık. Uygulama kapalıyken de uyarı alırsın.');
      return true;
    } catch (err) {
      toast(`Kayıt başarısız: ${err.message}`, true);
      return false;
    }
  });

  bindSlider('#pushMag', '#pushMagOut', 'pushMag', { decimals: 1, onDone: syncPushRules });
  bindSlider('#pushKm', '#pushKmOut', 'pushKm', {
    onDone: () => { applyMe(); syncPushRules(); },
  });
  bindSwitch('#swPushCities', 'pushCities', () => { syncPushRules(); return true; });

  $('#btnTestPush').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Gönderiliyor…';
    try {
      await sendTestPush();
      toast('Deneme bildirimi gönderildi. Birkaç saniye içinde gelmeli.');
    } catch (err) {
      toast(`Gönderilemedi: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Deneme bildirimi gönder';
    }
  };

  // -- PWA kurulumu
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#installRow').classList.remove('hide');
  });
  $('#btnInstall').onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#installRow').classList.add('hide');
  };

  // -- modul olaylari
  on('quake:selected', (id) => {
    const q = state.quakes.find((x) => x.id === id);
    if (!q) return;
    state.selected = id;
    focusQuake(q, 9);
    highlightRow(id);
  });

  on('filter:query', (name) => {
    $('#q').value = name;
    state.query = name;
    showPanel('list');
    renderFromFilters();
  });

  // -- yasam dongusu
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && settings.auto) refresh({ quiet: true });
  });
  window.addEventListener('online', () => refresh({ quiet: true }));

  // -- klavye kisayollari (masaustu)
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'r') refresh();
    if (e.key === 'f') fitTurkey();
    if (e.key === '/') { e.preventDefault(); showPanel('list'); $('#q').focus(); }
  });
}

function start() {
  initMap();
  applyTheme(store.get('theme',
    matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  renderLegend();
  initSheet();
  initCityPicker();
  wireEvents();

  // Kaydedilmis filtreleri arayuze yansit
  for (const chip of $$('#rangeChips .chip')) {
    chip.classList.toggle('on', Number(chip.dataset.h) === state.hours);
  }
  applyMe();

  // Push desteklenmiyorsa bolumu gizlemek yerine nedenini yaz
  const blocker = pushBlocker();
  if (blocker) {
    $('#pushNote').textContent = blocker;
    $('#pushNote').classList.remove('hide');
    if (!pushSupported()) $('#swPush').classList.add('disabled');
  }

  setupAutoRefresh(settings.auto);
  refresh();

  // "3 dk once" etiketleri kendiliginden yaslansin
  setInterval(() => {
    if (!$('#tab-list').classList.contains('hide')) renderList(filtered());
  }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Bildirime tiklaninca ilgili depreme git
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'focus-quake' && e.data.id) emit('quake:selected', e.data.id);
    });
  }
}

start();
