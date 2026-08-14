/**
 * Alt güvenli alan kararının testi.
 *
 *   node js/safearea.test.mjs
 *
 * Asıl senaryo ikinci test: iPhone ana ekran uygulamasında iOS görünümü zaten
 * kırpıyor ama env() yine de 34px döndürüyor. O durumda dolgu koyarsak menü
 * iki kat yukarı çıkıyor — kullanıcının bildirdiği hata buydu.
 */

import assert from 'node:assert/strict';
import { decidePadding } from './safearea.js';

const cases = [
  {
    ad: 'iPhone, görünüm tüm ekranı kaplıyor — dolgu gerekli',
    girdi: { inset: 34, innerHeight: 852, innerWidth: 393, screenW: 393, screenH: 852 },
    bekleneni: 34,
  },
  {
    ad: 'iPhone ana ekran, iOS zaten kırpmış — dolgu konmamalı (ASIL HATA)',
    girdi: { inset: 34, innerHeight: 818, innerWidth: 393, screenW: 393, screenH: 852 },
    bekleneni: 6,
  },
  {
    ad: 'iPhone Safari, üstte adres çubuğu da var — dolgu konmamalı',
    girdi: { inset: 34, innerHeight: 734, innerWidth: 393, screenW: 393, screenH: 852 },
    bekleneni: 6,
  },
  {
    ad: 'yatay çevrilmiş, tüm ekranı kaplıyor — dolgu gerekli',
    girdi: { inset: 21, innerHeight: 393, innerWidth: 852, screenW: 393, screenH: 852 },
    bekleneni: 21,
  },
  {
    ad: 'yatay çevrilmiş, kırpılmış — dolgu konmamalı',
    girdi: { inset: 21, innerHeight: 359, innerWidth: 852, screenW: 393, screenH: 852 },
    bekleneni: 6,
  },
  {
    ad: 'güvenli alanı olmayan cihaz (masaüstü) — hiç dolgu yok',
    girdi: { inset: 0, innerHeight: 945, innerWidth: 1568, screenW: 1920, screenH: 1080 },
    bekleneni: 0,
  },
  {
    ad: 'eski iPhone, çentik yok ama ekranı kaplıyor',
    girdi: { inset: 0, innerHeight: 667, innerWidth: 375, screenW: 375, screenH: 667 },
    bekleneni: 0,
  },
  {
    ad: 'birkaç piksel sapma tolere edilmeli',
    girdi: { inset: 34, innerHeight: 850, innerWidth: 393, screenW: 393, screenH: 852 },
    bekleneni: 34,
  },
  {
    ad: 'ekran bilgisi yoksa güvenli tarafta kal',
    girdi: { inset: 34, innerHeight: 818, innerWidth: 393, screenW: 0, screenH: 0 },
    bekleneni: 34,
  },
  {
    ad: 'iPhone 14/15 Pro ana ekran, görünüm 59px kısa — dolgu konmamalı (GERÇEK CİHAZ, kontrol.jpeg)',
    girdi: { inset: 34, innerHeight: 793, innerWidth: 393, screenW: 393, screenH: 852 },
    bekleneni: 6,
  },
];

const sonuc = [];
for (const { ad, girdi, bekleneni } of cases) {
  const cikan = decidePadding(girdi);
  try {
    assert.equal(cikan, bekleneni);
    sonuc.push(['✓', ad]);
  } catch {
    sonuc.push(['✗', `${ad} — beklenen ${bekleneni}, çıkan ${cikan}`]);
    process.exitCode = 1;
  }
}

console.log('\ngüvenli alan kararı\n');
for (const [mark, ad] of sonuc) console.log(`  ${mark} ${ad}`);
const fail = sonuc.filter(([m]) => m === '✗').length;
console.log(`\n  ${sonuc.length - fail}/${sonuc.length} geçti\n`);
