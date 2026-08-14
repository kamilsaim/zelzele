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
import { renderHome } from './home.js';
import { showDetail, hideDetail, initDetail } from './detail.js';
import {
  alertNew, beep, ensurePermission, subscribePush, unsubscribePush,
  syncPushRules, sendTestPush, pushBlocker, pushSupported,
} from './notify.js';

/* ======================================================================
   Ekranlar
   ====================================================================== */

/** Masaustunde harita hep gorunur oldugu icin ayri bir "harita" ekrani yok */
const SCREENS = ['home', 'map', 'list', 'analysis', 'settings'];
const PANEL_SCREENS = ['home', 'list', 'analysis', 'settings'];

let screen = 'home';

function isDesktop() {
  return window.innerWidth >= DESKTOP_MIN;
}

function showScreen(name) {
  if (!SCREENS.includes(name)) return;
  // Masaustunde harita sekmesi anlamsiz; panelde ozete dus
  if (name === 'map' && isDesktop()) name = 'home';

  screen = name;
  document.body.dataset.screen = name;

  for (const pane of PANEL_SCREENS) {
    $(`#scr-${pane}`).classList.toggle('hide', pane !== name);
  }
  for (const btn of $$('#bottomnav button, .tabs button')) {
    btn.classList.toggle('on', btn.dataset.screen === name);
  }

  if (name === 'home') renderHome();
  if (name === 'analysis') renderAnalysis(filtered());
  if (name === 'map') setTimeout(() => getMap().invalidateSize(), 60);

  store.set('screen', name);
}

/* ======================================================================
   Cizim
   ====================================================================== */

function render() {
  const list = filtered();
  drawQuakes(list);
  renderList(list);
  if (screen === 'analysis') renderAnalysis(list);
  if (screen === 'home') renderHome();
}

/** Filtre degistiginde listeyi bastan goster */
function renderFromFilters() {
  render();
  $('#scr-list').scrollTop = 0;
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
    if (alerted) {
      if (!isDesktop()) showScreen('map');
      focusQuake(alerted, 8);
    }
  }
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
  const paint = () => { out.textContent = Number(settings[key]).toFixed(decimals); };
  input.value = settings[key];
  paint();

  input.oninput = () => {
    setSetting(key, Number(input.value));
    paint();
  };
  if (onDone) input.onchange = onDone;
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
   Kurulum
   ====================================================================== */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('meta[name=theme-color]').setAttribute('content', theme === 'light' ? '#ffffff' : '#0b1120');
  setTheme(theme);
  store.set('theme', theme);
}

let autoTimer = null;
function setupAutoRefresh(enabled) {
  clearInterval(autoTimer);
  if (enabled) {
    autoTimer = setInterval(() => {
      if (!document.hidden) refresh({ quiet: true });
    }, REFRESH_MS);
  }
}

function wireEvents() {
  // -- gezinme (alt menü ve masaüstü sekmeleri aynı veriyi kullanır)
  for (const btn of $$('#bottomnav button, .tabs button')) {
    btn.onclick = () => showScreen(btn.dataset.screen);
  }

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
  const maxKm = $('#maxKm');
  maxKm.value = state.maxKm;
  maxKm.onchange = () => {
    const km = Number(maxKm.value);
    if (km > 0 && !state.me) {
      toast('Önce konum iznini ver.');
      maxKm.value = state.maxKm;
      return;
    }
    setFilter('maxKm', km);
    renderFromFilters();
  };

  // -- siralama
  $('#sortBy').onchange = (e) => {
    if (e.target.value === 'dist' && !state.me) {
      toast('Önce konum iznini ver.');
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
  bindSwitch('#swNotify', 'notify', async (want) => (want ? ensurePermission() : true));
  bindSwitch('#swSound', 'sound', (want) => { if (want) beep(); return true; });
  bindSwitch('#swAuto', 'auto', (want) => { setupAutoRefresh(want); return true; });
  bindSlider('#notifyMag', '#notifyMagOut', 'notifyMag', { decimals: 1 });

  // -- push
  bindSwitch('#swPush', 'push', async (want) => {
    if (!want) {
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
      btn.textContent = 'Deneme gönder';
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
    hideDetail();
    if (!isDesktop()) showScreen('map');
    focusQuake(q, 9);
    highlightRow(id);
  });

  on('quake:detail', (id) => showDetail(id));

  on('screen:go', (name) => showScreen(name));
  on('locate:request', locate);

  on('filter:query', (name) => {
    $('#q').value = name;
    state.query = name;
    showScreen('list');
    renderFromFilters();
  });

  // -- yasam dongusu
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && settings.auto) refresh({ quiet: true });
  });
  window.addEventListener('online', () => refresh({ quiet: true }));

  // Masaustune gecildiginde "harita" ekrani anlamini yitirir
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (screen === 'map' && isDesktop()) showScreen('home');
    }, 160);
  });

  // -- klavye kisayollari (masaustu)
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'r') refresh();
    if (e.key === 'f') fitTurkey();
    if (e.key === '/') { e.preventDefault(); showScreen('list'); $('#q').focus(); }
  });
}

function start() {
  initMap();
  applyTheme(store.get('theme',
    matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  renderLegend();
  initDetail();
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

  showScreen(store.get('screen', 'home'));
  setupAutoRefresh(settings.auto);
  refresh();

  // "3 dk once" etiketleri kendiliginden yaslansin
  setInterval(() => {
    if (screen === 'list') renderList(filtered());
    if (screen === 'home') renderHome();
  }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      // Bildirime tiklaninca ilgili depreme git
      if (e.data?.type === 'focus-quake' && e.data.id) emit('quake:detail', e.data.id);

      // Yeni surum devraldi: sayfa eski kodla calismaya devam etmesin.
      // Bir kez yenile; bayrak olmadan yenileme dongusune girebilir.
      if (e.data?.type === 'sw-updated' && !sessionStorage.getItem('zelzele.reloaded')) {
        sessionStorage.setItem('zelzele.reloaded', '1');
        location.reload();
      }
    });
    // Yenileme bayragi yalnizca guncelleme anina ait olmali
    navigator.serviceWorker.ready.then(() =>
      setTimeout(() => sessionStorage.removeItem('zelzele.reloaded'), 5000));
  }
}

start();
