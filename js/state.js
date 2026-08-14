/**
 * Uygulamanin paylasilan durumu ve modullerin haberlesme kanali.
 *
 * Moduller birbirini dogrudan cagirmak yerine `emit()` ile olay yayar,
 * `on()` ile dinler. Boylece harita listeyi, liste haritayi import etmek
 * zorunda kalmaz ve dairesel bagimlilik olusmaz.
 */

import { store } from './util.js';

export const state = {
  /** Birlestirilmis tum depremler, en yeni basta */
  quakes: [],
  /** Bildirim icin: daha once gorulmus deprem kimlikleri */
  seenIds: new Set(),
  firstLoadDone: false,

  /* --- filtreler --- */
  hours: store.get('hours', 24),
  minMag: store.get('minMag', 0),
  maxKm: store.get('maxKm', 0),          // 0 = sinir yok
  query: '',
  sortBy: 'time',

  /* --- kullanici --- */
  me: store.get('me', null),             // {lat, lon}
  cities: store.get('cities', []),       // favori iller
  selected: null,

  /* --- veri katmani --- */
  sources: {},
  updated: null,
};

export const settings = {
  notify: store.get('notify', false),
  notifyMag: store.get('notifyMag', 4),
  sound: store.get('sound', true),
  auto: store.get('auto', true),
  /* --- push --- */
  push: store.get('push', false),
  pushMag: store.get('pushMag', 4),
  pushKm: store.get('pushKm', 200),
  pushCities: store.get('pushCities', true),
};

/** Ayari hem bellekte hem diskte gunceller */
export function setSetting(key, value) {
  settings[key] = value;
  store.set(key, value);
}

/** Filtreyi hem bellekte hem diskte gunceller */
export function setFilter(key, value) {
  state[key] = value;
  if (['hours', 'minMag', 'maxKm', 'me', 'cities'].includes(key)) store.set(key, value);
}

/* --------------------------------------------------------------- olaylar */

const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  bus.addEventListener(name, (e) => handler(e.detail));
}
