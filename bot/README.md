# Binance Botu ve Backend

Binance **Spot** hesabınıza bağlanan küçük bir Node.js servisi. İçinde iki parça var:

1. **Al-sat botu**: Binance'te en çok işlem gören 10 coini (ya da sizin seçtiğiniz coinleri) sürekli izler. Her coinin grafiğini beş farklı teknik analiz yöntemiyle değerlendirir ve sadece alım yönlü (long) pozisyon açar. Pozisyon limiti, zarar durdur ve günlük işlem limiti vardır.
2. **HTTP API**: bakiye, fiyat, açık emirler, coin analizleri ve bot durumu için uçlar sunar. Botu başlatıp durdurmak da buradan yapılır. Tüm uçlar token ile korunur.

Harici bağımlılık yoktur. Node.js 20.12 veya üstü yeterli.

> **Güvenlik varsayılanları:** `BINANCE_ENV=testnet` ve `DRY_RUN=true`. Siz bu iki ayarı açıkça değiştirmedikçe gerçek para ile hiçbir emir gönderilmez.

## Neden GitHub Pages'te değil?

API anahtarı ve gizli anahtar (secret), statik bir sitenin içine konursa herkes görebilir. Bu servis ayrı bir makinede çalışmalı: bir VPS, Raspberry Pi ya da kendi bilgisayarınız olabilir. Anahtarlar orada `.env` dosyasında durur. `.env` dosyası git'e eklenmez.

## Kurulum

```bash
cd bot
cp .env.example .env
# .env dosyasını düzenleyin (aşağıdaki adımlar)
npm test        # birim testleri (ağa çıkmaz)
npm start       # API sunucusu + bot
```

### 1. Önce testnet ile deneyin

1. https://testnet.binance.vision adresine GitHub hesabınızla girin ve **Generate HMAC_SHA256 Key** ile anahtar üretin.
2. `.env` dosyasında şu satırları doldurun:
   ```
   BINANCE_ENV=testnet
   BINANCE_API_KEY=...
   BINANCE_API_SECRET=...
   API_AUTH_TOKEN=<uzun rastgele değer>
   ```
   Token üretmek için: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. `npm start` komutunu çalıştırın. Önce `DRY_RUN=true` ile, ardından testnette `DRY_RUN=false` ile deneyin. Testnette para sahte olduğu için risk yoktur.

### 2. Canlıya geçiş (gerçek para)

1. Binance → **API Management** bölümünden yeni bir anahtar oluşturun ve şunları ayarlayın:
   - Yalnızca **Enable Reading** ve **Enable Spot & Margin Trading** açık olsun.
   - **Enable Withdrawals KAPALI** kalsın. Bu en önemli ayardır.
   - **Restrict access to trusted IPs only** ile anahtarı sadece sunucunuzun IP adresine kısıtlayın.
2. `.env` dosyasında `BINANCE_ENV=live` yapın. İlk günlerde `DRY_RUN=true` bırakıp logları izleyin.
3. Davranıştan eminseniz `DRY_RUN=false` yapın ve küçük bir `ORDER_QUOTE_AMOUNT` ile başlayın.

> Binance TR (binance.tr) farklı bir API kullanır ve bu kodla **çalışmaz**. Bu servis yalnızca Binance global içindir. Bulunduğunuz ülkenin Binance kullanımına izin verip vermediğini de kontrol edin.

## Strateji nasıl çalışır?

### Hangi coinler?

`SYMBOLS` boşsa bot, USDT paritelerini son 24 saatteki işlem hacmine göre sıralar ve ilk `TOP_N` (varsayılan 10) coini seçer. Liste günde bir yenilenir. Şunlar listeye alınmaz:
- Stablecoinler ve fiat paralar (USDC, FDUSD, USD1, EUR, TRY…). Fiyatı 1 civarında sabit duran varlıklar da otomatik elenir.
- Sarmalanmış (wrapped) varlıklar (WBTC, WBETH…)
- `MIN_LISTING_DAYS` (varsayılan 365) günden yeni listelenenler. Bu kural tokenize hisse ve ETF'leri (NVDAB, SOXLB gibi) ve yeni tokenları dışarıda tutar. Ayrıca göstergeler için yeterli geçmiş veri olmasını sağlar.
- `EXCLUDE_ASSETS` ile sizin çıkardıklarınız

Coinleri kendiniz seçmek isterseniz: `SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT`

### Analiz yöntemleri

Her coin, `KLINE_INTERVAL` (varsayılan 4 saat) mumu kapandığında beş yöntemle değerlendirilir. Her yöntem +1 (alım yönlü), 0 (nötr) ya da −1 (satış yönlü) oy verir:

| Yöntem | +1 | −1 |
|---|---|---|
| Trend (EMA200) | Fiyat EMA200 üstünde | Fiyat EMA200 altında |
| EMA 20/50 | EMA20 > EMA50 | EMA20 < EMA50 |
| MACD (12/26/9) | Histogram pozitif ve artıyor | Histogram negatif ve azalıyor |
| RSI (14) | RSI < 30 (aşırı satım) | RSI > 70 (aşırı alım) |
| Bollinger (20, 2) | Fiyat alt bandın altında | Fiyat üst bandın üstünde |

Oyların toplamı skoru verir (−5 ile +5 arası).

- **Alım:** Skor `BUY_SCORE` (varsayılan 3) veya üstünde olmalı. `REQUIRE_TREND=true` ise fiyat ayrıca EMA200 üstünde olmalı. Coinde açık pozisyon olmamalı ve açık pozisyon sayısı `MAX_OPEN_POSITIONS` altında olmalı.
- **Satış:** Skor `SELL_SCORE` (varsayılan −2) veya altına düşerse, ya da fiyat `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` seviyesine ulaşırsa.

Alım ve satım sinyalleri sadece yeni bir mum kapandığında üretilir. Zarar durdur ise her döngüde (`TICK_SECONDS`) kontrol edilir.

### Risk kuralları

- Her pozisyon `ORDER_QUOTE_AMOUNT` USDT'dir. Toplam en fazla `MAX_OPEN_POSITIONS × ORDER_QUOTE_AMOUNT` USDT risk alınır.
- Aynı anda birden çok coinde alım sinyali varsa, hacmi yüksek olana öncelik verilir.
- **Bot sadece kendi aldığı miktarı satar.** Hesabınızdaki diğer coinlere dokunmaz.
- Listeden düşen bir coinde açık pozisyon varsa, pozisyon kapanana kadar izlenmeye devam eder. O coinde yeni alım yapılmaz.
- `MAX_TRADES_PER_DAY` limiti yalnızca yeni alımları durdurur. Zarar durdur her zaman çalışır.

Pozisyonlar, analizler ve işlem geçmişi `data/state-<ortam>-portfolio.json` dosyasına yazılır. Bu sayede servis yeniden başlatıldığında açık pozisyonlar unutulmaz. Tek coinli eski sürümden kalan bir açık pozisyon varsa, servis açılışta uyarı verir. O pozisyonu yeni bot yönetmez.

`DRY_RUN=true` iken emirler simüle edilir. API anahtarı tanımlıysa emirler Binance'in `/order/test` ucuyla doğrulanır ama gerçekleşmez.

> Kâr garantisi yoktur. Komisyonlar paneldeki K/Z hesabına dahil değildir. Ayarları değiştirmeden önce mutlaka geçmiş testle (aşağıda) birden çok dönemde deneyin.

## API

`/health` dışındaki tüm uçlar `Authorization: Bearer <API_AUTH_TOKEN>` başlığı ister.

| Uç | Açıklama |
|---|---|
| `GET /health` | Servis ayakta mı |
| `GET /api/status` | Bot durumu, coin listesi, her coinin analizi, pozisyonlar, son işlemler, ayarlar (gizli bilgiler olmadan) |
| `GET /api/price?symbol=ETHUSDT` | Anlık fiyat |
| `GET /api/balance` | Sıfır olmayan bakiyeler |
| `GET /api/orders/open` | Açık emirler (tüm coinler; `?symbol=` ile tek coin) |
| `GET /api/klines?symbol=ETHUSDT` | Grafik verisi: kapanış, EMA20/50/200, Bollinger bantları, RSI |
| `POST /api/bot/start` | Botu başlat |
| `POST /api/bot/stop` | Botu durdur |
| `POST /api/bot/tick` | Tek bir döngüyü hemen çalıştır |
| `POST /api/universe/refresh` | Coin listesini hemen yenile |

Örnek:

```bash
curl -H "Authorization: Bearer $API_AUTH_TOKEN" http://127.0.0.1:8787/api/status
curl -X POST -H "Authorization: Bearer $API_AUTH_TOKEN" http://127.0.0.1:8787/api/bot/start
```

Sunucu varsayılan olarak yalnızca `127.0.0.1` adresini dinler. İnternete açmanız gerekirse önüne HTTPS'li bir reverse proxy (Caddy, nginx) ya da Cloudflare Tunnel koyun. Token'ı hiçbir zaman herkese açık bir sayfaya gömmeyin.

## Geçmiş test (backtest)

Bu araç, stratejiyi canlı botla aynı kurallarla geçmiş gerçek fiyatlar üzerinde çalıştırır. API anahtarı gerekmez.

```bash
npm run backtest                                         # .env ayarlarıyla, bugünkü ilk 10 coin, son 1 yıl
npm run backtest -- --from 2024-11-24 --to 2025-11-23    # başka bir dönem
npm run backtest -- --symbols BTCUSDT,ETHUSDT,SOLUSDT    # sabit coin listesi
npm run backtest -- --buy-score 4 --sl 5 --max-open 3    # farklı ayarlar
npm run backtest -- --sweep                              # ayar kombinasyonlarını karşılaştır
npm run backtest -- --trades                             # her işlemi tek tek listele
npm run backtest -- --help
```

Rapor şunları gösterir:
- Toplam kâr/zarar ve aynı coinleri eşit bölüp alıp tutsaydınız ne olacağı
- Coin bazında işlem sayısı, kâr/zarar ve al-tut getirisi
- Kazanma oranı, kâr faktörü ve en büyük düşüş
- Ödenen komisyon ve çıkış nedenleri

**Gerçekçilik varsayımları:**
- Emir, sinyalden sonraki mumun açılışında dolar.
- Göstergeler test döneminden önceki verilerle ısıtılır. Böylece EMA200 gibi uzun göstergeler ilk günden doğru hesaplanır.
- Varsayılan komisyon her işlemde %0,1, kayma %0,05.
- Zarar durdur ve kâr al, mum içindeki en düşük ve en yüksek fiyata göre kontrol edilir. Fiyat seviyenin ötesinde açılırsa (boşluk), emir açılış fiyatından dolar. Aynı mumda ikisi birden tetiklenirse kötümser varsayımla zarar durdur sayılır.

Veri `data-api.binance.vision` adresinden indirilir ve `data/history/` klasörüne önbelleklenir. Bu adrese erişiminiz yoksa https://data.binance.vision adresinden aylık CSV dosyalarını indirip `--csv BTCUSDT=dosya1.csv --csv ETHUSDT=dosya2.csv` ile verebilirsiniz.

> **Hayatta kalma yanlılığı:** Coin listesi bugünkü hacme göre seçilir. Bugün ilk 10'da olan coinler, çoğu zaman yakın geçmişte çok yükseldikleri için oradadır. Bu yüzden geçmiş test sonuçları gerçekte olacağından iyimser çıkar.

> **Dikkat:** `--sweep` sonucunda en iyi çıkan ayar, büyük olasılıkla o döneme "ezberlenmiştir" (aşırı uyum). Seçtiğiniz ayarı mutlaka başka bir dönemde de deneyin. Bir ayar ancak iki dönemde de iyi sonuç veriyorsa anlamlıdır. Geçmiş sonuçlar geleceği garanti etmez.

## Web paneli

Site üzerinde hazır bir panel var: **https://kverd123.github.io/panel/**

Panelde şunlar görünür:
- **Piyasa taraması:** izlenen her coin için fiyat, beş yöntemin oyu (▲ ▼ ●), toplam skor ve sinyal. Simgelerin üzerine gelince ayrıntı görünür.
- **Grafik:** taramada tıklanan coin için kapanış fiyatı, EMA20/50/200, Bollinger bandı, giriş fiyatı ve altta RSI
- Açık pozisyonlar ve anlık kâr/zarar, gerçekleşen kâr/zarar
- Bakiyeler, açık emirler ve işlem geçmişi
- Başlat / Durdur / Şimdi çalıştır / Coin listesini yenile düğmeleri

Veriler 10 saniyede bir yenilenir. Panel sizin backend'inize bağlanır; Binance'e doğrudan istek atmaz.

1. Backend'in `.env` dosyasında `ALLOWED_ORIGIN=https://kverd123.github.io` olsun.
2. Paneli açın, backend adresini (ör. `http://127.0.0.1:8787`) ve `API_AUTH_TOKEN` değerini girin.

Tarayıcı notları:
- Chrome, Edge ve Firefox, https bir sayfadan `http://127.0.0.1` adresine bağlanmaya izin verir.
- **Safari** buna izin vermeyebilir. Ayrıca backend başka bir makinede çalışıyorsa adresin **https** olması gerekir (Caddy veya Cloudflare Tunnel ile).

Token sayfaya gömülü değildir. Sadece sizin tarayıcınızda saklanır ve "hatırla" işaretlenmezse sekme kapanınca silinir.

## Sürekli çalıştırma

- **pm2:** `npx pm2 start src/index.js --name binance-bot`
- **systemd:** `WorkingDirectory=/yol/bot` ve `ExecStart=/usr/bin/node src/index.js` olan bir servis dosyası oluşturun. `AUTO_START=true` ayarını unutmayın.
- **cron (sunucusuz):** `npm run tick` tek bir döngü çalıştırıp çıkar. Örneğin `*/15 * * * *` ile kullanılabilir.

## Telegram bildirimi (opsiyonel)

1. @BotFather üzerinden bir bot oluşturun.
2. Bota bir mesaj atın ve sohbet kimliğinizi (chat id) öğrenin.
3. `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` değerlerini `.env` dosyasına yazın. Her alım ve satımda mesaj gelir.

## Dosyalar

```
src/binance.js   Binance REST istemcisi (HMAC imza, saat senkronu, borsa kuralları)
src/universe.js  Hacme göre ilk N coin seçimi ve filtreler
src/indicators.js EMA, RSI, MACD, Bollinger
src/analysis.js  Beş yöntemin oyları ve skor (bot ve backtest ortak kullanır)
src/strategy.js  Zarar durdur / kâr al
src/backtest.js  Geçmiş veri üzerinde çoklu coin portföy simülasyonu
src/history.js   Geçmiş mum verisini indirme / CSV okuma
src/bot.js       Karar döngüsü, risk kontrolleri, emir gönderme
src/server.js    Token korumalı HTTP API
src/store.js     Durumun diske yazılması
src/notify.js    Log ve Telegram
test/            Sahte Binance ile birim testleri (npm test)
```
