/**
 * Alt güvenli alan dolgusunu ölçerek ayarlar.
 *
 * Sorun: iPhone'da ana ekrana eklenmiş uygulamada alt menü ekranın altından
 * belirgin şekilde yukarıda duruyordu.
 *
 * Sebep çift sayım. iOS bazen görünümü zaten ana ekran göstergesine (home
 * indicator) göre kırpıp veriyor; ama `env(safe-area-inset-bottom)` yine de
 * sıfırdan büyük dönüyor. Biz de üstüne o kadar dolgu koyunca menü iki kat
 * yukarı itiliyor ve altında boş bir şerit kalıyor.
 *
 * Çözüm: görünümün gerçekten ekranın tamamını kaplayıp kaplamadığını ölçüyoruz.
 *   - Kaplıyorsa  → göstergenin üstünde kalmak için dolgu gerekli.
 *   - Kaplamıyorsa → iOS işi zaten yapmış, dolgu koymuyoruz.
 *
 * CSS tek başına bunu ayırt edemiyor; bu yüzden ölçüm burada yapılıp
 * `--safe-b` değişkeni güncelleniyor.
 */

/** Görünüm ekranın tamamına mı yayılmış? (birkaç piksel sapmaya tolerans) */
function coversFullScreen() {
  const screenH = window.screen?.height;
  if (!screenH) return true;

  // Yatay/dikey çevrildiğinde screen.height sabit kalabiliyor; ikisini de dene
  const screenW = window.screen.width;
  const candidates = [screenH, screenW];
  return candidates.some((h) => Math.abs(window.innerHeight - h) <= 4);
}

/** CSS'e sorup env(safe-area-inset-bottom) değerini piksel olarak öğrenir */
function measureInset() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;' +
    'height:env(safe-area-inset-bottom,0px)';
  document.body.append(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

export function tuneSafeArea() {
  const inset = measureInset();

  // Görünüm ekranın tamamını kaplamıyorsa iOS kırpmayı zaten yapmıştır.
  // Yine de dokunma hedefi kenara yapışmasın diye küçük bir pay bırakıyoruz.
  const needed = coversFullScreen() ? inset : Math.min(inset, 6);

  document.documentElement.style.setProperty('--safe-b', `${Math.round(needed)}px`);
  return { inset, needed, innerHeight: window.innerHeight, screenHeight: window.screen?.height };
}

export function initSafeArea() {
  tuneSafeArea();

  // Ekran döndürüldüğünde ve arayüz yeniden ölçüldüğünde tekrar hesapla
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
