# Push altyapısı

Uygulama kapalıyken bildirim gönderen sunucu tarafı. Supabase projesi `beebook`
üzerinde çalışır; tüm nesneler başka uygulamalarla karışmasın diye `zlzl_` öneklidir.

## Nasıl çalışıyor

```
pg_cron (5 dk)  →  zlzl_dispatch()  →  pg_net  →  Edge Function "zlzl-push"
                                                        │
                                          AFAD + Kandilli'den son 6 saat
                                                        │
                                          son 90 dk'daki depremler
                                                        │
                                          her abone için kural eşleştirmesi
                                                        │
                                          Web Push (VAPID + aes128gcm)
                                                        │
                                          zlzl_sent'e işaretle (tekrar gitmesin)
```

Tarayıcı aynı uca `subscribe` / `update` / `unsubscribe` / `test` işlemleriyle konuşur.
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

## Tablolar

| Tablo | İşi |
|---|---|
| `zlzl_subs` | Cihaz abonelikleri ve kuralları. Birincil anahtar push ucudur. |
| `zlzl_sent` | Hangi depremin hangi cihaza gittiği. Cron 5 dakikada bir koştuğu için bu olmadan aynı bildirim tekrar giderdi. 30 günden eskisi `zlzl_prune_sent()` ile silinir. |
| `zlzl_config` | VAPID anahtar çifti ve gönderim sırrı. RLS ile anon/authenticated erişimi tamamen kapalı; yalnızca service_role okur. |

Üç tabloda da RLS açık ve hiçbir politika tanımlı değil — yani edge function
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
