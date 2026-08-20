<p align="center">
  <img src="icons/icon-192.png" width="120" height="120" alt="Zelzele">
</p>

<h1 align="center">Zelzele</h1>

<p align="center">
  Türkiye'deki depremleri harita üzerinde takip eden, telefonda ve bilgisayarda
  çalışan bir uygulama.<br>
  Veri <b>AFAD</b> ve <b>Kandilli Rasathanesi</b>'nden gelir.
</p>

<p align="center">
  <a href="https://kamilsaim.github.io/zelzele/"><b>Uygulamayı aç &rarr;</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/kamilsaim/zelzele/releases/latest/download/zelzele.apk"><b>Android APK indir</b></a>
</p>

<p align="center">
  <a href="https://github.com/kamilsaim/zelzele/releases/latest">
    <img alt="Son surum" src="https://img.shields.io/github/v/release/kamilsaim/zelzele?label=s%C3%BCr%C3%BCm&color=0ea5e9"></a>
  <a href="https://github.com/kamilsaim/zelzele/releases/latest/download/zelzele.apk">
    <img alt="APK indirme" src="https://img.shields.io/github/downloads/kamilsaim/zelzele/total?label=apk%20indirme&color=22c55e"></a>
  <a href="https://github.com/kamilsaim/zelzele/actions/workflows/update-data.yml">
    <img alt="Veri guncelleme" src="https://img.shields.io/github/actions/workflow/status/kamilsaim/zelzele/update-data.yml?label=veri&color=a855f7"></a>
  <img alt="Bagimliliksiz" src="https://img.shields.io/badge/derleme-yok-64748b">
</p>

<p align="center">
  <sub>Kurulum gerektirmez, hesap istemez, reklam yok. Veri 5 dakikada bir tazelenir.</sub>
</p>

## Ne yapar

- **Özet ekranı** — açılışta son deprem, günün rakamları ve çevrendekiler tek bakışta
- **Harita** — depremler büyüklüğe göre boyutlanır ve renklenir, son 30 dakikadakiler yanıp söner
- **Isı haritası** — depremlerin nerede yoğunlaştığını gösterir; fay zonları kendiliğinden ortaya çıkar
- **Liste ve filtre** — zaman aralığı, en az büyüklük, yer/il araması, en yeni / en büyük / en yakın sıralaması
- **Analiz** — zaman dağılımı, en sık deprem olan iller, büyüklük ve derinlik dağılımı, en büyük depremin artçıları
- **Konum** — izin verirsen depremlerin sana uzaklığını hesaplar
- **Arka plan bildirimi** — uygulama kapalıyken de bildirim. Üç kural: Türkiye geneli eşiği,
  yakınımdaki depremler (yarıçap), takip ettiğim şehirler
- **Şehir takibi** — 81 ilden seçtiklerinde deprem olduğunda haber verir
- **Ayrıntı sayfası** — koordinat, ölçek, artçılar ve paylaşma; telefonda geri tuşuyla kapanır
- **PWA** — ana ekrana eklenir, tam ekran açılır, internetsizken son veriyi gösterir

Telefonda alt menüyle beş ekran arasında geçilir (Özet, Harita, Liste, Analiz, Ayarlar);
bilgisayarda harita solda kalır, aynı ekranlar sağ panelde sekme olur.

## Veri nereden geliyor

Üç kaynak paralel denenir, hangisi yanıt verirse veri ondan gelir; ikisi de tutarsa
kayıtlar birleştirilip aynı deprem tekilleştirilir (90 sn / 20 km / 1.0 büyüklük eşiği).

| Kaynak | Nasıl | Not |
|---|---|---|
| `data/latest.json` | Aynı origin, her zaman çalışır | GitHub Actions 5 dakikada bir tazeler |
| AFAD `apiv2` | Tarayıcıdan doğrudan | CORS'a takılırsa sessizce atlanır |
| Kandilli aynası | Topluluk proxy'si | Ayna kapanırsa sessizce atlanır |

Yani canlı uçlar çalıştığında anlık, çalışmadığında en fazla birkaç dakika gecikmeli
veri görürsün. Uygulama hiçbir durumda boş kalmaz.

`.github/workflows/update-data.yml` `scripts/fetch-quakes.mjs`'i çalıştırır: AFAD'ın
JSON ucundan ve KOERI'nin metin listesinden son 30 günü çeker, birleştirir,
`data/latest.json`'a yazar ve değişiklik varsa commit'ler.

## Telefonda kullanma

**iOS:** Safari'de siteyi aç → Paylaş → *Ana Ekrana Ekle*. Arka plan bildirimi iOS'ta
**yalnızca** böyle kurulmuş uygulamada çalışır — bu Apple'ın şartı, aşılamıyor.
Uygulama bunu tespit edip Ayarlar sekmesinde açıklıyor.

**Android:** Chrome'da siteyi aç → *Ana ekrana ekle* (veya Ayarlar sekmesindeki **Ekle**
düğmesi).

**APK:** [zelzele.apk](https://github.com/kamilsaim/zelzele/releases/latest/download/zelzele.apk)
— Play Store dışından kurulur, ilk açılışta "bilinmeyen kaynak" izni istenir. Ayarlar
sekmesinde de indirme bağlantısı var.

APK ince bir kabuktur, kendi kodu yoktur: siteyi **TWA** (Trusted Web Activity) ile,
Chrome motoruyla ve adres çubuğu olmadan açar. İçerik sunucudan geldiği için web tarafı
değiştiğinde yeni APK yayımlamaya gerek yoktur — uygulama kendini tazeler.

<details>
<summary>Neden TWA, neden WebView değil</summary>

Uygulamanın en kritik özelliği arka plan bildirimi. Push, service worker üzerinden
çalışır; WebView'de (dolayısıyla Capacitor'da) service worker push desteği **yoktur**.
Kabuğu WebView'e çevirmek bildirimi komple kırar ve sunucu tarafını FCM'e taşımayı
gerektirirdi. TWA'da site gerçek Chrome içinde koştuğu için buradaki Supabase + VAPID
düzeni hiç değişmeden çalışır.

Bunun bir bedeli var: TWA'nın adres çubuğunu gizlemesi için site ile uygulamanın
birbirini doğrulaması gerekir. Doğrulama alan adı düzeyindedir, bu yüzden beyan dosyası
bu depoda değil, kök depoda durur:
`https://kamilsaim.github.io/.well-known/assetlinks.json`

</details>

## Fay hatları katmanı

Haritadaki fay hattı düğmesi `data/faults.geojson` dosyasını arar. MTA'nın Diri Fay
Haritası'ndan indirdiğin GeoJSON'u bu isimle koyarsan katman açılır; dosya yoksa düğme
uyarı verip geçer. Çizgi özelliklerinde `name` veya `FAY_ADI` alanı varsa popup'ta gösterilir.

## Dosyalar

```
index.html                        işaretleme ve stiller
js/config.js                      sabitler (renkler, eşikler, push ucu, il listesi)
js/util.js                        genel yardımcılar (zaman, mesafe, depo, toast)
js/state.js                       paylaşılan durum ve modüller arası olay yolu
js/data.js                        üç kaynağı deneyip birleştiren veri katmanı
js/map.js                         Leaflet haritası, işaretçiler, ısı haritası, fay katmanı
js/list.js                        filtreleme ve deprem listesi
js/analysis.js                    istatistik kartları ve SVG grafikler
js/notify.js                      yerel uyarı + push aboneliği
js/home.js                        özet ekranı
js/detail.js                      deprem ayrıntı sayfası
js/app.js                         ekran yönlendirmesi ve tüm arayüz olayları
sw.js                             service worker — önbellek + push alıcısı
manifest.json                     PWA tanımı
scripts/fetch-quakes.mjs          AFAD + KOERI çekici, bağımlılıksız Node
scripts/serve.mjs                 geliştirme sunucusu
worker/                           push sunucusu (Supabase Edge Function) — kendi README'si var
.github/workflows/update-data.yml 5 dakikada bir çalışan güncelleme işi
data/latest.json                  üretilen veri (workflow yazar)
icons/                            uygulama simgesi (192 ve 512) — logo burada
```

Modüller birbirini doğrudan çağırmak yerine `state.js` üzerindeki olay yolunu kullanır
(`emit` / `on`), böylece harita listeyi, liste haritayı import etmek zorunda kalmaz.

## Sınırlar

- GitHub Actions cron'u **en sık 5 dakikada bir** çalışır ve yoğunlukta gecikebilir.
  Anlık gecikme kritikse canlı uçlara veya kendi sunucuna ihtiyacın olur.
- Kandilli aynası üçüncü bir tarafın hizmeti; kapanabilir. Kapanırsa uygulama
  AFAD ve depo verisiyle çalışmaya devam eder.
- İlk yayınlanan büyüklükler kurumlar tarafından sonradan revize edilir.

## Test

```bash
node worker/webpush.test.mjs   # push şifrelemesi ve VAPID imzası
```

## Uyarı

Zelzele resmi bir kaynak değildir. Acil durumlarda AFAD'ın resmi duyurularını takip edin.
Hiçbir deprem tahmini yapmaz — deprem tahmini bilimsel olarak mümkün değildir.
