# Freqtrade ile BesYontem stratejisi

Bu klasör, `bot/` klasöründeki stratejinin [Freqtrade](https://www.freqtrade.io) sürümünü içerir. Freqtrade, yıllardır geliştirilen ve geniş bir topluluk tarafından kullanılan açık kaynak bir kripto botudur.

İçerik:

```
user_data/strategies/BesYontem.py        Strateji (5 yöntem, skor, trend şartı, %8 zarar durdur)
user_data/config.json                    Binance spot, 4 saatlik mum, hacme göre ilk 10 coin, DRY-RUN
user_data/config-backtest.json           Backtest için sabit 10 coin, 100 USDT sermaye
user_data/config-private.example.json    API anahtarları, Telegram ve web paneli için örnek
```

> **Kâr garantisi yoktur.** Aşağıdaki geçmiş sonuçlar iyimserdir. Kaybetmeyi göze alamayacağınız parayla kullanmayın.

## Strateji

Her 4 saatlik mum kapandığında beş yöntem oy verir. Her yöntemin oyu +1 (alım yönlü), 0 (nötr) ya da −1 (satış yönlü) olur:

| Yöntem | +1 | −1 |
|---|---|---|
| Trend (EMA200) | Fiyat EMA200 üstünde | Fiyat EMA200 altında |
| EMA 20/50 | EMA20 > EMA50 | EMA20 < EMA50 |
| MACD (12/26/9) | Histogram pozitif ve artıyor | Histogram negatif ve azalıyor |
| RSI (14) | RSI < 30 | RSI > 70 |
| Bollinger (20, 2) | Fiyat alt bandın altında | Fiyat üst bandın üstünde |

- **Alım:** Skor 3 veya üstünde ve fiyat EMA200 üstünde.
- **Satış:** Skor −2 veya altında, ya da fiyat %8 düştüğünde (zarar durdur).

Yalnızca spot piyasada, yalnızca long pozisyon açar; kaldıraç kullanmaz.

Zarar durdur emri Binance'te ayrıca bekler (`stoploss_on_exchange`). Bu sayede bot kapansa ya da bağlantı kopsa bile zarar durdur çalışır.

Coin listesi ayarları (`pairlists`):
- USDT paritelerinden hacme göre ilk 40'ı alınır.
- 365 günden yeni listelenenler elenir. Bu kural tokenize hisseleri ve yeni tokenları dışarıda tutar.
- Fiyatı neredeyse hiç oynamayanlar (stablecoinler) elenir.
- Kalanlardan ilk 10'u kullanılır. Liste günde bir yenilenir.

## Kurulum

En kolay yol Docker'dır:

```bash
cd freqtrade
docker run --rm -v "$PWD/user_data:/freqtrade/user_data" freqtradeorg/freqtrade:stable --version
```

Docker yerine Python ile kurmak isterseniz (Python 3.11 veya üstü):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install freqtrade
freqtrade --version
```

Aşağıdaki komutlar Python kurulumuna göre yazılmıştır. Docker kullanıyorsanız `freqtrade` yerine şunu yazın:
`docker run --rm -it -v "$PWD/user_data:/freqtrade/user_data" freqtradeorg/freqtrade:stable`

## 1. Geçmiş test (API anahtarı gerekmez)

```bash
cd freqtrade
freqtrade download-data --userdir user_data -c user_data/config.json -c user_data/config-backtest.json \
  --timeframes 4h --timerange 20230101-
freqtrade backtesting --userdir user_data -c user_data/config.json -c user_data/config-backtest.json \
  --timerange 20251125-20261124 --fee 0.001
```

Sonuçları grafikle görmek için: `freqtrade plot-dataframe --userdir user_data -c user_data/config.json -c user_data/config-backtest.json -p BTC/USDT`

Ayarları otomatik denemek için `freqtrade hyperopt --spaces buy sell` kullanılabilir. Ama en iyi çıkan ayar büyük olasılıkla o döneme "ezberlenmiş" olur. Seçtiğiniz ayarı mutlaka başka bir dönemde de test edin.

### Bizim yaptığımız test

Testi Kasım 2026'da Freqtrade 2026.10 ile yaptık:
- Gerçek Binance verisi, aynı 10 coin
- 100 USDT sermaye: 5 pozisyon × 20 USDT
- %0,1 komisyon

| Dönem | Freqtrade | bot/ (Node.js) | Piyasa (al-tut) |
|---|---|---|---|
| Kas 2025 – Kas 2026 | +67,9 USDT (54 işlem) | +60,9 USDT | düşüş |
| Kas 2024 – Kas 2025 | +234,2 USDT (60 işlem) | +222,0 USDT | +%77 |
| Kas 2023 – Kas 2024 | +112,9 USDT (96 işlem) | +126,9 USDT | +%351 |

İki uygulama birbirine yakın sonuç veriyor. Küçük farklar, EMA'nın başlatılma şekli ve zarar durdurun nasıl simüle edildiği gibi ayrıntılardan geliyor.

Bu sonuçlar iyimser, çünkü coinler bugünün en yüksek hacimli coinleri arasından seçildi. Kârın büyük kısmı birkaç coinden geliyor (özellikle NEAR ve ZEC). Bakiyenin zirveden en büyük düşüşü %19-43 arasında oldu.

## 2. Simülasyon (DRY-RUN): gerçek fiyatlar, sahte para

`config.json` dosyasında `"dry_run": true` ayarı zaten var. Simülasyon cüzdanı 73 USDT, pozisyon başına 10 USDT.

```bash
freqtrade trade --userdir user_data -c user_data/config.json
```

Birkaç hafta bu modda çalıştırıp sonuçları izleyin.

## 3. Gerçek işlem

1. Binance → **API Management** bölümünden yeni bir anahtar oluşturun:
   - Yalnızca **Enable Reading** ve **Enable Spot & Margin Trading** açık olsun.
   - **Enable Withdrawals KAPALI** kalsın.
   - **Restrict access to trusted IPs** ile anahtarı botun çalıştığı makinenin IP adresine kısıtlayın.
2. `user_data/config-private.example.json` dosyasını `user_data/config-private.json` adıyla kopyalayın ve anahtarları yazın. Bu dosya git'e eklenmez.
3. TL'yi Binance'te **Convert** ile USDT'ye çevirin.
4. `config.json` içinde `"dry_run": false` yapın ve başlatın:

```bash
freqtrade trade --userdir user_data -c user_data/config.json -c user_data/config-private.json
```

Freqtrade, `dry_run_wallet` değerini değil gerçek USDT bakiyenizi kullanır. `stake_amount` (10 USDT) × `max_open_trades` (5) = en fazla 50 USDT işlemde olur.

## Telegram ve web paneli (FreqUI)

`config-private.json` dosyasında:
- **Telegram:** `"enabled": true` yapın; token ve chat id değerlerini yazın. Botu `/status`, `/profit`, `/stop` gibi komutlarla telefondan yönetebilirsiniz.
- **Web paneli:** `api_server` bölümünde `"enabled": true` yapın ve güçlü bir şifre belirleyin. Ardından `freqtrade install-ui` komutunu bir kez çalıştırın ve http://127.0.0.1:8080 adresini açın.

Sunucuyu internete açmanız gerekiyorsa önüne HTTPS'li bir reverse proxy koyun.

## bot/ klasöründen farklar

- Analiz yalnızca mum kapanışında yapılır. `bot/` klasöründeki `ANALYSIS_MINUTES` (30 dakikada bir analiz) seçeneğinin Freqtrade'de tam karşılığı yok. Geçmiş testlerde iki yöntem benzer sonuç vermişti.
- Zarar durdur emri Binance'te bekler; `bot/` bunu her dakika kendisi kontrol ediyordu.
- Freqtrade kendi işlem veritabanını tutar (`user_data/*.sqlite`). Pozisyonları `bot/` ile paylaşmaz. **İki botu aynı hesapta aynı anda çalıştırmayın.**
