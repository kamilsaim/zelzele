# Push altyapısı

Uygulama kapalıyken bildirim gönderen sunucu tarafı. Supabase projesi `beebook`
üzerinde çalışır; tüm nesneler başka uygulamalarla karışmasın diye `zlzl_` öneklidir.

## Nasıl çalışıyor

```
pg_cron (5 dk)  →  zlzl_dispatch()  →  pg_net  →  Edge Function "zlzl-push"
                                                        │
                                          AFAD + Kandilli'den son 24 saat
                                                        │
                                          zlzl_feed'e yaz  →  uygulama GET ?action=feed ile okur
                                                        │
                                          son 90 dk'daki depremler
                                                        │
                                          her abone için kural eşleştirmesi
                                                        │
                                          Web Push (VAPID + aes128gcm)
                                                        │
                                          zlzl_sent'e işaretle (tekrar gitmesin)
```

Tarayıcı aynı uca `subscribe` / `update` / `unsubscribe` / `test` işlemleriyle (POST) ve
canlı veri için `GET ?action=feed` ile konuşur.
`dispatch` işlemi `x-zlzl-secret` başlığı ister; bu sır yalnızca veritabanında durur,
istemciye hiçbir zaman gitmez.

## Bildirim kuralları

Üçünden **herhangi biri** tutarsa bildirim gider:

| Kural | Koşul |
|---|---|
| Türkiye geneli | `büyüklük ≥ min_mag` (kullanıcının seçtiği eşik, varsayılan 4.0) |
| Yakınımdaki | `mesafe ≤ max_km` **ve** `büyüklük ≥ 3.0` |
| Şehirlerim | `il ∈ cities` **ve** `büyüklük ≥ 3.0` |

Yakınlık ve şehir kurallarının 3.0 alt sınırı `index.ts` içindeki `LOCAL_MIN_MAG`
sabitinden gelir. Bu sınır olmasa kullanıcı günde onlarca 1.5'lik sarsıntı bildirimi
alır ve bildirimleri komple kapatır.

## iPhone uygulaması (APNs)

iOS uygulaması (Capacitor kabuğu, Mac klasörü `C:\mac\zelzele`) WKWebView'dir; orada
service worker push yoktur. Uygulama `@capacitor/push-notifications` ile APNs jetonu alır ve
`subscribe` işlemine `subscription` yerine `apns_token` gönderir. Kayıt aynı `zlzl_subs`
tablosuna `endpoint = "apns:<jeton>"` olarak düşer (`p256dh`/`auth` boş). Böylece kurallar,
`zlzl_sent`, `update` / `unsubscribe` / `test` hiç değişmeden çalışır; `index.ts` içindeki
`deliver` uca bakıp Web Push ya da `apns.ts`'i seçer.

- Anahtar: Team Scoped APNs anahtarı (Key ID `7V2L7K74PL`, Türbedar'la ortak). Ayarlar VAPID gibi
  `zlzl_config`'te: `apns_key_p8`, `apns_key_id`, `apns_team_id`, `apns_topic` (`com.kamilsaim.zelzele`).
  Anahtarın yazılması: `C:/apk/apple-anahtar/zelzele/OKU-BENI.md`.
- Sağlayıcı JWT'si `apns_jwt` / `apns_jwt_at` sütunlarında 50 dk önbelleklenir (Apple 20 dk'dan
  sık yenilemeyi 429 ile cezalandırır).
- Önce `api.push.apple.com`; `BadDeviceToken` gelirse sandbox (Xcode'dan kurulan sürüm). İki ortamda
  da `BadDeviceToken` ya da 410 → kayıt silinir.
- Mac'siz doğrulama: sahte jetonla (`'ab'` × 32) `subscribe` + `test` → yanıt `BadDeviceToken` ise
  anahtar doğru (`InvalidProviderToken` = anahtar/Key ID yanlış). Sonra `unsubscribe`.

## Tablolar

| Tablo | İşi |
|---|---|
| `zlzl_subs` | Cihaz abonelikleri ve kuralları. Birincil anahtar push ucudur. |
| `zlzl_sent` | Hangi depremin hangi cihaza gittiği. Cron 5 dakikada bir koştuğu için bu olmadan aynı bildirim tekrar giderdi. 30 günden eskisi `zlzl_prune_sent()` ile silinir — her gün 03:17 UTC'de `zlzl-prune` cron işi çalıştırır. |
| `zlzl_feed` | Tek satır: son 24 saatin birleştirilmiş depremleri. Her dispatch turu yazar, uygulamanın canlı veri kaynağı budur. Herkese açık veri olduğu için `feed` işlemi yetki istemez. |
| `zlzl_config` | VAPID anahtar çifti ve gönderim sırrı. RLS ile anon/authenticated erişimi tamamen kapalı; yalnızca service_role okur. |

Tüm tablolarda RLS açık ve hiçbir politika tanımlı değil — yani edge function
dışından kimse okuyamaz. Push uçları kişisel veri sayılır, bu yüzden dışarı açık değildir.

## Doğrulama

Şifreleme ve VAPID imzası test edilmiştir:

```bash
node worker/webpush.test.mjs
```

Test, `sendPush`'un ürettiği gövdeyi **tarayıcının çözdüğü gibi** çözer ve düz metnin
birebir geri geldiğini gösterir; ayrıca üretilen JWT'nin imzasını açık anahtarla
doğrular — push servisinin yaptığı kontrol tam olarak budur. 12/12 geçiyor.

## Yeniden deploy

Edge function Supabase MCP ile deploy edildi. Elle güncellemek için:

```bash
supabase functions deploy zlzl-push --project-ref pdxnpnlwrtswwifevlil --no-verify-jwt
```

`--no-verify-jwt` şart: tarayıcı ve cron JWT üretmiyor, yetki `x-zlzl-secret` ve
cihaz kimliği eşleşmesiyle sağlanıyor.

## VAPID anahtarları

Açık anahtar `js/config.js` içinde (gizli değil, tarayıcıya verilmek üzere üretildi).
Özel anahtar `zlzl_config.vapid_private` sütununda ve yerelde `.vapid.json` dosyasında;
bu dosya `.gitignore`'da, **asla commit'lenmemeli**.

Anahtarları değiştirirsen tüm mevcut abonelikler geçersiz olur — istemci bunu fark
edip (`subscribePush` içindeki anahtar karşılaştırması) kendini yeniden kaydeder.

## Bilinen sınırlar

- **iOS**: Web Push yalnızca ana ekrana eklenmiş uygulamada çalışır (Apple şartı).
  Uygulama bunu tespit edip kullanıcıya açıklıyor.
- **Gecikme**: cron 5 dakikada bir koşar, yani bildirim depremden 0–5 dakika sonra
  gider. Daha hızlısı için sürekli çalışan bir servis gerekir.
- **Ölçek**: `dispatch` tüm abonelikleri belleğe alıp eşleştirir. Birkaç bin aboneye
  kadar sorunsuz; ötesinde kural eşleştirmesini SQL'e taşımak gerekir.
