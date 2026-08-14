/**
 * Harita katmani. Leaflet global olarak (CDN) yuklu kabul edilir.
 *
 * Disari `initMap`, `drawQuakes`, `focusQuake`, `setTheme`, `showMe` verir.
 * Bir isaretciye tiklandiginda `quake:selected` olayi yayar; listenin
 * kendini vurgulamasi buna baglidir.
 */

import { $, el, escapeHtml, ago, fmtFull, distKm } from './util.js';
import { TR_BOUNDS, MAG_STOPS, magColor, magRadius, RECENT_MS } from './config.js';
import { state, emit } from './state.js';

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

let map = null;
let tileLayer = null;
let markerLayer = null;
let heatLayer = null;
let faultLayer = null;
let meMarker = null;
let meCircle = null;
const markerById = new Map();

export function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    worldCopyJump: false,
  }).fitBounds(TR_BOUNDS);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  // Yerlesim oturmadan once olculen boyut yanlis olur
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(TR_BOUNDS);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => map.invalidateSize(), 150);
  });

  return map;
}

export const getMap = () => map;

export function setTheme(theme) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[theme], {
    maxZoom: 18,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap, &copy; CARTO — veri: AFAD & Kandilli',
  }).addTo(map);
}

/* ---------------------------------------------------------------- popup */

function popupHtml(q) {
  const dist = state.me
    ? `<div class="pop-row"><span>Size uzaklık</span><b>${Math.round(distKm(state.me.lat, state.me.lon, q.lat, q.lon))} km</b></div>`
    : '';
  const srcs = [q.source, ...q.alsoIn].filter(Boolean).join(' + ');
  return `
    <div class="pop-mag" style="color:${magColor(q.mag)}">${q.mag.toFixed(1)}</div>
    <div class="pop-place">${escapeHtml(q.place || 'Bilinmeyen konum')}</div>
    <div class="pop-row"><span>Zaman</span><b>${fmtFull.format(new Date(q.time))}</b></div>
    <div class="pop-row"><span>Derinlik</span><b>${q.depth.toFixed(1)} km</b></div>
    <div class="pop-row"><span>Ölçek</span><b>${escapeHtml(q.magType)}</b></div>
    <div class="pop-row"><span>Koordinat</span><b>${q.lat.toFixed(4)}, ${q.lon.toFixed(4)}</b></div>
    ${dist}
    <div class="pop-src">Kaynak: ${escapeHtml(srcs)} · ${ago(q.time)}</div>
    <button class="pop-more">Ayrıntı</button>`;
}

/* ------------------------------------------------------------ isaretciler */

export function drawQuakes(list) {
  markerLayer.clearLayers();
  markerById.clear();

  // Kucukler once cizilsin ki buyukler ustte kalsin
  const ordered = [...list].sort((a, b) => a.mag - b.mag);
  const now = Date.now();

  for (const q of ordered) {
    const age = now - new Date(q.time).getTime();
    const ageH = age / 3.6e6;
    const color = magColor(q.mag);

    const marker = L.circleMarker([q.lat, q.lon], {
      radius: magRadius(q.mag),
      color,
      weight: q.mag >= 4 ? 2 : 1,
      opacity: Math.max(0.35, 1 - ageH / 200),
      fillColor: color,
      fillOpacity: Math.max(0.12, 0.55 - ageH / 400),
      className: 'q-mark' + (age < RECENT_MS ? ' recent' : ''),
    });

    marker.bindPopup(() => popupHtml(q), { autoPanPadding: [24, 24] });
    marker.on('click', () => emit('quake:selected', q.id));
    // Baloncuk hizli bakis; tam kayit icin ayrinti sayfasi
    marker.on('popupopen', (e) => {
      const more = e.popup.getElement()?.querySelector('.pop-more');
      if (more) more.onclick = () => emit('quake:detail', q.id);
    });
    marker.addTo(markerLayer);
    markerById.set(q.id, marker);
  }

  if (heatLayer) {
    heatLayer.setLatLngs(list.map((q) => [q.lat, q.lon, Math.max(0.1, (q.mag - 1) / 5)]));
  }
}

export function focusQuake(q, zoom) {
  if (!map) return;
  map.flyTo([q.lat, q.lon], Math.max(zoom || map.getZoom(), 7), { duration: 0.7 });
  const marker = markerById.get(q.id);
  if (marker) setTimeout(() => marker.openPopup(), 720);
}

export const fitTurkey = () => map.flyToBounds(TR_BOUNDS, { duration: 0.7 });

/* -------------------------------------------------------------- katmanlar */

/** @returns {boolean} katman artik acik mi */
export function toggleHeat(list) {
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
    markerLayer.addTo(map);
    return false;
  }
  heatLayer = L.heatLayer([], {
    radius: 24, blur: 18, maxZoom: 9, minOpacity: 0.25,
    gradient: { 0.2: '#38bdf8', 0.4: '#4ade80', 0.6: '#facc15', 0.8: '#fb923c', 1: '#ef4444' },
  }).addTo(map);
  heatLayer.setLatLngs(list.map((q) => [q.lat, q.lon, Math.max(0.1, (q.mag - 1) / 5)]));
  map.removeLayer(markerLayer);
  return true;
}

/** @returns {boolean|null} null = veri dosyasi yok */
export async function toggleFaults() {
  if (faultLayer) {
    map.removeLayer(faultLayer);
    faultLayer = null;
    return false;
  }
  const res = await fetch('data/faults.geojson');
  if (!res.ok) return null;

  faultLayer = L.geoJSON(await res.json(), {
    style: { color: '#f97316', weight: 1.6, opacity: 0.75 },
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.name || feature.properties?.FAY_ADI;
      if (name) layer.bindPopup(`<b>${escapeHtml(name)}</b><br>Diri fay hattı`);
    },
  }).addTo(map);
  return true;
}

/* ---------------------------------------------------------------- konum */

/** Kullanicinin konumunu ve varsa bildirim yaricapini cizer */
export function showMe(me, radiusKm) {
  if (meMarker) map.removeLayer(meMarker);
  if (meCircle) { map.removeLayer(meCircle); meCircle = null; }
  if (!me) return;

  if (radiusKm > 0) {
    meCircle = L.circle([me.lat, me.lon], {
      radius: radiusKm * 1000,
      color: '#38bdf8', weight: 1, opacity: 0.5,
      fillColor: '#38bdf8', fillOpacity: 0.06,
    }).addTo(map);
  }
  meMarker = L.circleMarker([me.lat, me.lon], {
    radius: 7, color: '#fff', weight: 2.5, fillColor: '#38bdf8', fillOpacity: 1,
  }).addTo(map).bindPopup('Buradasınız');
}

export const flyToMe = (me) => map.flyTo([me.lat, me.lon], 8, { duration: 0.8 });

/* --------------------------------------------------------------- gosterge */

export function renderLegend() {
  const box = $('#legend');
  box.textContent = '';
  for (const stop of MAG_STOPS) {
    const row = el('div', 'row');
    const swatch = el('i');
    swatch.style.background = stop.color;
    row.append(swatch, el('span', null, stop.label));
    box.append(row);
  }
}
