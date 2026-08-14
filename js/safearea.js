/**
 * Alt güvenli alan dolgusunu ölçerek ayarlar.
 *
 * Sorun: iPhone'da ana ekrana eklenmiş uygulamada alt menü, ekranın altından
 * olması gerekenin iki katı yukarıda duruyordu.
 *
 * Sebep çift sayım. iOS bazen görünümü zaten ana ekran göstergesine (alttaki
 * çizgi) göre kırpıp veriyor; ama `env(safe-area-inset-bottom)` yine de
 * sıfırdan büyük dönüyor. Biz de üstüne o kadar dolgu koyunca menü iki kat
 * yukarı itiliyor.
 *
 * Çözüm: görünümün ekranın tamamına yayılıp yayılmadığını ölçüyoruz.
 *   - Yayılıyorsa  → gösterge bizim alanımızın içinde, dolgu gerekli.
 *   - Yayılmıyorsa → iOS kırpmayı zaten yapmış, dolgu koymuyoruz.
 *
 * CSS tek başına bu iki durumu ayırt edemiyor; ölçüm bu yüzden burada yapılıp
 * `--safe-b` değişkeni güncelleniyor.
 */

/** Kırpılmış görünümde bile dokunma hedefi kenara yapışmasın diye küçük pay */
const MIN_PADDING = 6;

/**
 * Ölçülen değerlerden dolgu kararı. Saf fonksiyon: test edilebilsin diye
 * DOM'a ve window'a dokunmuyor.
 *
 * @param {object} o
 * @param {number} o.inset       env(safe-area-inset-bottom) değeri, piksel
 * @param {number} o.innerHeight görünüm yüksekliği
 * @param {number} o.innerWidth  görünüm genişliği
 * @param {number} o.screenW     ekran genişliği
 * @param {number} o.screenH     ekran yüksekliği
 * @returns {number} uygulanacak alt dolgu, piksel
 */
export function decidePadding({ inset, innerHeight, innerWidth, screenW, screenH }) {
  if (!inset) return 0;

  // Ekran ölçüleri bazı tarayıcılarda dönmeyle birlikte değişmiyor;
  // yönü görünümden anlayıp doğru kenarla karşılaştırıyoruz.
  const longSide = Math.max(screenH || 0, screenW || 0);
  const shortSide = Math.min(screenH || 0, screenW || 0);
  if (!longSide) return inset; // ekran bilgisi yoksa güvenli tarafta kal

  const portrait = innerHeight >= innerWidth;
  const expected = portrait ? longSide : shortSide;

  // DENENDİ VE YANLIŞ ÇIKTI: fark üst durum çubuğundan geliyor sanıp
  // (topInset ile kıyaslayıp) büyük farklarda tam dolgu uygulamıştık.
  // Gerçek cihazda (iPhone 14/15 Pro, gorunum 793 / ekran 852, fark 59)
  // görünümün ALTI kırpılmış çıktı — tam dolgu koyunca menü ekranın
  // gerçek dibinden 59px yukarıda, altında boş beyaz şerit kalarak durdu
  // (kullanıcı ekran görüntüsüyle doğruladı). Fark ne kaynaklı olursa
  // olsun görünüm ekranı kaplamıyorsa güvenli taraf minimal dolgudur.
  const coversScreen = Math.abs(innerHeight - expected) <= 4;

  return coversScreen ? inset : Math.min(inset, MIN_PADDING);
}

/** CSS'e sorup verilen env(safe-area-inset-*) kenarını piksel olarak öğrenir */
function measureInset(side) {
  const probe = document.createElement('div');
  probe.style.cssText =
    `position:fixed;left:0;${side}:0;width:0;visibility:hidden;pointer-events:none;` +
    `height:env(safe-area-inset-${side},0px)`;
  document.body.append(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

export function tuneSafeArea() {
  const reading = {
    inset: measureInset('bottom'),
    topInset: measureInset('top'),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    screenW: window.screen?.width,
    screenH: window.screen?.height,
  };
  const padding = decidePadding(reading);
  document.documentElement.style.setProperty('--safe-b', `${Math.round(padding)}px`);
  return { ...reading, padding };
}

export function initSafeArea() {
  tuneSafeArea();

  let timer;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(tuneSafeArea, 180);
  };

  window.addEventListener('resize', again);
  window.addEventListener('orientationchange', again);
  // Uygulama arkadan öne döndüğünde iOS ölçüleri değişmiş olabilir
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) again();
  });
}
