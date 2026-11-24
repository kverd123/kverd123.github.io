# Binance Botu ve Backend

Binance **Spot** hesabınıza bağlanan küçük bir Node.js servisi. İçinde iki parça var:

1. **Al-sat botu**: SMA kesişimi stratejisiyle çalışır, sadece long pozisyon açar. Zarar durdur, kâr al ve günlük işlem limiti vardır.
2. **HTTP API**: bakiye, fiyat, açık emirler ve bot durumu için uçlar sunar. Botu başlatıp durdurmak da buradan yapılır. Tüm uçlar token ile korunur.

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

Bot her `TICK_SECONDS` saniyede bir şu adımları izler:

1. `KLINE_INTERVAL` mumlarını çeker. Henüz kapanmamış son mum hesaba katılmaz.
2. Hızlı SMA (`SMA_FAST`) yavaş SMA'yı (`SMA_SLOW`) **yukarı keserse** ve açık pozisyon yoksa, `ORDER_QUOTE_AMOUNT` USDT'lik market alım yapar.
3. **Aşağı kesişimde**, ya da fiyat `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` seviyesine ulaşınca, pozisyonu market emirle satar.
4. **Sadece kendi aldığı miktarı satar.** Hesabınızdaki diğer coinlere dokunmaz.
5. `MAX_TRADES_PER_DAY` limiti yalnızca yeni alımları durdurur. Zarar durdur her zaman çalışır.

Pozisyon ve işlem geçmişi `data/` klasörüne yazılır. Bu sayede servis yeniden başlatıldığında açık pozisyon unutulmaz.

`DRY_RUN=true` iken emirler simüle edilir. API anahtarı tanımlıysa emirler Binance'in `/order/test` ucuyla doğrulanır ama gerçekleşmez.

> Bu basit bir örnek stratejidir ve kâr garantisi yoktur. Komisyonlar K/Z hesabına dahil değildir. Kendi stratejinizi `src/strategy.js` dosyasına yazabilirsiniz.

## API

`/health` dışındaki tüm uçlar `Authorization: Bearer <API_AUTH_TOKEN>` başlığı ister.

| Uç | Açıklama |
|---|---|
| `GET /health` | Servis ayakta mı |
| `GET /api/status` | Bot durumu, pozisyon, son işlemler, ayarlar (gizli bilgiler olmadan) |
| `GET /api/price?symbol=ETHUSDT` | Anlık fiyat |
| `GET /api/balance` | Sıfır olmayan bakiyeler |
| `GET /api/orders/open?symbol=BTCUSDT` | Açık emirler |
| `POST /api/bot/start` | Botu başlat |
| `POST /api/bot/stop` | Botu durdur |
| `POST /api/bot/tick` | Tek bir döngüyü hemen çalıştır |

Örnek:

```bash
curl -H "Authorization: Bearer $API_AUTH_TOKEN" http://127.0.0.1:8787/api/status
curl -X POST -H "Authorization: Bearer $API_AUTH_TOKEN" http://127.0.0.1:8787/api/bot/start
```

Sunucu varsayılan olarak yalnızca `127.0.0.1` adresini dinler. İnternete açmanız gerekirse önüne HTTPS'li bir reverse proxy (Caddy, nginx) ya da Cloudflare Tunnel koyun. Token'ı hiçbir zaman herkese açık bir sayfaya gömmeyin.

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
src/strategy.js  SMA kesişimi, zarar durdur / kâr al
src/bot.js       Karar döngüsü, risk kontrolleri, emir gönderme
src/server.js    Token korumalı HTTP API
src/store.js     Durumun diske yazılması
src/notify.js    Log ve Telegram
test/            Sahte Binance ile birim testleri (npm test)
```
