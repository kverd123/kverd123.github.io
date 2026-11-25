import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceClient, floorToStep } from '../src/binance.js';
import { exitCheck } from '../src/strategy.js';
import { loadConfig, publicConfig } from '../src/config.js';
import { JsonStore } from '../src/store.js';
import { TradingBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
import { mockBinance, fixedSignals, longSeries, silentLogger } from './mock.js';

test('HMAC imzası Binance dokümantasyonundaki örnekle aynı', () => {
  const c = new BinanceClient({
    baseUrl: 'https://x',
    apiSecret: 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
  });
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(c.sign(q), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('imzalı istek: timestamp, signature ve API key başlığı eklenir; anahtarsız reddedilir', async () => {
  const m = mockBinance();
  const c = new BinanceClient({ baseUrl: 'https://x', apiKey: 'k', apiSecret: 's', fetchImpl: m.fetch });
  await c.balances();
  const call = m.calls.at(-1);
  assert.equal(call.headers['X-MBX-APIKEY'], 'k');
  assert.ok(call.params.timestamp && call.params.signature);
  await assert.rejects(new BinanceClient({ baseUrl: 'https://x', fetchImpl: m.fetch }).balances(), /API_KEY/);
});

test('çoklu fiyat ve işlem kuralları tek istekte alınır', async () => {
  const m = mockBinance({ markets: { BTCUSDT: { price: 100 }, ETHUSDT: { price: 10 } } });
  const c = new BinanceClient({ baseUrl: 'https://x', fetchImpl: m.fetch });
  assert.deepEqual(await c.prices(['BTCUSDT', 'ETHUSDT']), { BTCUSDT: 100, ETHUSDT: 10 });
  const r = await c.rulesFor(['BTCUSDT', 'ETHUSDT']);
  assert.equal(r.ETHUSDT.baseAsset, 'ETH');
  assert.equal(r.BTCUSDT.minNotional, 5);
  await assert.rejects(c.rulesFor(['XXXUSDT']), /Invalid symbol/);
});

test('floorToStep aşağı yuvarlar', () => {
  assert.equal(floorToStep(0.123456789, '0.00001000'), '0.12345');
  assert.equal(floorToStep(1.9999, '1.00000000'), '1');
  assert.equal(floorToStep(0.3, '0.1'), '0.3');
});

test('zarar durdur / kâr al', () => {
  const pos = { entryPrice: 100 };
  assert.match(exitCheck(pos, 96, { stopLossPct: 3, takeProfitPct: 6 }), /zarar/);
  assert.match(exitCheck(pos, 107, { stopLossPct: 3, takeProfitPct: 6 }), /kâr/);
  assert.equal(exitCheck(pos, 101, { stopLossPct: 3, takeProfitPct: 6 }), null);
  assert.equal(exitCheck(pos, 50, { stopLossPct: 0, takeProfitPct: 0 }), null);
});

test('config: güvenli varsayılanlar, listeler ve gizli bilgilerin gizlenmesi', () => {
  const cfg = loadConfig({ BINANCE_API_KEY: 'a', BINANCE_API_SECRET: 'b', SYMBOLS: 'btcusdt, ethusdt', EXCLUDE_ASSETS: 'pepe' });
  assert.equal(cfg.binanceEnv, 'testnet');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.baseUrl, 'https://testnet.binance.vision');
  assert.deepEqual(cfg.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.ok(cfg.excludeAssets.includes('PEPE') && cfg.excludeAssets.includes('USDC'));
  assert.equal(cfg.topN, 10);
  const pub = publicConfig(cfg);
  assert.equal(pub.apiSecret, undefined);
  assert.equal(pub.hasApiKey, true);
  assert.throws(() => loadConfig({ DRY_RUN: 'false' }), /API_KEY/);
  assert.throws(() => loadConfig({ BINANCE_ENV: 'prod' }), /testnet/);
  assert.throws(() => loadConfig({ BUY_SCORE: '9' }), /BUY_SCORE/);
});

// ---- Portföy botu ----

const MARKETS = () => ({
  BTCUSDT: { price: 100, closes: longSeries(100), volume: 5000 },
  ETHUSDT: { price: 10, closes: longSeries(10), volume: 4000 },
  SOLUSDT: { price: 5, closes: longSeries(5), volume: 3000 },
});

function makeBot(m, { env = {}, signals = {} } = {}) {
  const config = loadConfig({ SYMBOLS: 'BTCUSDT,ETHUSDT,SOLUSDT', ...env });
  const client = new BinanceClient({ baseUrl: 'https://x', apiKey: config.apiKey, apiSecret: config.apiSecret, fetchImpl: m.fetch });
  return new TradingBot({ client, config, store: new JsonStore(null), logger: silentLogger, evaluate: fixedSignals(signals) });
}
// Yeni mum kapanmış gibi davran: bir sonraki döngüde tüm coinler yeniden analiz edilir.
const nextCandle = (bot) => { bot.state.analysis = {}; };

test('dry-run: alım sinyali olan coinleri alır, gerçek emir göndermez', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m, { signals: { BTCUSDT: 'BUY', SOLUSDT: 'BUY' } });
  const t = await bot.tick();
  assert.deepEqual(t.actions.sort(), ['BUY BTCUSDT', 'BUY SOLUSDT']);
  assert.equal(bot.state.positions.BTCUSDT.qty, 0.2);
  assert.equal(bot.state.positions.SOLUSDT.qty, 4);
  assert.equal(bot.state.positions.ETHUSDT, undefined);
  assert.equal(m.orders.length, 0, 'gerçek emir gönderilmemeli');
});

test('sinyal sadece yeni mumda işlenir; satış sinyali pozisyonu kapatır', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const signals = { BTCUSDT: 'BUY' };
  const bot = makeBot(m, { signals });
  await bot.tick();
  // aynı mum içinde: sinyal değişse bile işlem yok
  signals.BTCUSDT = 'SELL';
  assert.deepEqual((await bot.tick()).actions, []);
  // yeni mum: satış
  nextCandle(bot);
  m.markets.BTCUSDT.price = 110;
  assert.deepEqual((await bot.tick()).actions, ['SELL BTCUSDT']);
  assert.ok(Math.abs(bot.state.realizedPnl - 2) < 1e-9); // 0.2 × (110 − 100)
  assert.equal(bot.state.history[0].symbol, 'BTCUSDT');
});

test('zarar durdur her döngüde kontrol edilir (yeni mum beklenmez)', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m, { signals: { ETHUSDT: 'BUY' }, env: { STOP_LOSS_PCT: '5' } });
  await bot.tick();
  m.markets.ETHUSDT.price = 9.4;
  assert.deepEqual((await bot.tick()).actions, ['SELL ETHUSDT']);
  assert.match(bot.state.history[0].reason, /zarar durdur/);
});

test('aynı anda en fazla MAX_OPEN_POSITIONS pozisyon (liste sırasına göre öncelik)', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m, { signals: { BTCUSDT: 'BUY', ETHUSDT: 'BUY', SOLUSDT: 'BUY' }, env: { MAX_OPEN_POSITIONS: '2' } });
  await bot.tick();
  assert.deepEqual(Object.keys(bot.state.positions), ['BTCUSDT', 'ETHUSDT']);
});

test('günlük limit alımı durdurur ama satışı durdurmaz', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const signals = { BTCUSDT: 'BUY' };
  const bot = makeBot(m, { signals, env: { MAX_TRADES_PER_DAY: '1', STOP_LOSS_PCT: '5' } });
  await bot.tick();
  signals.ETHUSDT = 'BUY';
  nextCandle(bot);
  m.markets.BTCUSDT.price = 90; // zarar durdur
  const t = await bot.tick();
  assert.deepEqual(t.actions, ['SELL BTCUSDT']);
  assert.equal(bot.state.positions.ETHUSDT, undefined);
});

test('canlı mod: market emri gönderir ve sadece kendi aldığı miktarı satar', async () => {
  const m = mockBinance({ markets: MARKETS(), balances: { USDT: 1000, BTC: 5 } });
  const signals = { BTCUSDT: 'BUY' };
  const bot = makeBot(m, { signals, env: { DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' } });
  await bot.tick();
  assert.equal(m.orders[0].type, 'MARKET');
  assert.equal(m.orders[0].quoteOrderQty, '20.00000000');
  signals.BTCUSDT = 'SELL';
  nextCandle(bot);
  await bot.tick();
  assert.equal(m.orders[1].side, 'SELL');
  assert.equal(m.orders[1].quantity, '0.20000');
  assert.equal(m.balances.BTC, 5, 'önceden var olan BTC bakiyesine dokunulmamalı');
});

test('bir coindeki hata diğerlerini durdurmaz', async () => {
  const markets = MARKETS();
  markets.ETHUSDT.closes = [10, 10]; // yetersiz geçmiş
  const m = mockBinance({ markets });
  const bot = makeBot(m, { signals: { BTCUSDT: 'BUY', ETHUSDT: 'BUY' } });
  const t = await bot.tick();
  assert.deepEqual(t.actions, ['BUY BTCUSDT']);
  assert.match(bot.symbolErrors.ETHUSDT.message, /yetersiz/);
});

test('otomatik coin listesi: hacme göre sıralar, stablecoin ve yeni listelenenleri eler', async () => {
  const markets = {
    ...MARKETS(),
    USDCUSDT: { price: 1, high: 1.001, low: 0.999, volume: 99999, closes: longSeries(1) },
    NEWUSDT: { price: 3, volume: 8000, closes: longSeries(3), listedAt: Date.now() - 30 * 86400e3 },
    DOGEUSDT: { price: 0.2, volume: 100, closes: longSeries(0.2) },
  };
  const m = mockBinance({ markets });
  const config = loadConfig({ TOP_N: '3' });
  const client = new BinanceClient({ baseUrl: 'https://x', fetchImpl: m.fetch });
  const bot = new TradingBot({ client, config, store: new JsonStore(null), logger: silentLogger, evaluate: fixedSignals({}) });
  await bot.init();
  assert.deepEqual(bot.state.universe.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(bot.state.universe.skipped[0].symbol, 'NEWUSDT');
});

test('listeden düşen coinin açık pozisyonu yönetilmeye devam eder', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const signals = { SOLUSDT: 'BUY' };
  const bot = makeBot(m, { signals });
  await bot.tick();
  bot.cfg.symbols = ['BTCUSDT', 'ETHUSDT'];
  await bot.refreshUniverse(true);
  assert.deepEqual(bot.watched().sort(), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  signals.SOLUSDT = 'SELL';
  nextCandle(bot);
  assert.deepEqual((await bot.tick()).actions, ['SELL SOLUSDT']);
  // listede olmayan coinde yeni alım yapılmaz, coin izlemeden çıkar
  assert.deepEqual(bot.watched().sort(), ['BTCUSDT', 'ETHUSDT']);
});

// ---- API sunucusu ----

async function withServer(bot, extra, fn) {
  const token = 'x'.repeat(32);
  const config = { ...bot.cfg, authToken: token, ...extra };
  const server = createServer({ bot, client: bot.client, config, logger: silentLogger });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { headers: { authorization: `Bearer ${token}` } });
  try {
    await fn(base, get);
  } finally {
    server.close();
  }
}

test('API: token olmadan 401, durum ve gizli bilgiler', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m, { signals: { BTCUSDT: 'BUY' } });
  await bot.tick();
  await withServer(bot, {}, async (base, get) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer yanlis' } })).status, 401);
    const s = await (await get('/api/status')).json();
    assert.equal(s.config.authToken, undefined);
    assert.deepEqual(s.bot.universe.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    assert.ok(s.bot.positions.BTCUSDT);
    assert.equal(s.bot.analysis.BTCUSDT.signal, 'BUY');
    assert.equal(s.bot.listingCache, undefined);
    assert.deepEqual(await (await get('/api/price?symbol=ETHUSDT')).json(), { symbol: 'ETHUSDT', price: 10 });
    assert.equal((await get('/api/price?symbol=../x')).status, 400);
  });
  assert.throws(() => createServer({ bot, client: bot.client, config: { ...bot.cfg, authToken: '' }, logger: silentLogger }));
});

test('API: CORS ön kontrolü ve grafik verisi', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m);
  await withServer(bot, { allowedOrigin: 'https://kverd123.github.io' }, async (base, get) => {
    const pre = await fetch(`${base}/api/status`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://kverd123.github.io');
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');

    const k = await (await get('/api/klines?symbol=ETHUSDT')).json();
    assert.equal(k.symbol, 'ETHUSDT');
    assert.equal(k.candles.length, 150);
    const last = k.candles.at(-1);
    assert.ok(last.ema200 > 0 && last.bbU > last.bbL && last.rsi > 50);
  });
});

// ---- Kod incelemesi bulguları (Codex, PR #1) ----

test('her işlem, döngünün geri kalanı beklenmeden hemen diske yazılır', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const config = loadConfig({ SYMBOLS: 'BTCUSDT,ETHUSDT' });
  const client = new BinanceClient({ baseUrl: 'https://x', fetchImpl: m.fetch });
  const store = new JsonStore(null);
  let saved = null;
  store.save = () => { saved = JSON.parse(JSON.stringify(store.state)); };
  let savedAtNotify = null;
  const notify = async () => { savedAtNotify = saved; };
  const bot = new TradingBot({ client, config, store, notify, logger: silentLogger, evaluate: fixedSignals({ BTCUSDT: 'BUY' }) });
  await bot.tick();
  assert.ok(savedAtNotify?.positions.BTCUSDT, 'bildirimden önce pozisyon kaydedilmiş olmalı');
  assert.equal(savedAtNotify.history[0].side, 'BUY');
});

test('DRY-RUN pozisyonu gerçek modda satılmaz (ve tersi)', async () => {
  const m = mockBinance({ markets: MARKETS(), balances: { USDT: 1000, BTC: 5 } });
  const signals = { BTCUSDT: 'SELL' };
  const bot = makeBot(m, { signals, env: { DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' } });
  bot.state.positions.BTCUSDT = { qty: 1, entryPrice: 100, cost: 100, openedAt: 0, dryRun: true };
  const t = await bot.tick();
  assert.deepEqual(t.actions, []);
  assert.equal(m.orders.length, 0, 'gerçek emir gönderilmemeli');
  assert.equal(m.balances.BTC, 5);
  assert.ok(bot.state.positions.BTCUSDT, 'pozisyon silinmemeli');
  assert.match(bot.symbolErrors.BTCUSDT.message, /DRY-RUN/);
});

test('satılamayan pozisyon silinmez, sonra satılır; kısmi satışta kalan izlenir', async () => {
  const m = mockBinance({ markets: MARKETS(), balances: { USDT: 1000 } });
  const signals = { BTCUSDT: 'BUY' };
  const bot = makeBot(m, { signals, env: { DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' } });
  await bot.tick(); // 0.2 BTC alındı
  // coin başka bir emirde kilitli: serbest bakiye 0
  m.balances.BTC = 0;
  signals.BTCUSDT = 'SELL';
  nextCandle(bot);
  assert.deepEqual((await bot.tick()).actions, []);
  assert.equal(bot.state.positions.BTCUSDT.qty, 0.2);
  assert.match(bot.state.positions.BTCUSDT.blocked.reason, /minimumunun altında/);
  // kısmi serbest: 0.12 satılır, 0.08 (8 USDT ≥ min 5) izlenmeye devam eder
  m.balances.BTC = 0.12;
  nextCandle(bot);
  assert.deepEqual((await bot.tick()).actions, ['SELL BTCUSDT']);
  assert.ok(Math.abs(bot.state.positions.BTCUSDT.qty - 0.08) < 1e-12);
  // kilit kalktı: kalan satılır, pozisyon kapanır
  m.balances.BTC = 0.08;
  nextCandle(bot);
  assert.deepEqual((await bot.tick()).actions, ['SELL BTCUSDT']);
  assert.equal(bot.state.positions.BTCUSDT, undefined);
});

// ---- ANALYSIS_MINUTES: mum kapanmadan analiz ----

test('ANALYSIS_MINUTES: oluşan mum anlık fiyatla dahil edilir, N dakikada bir yenilenir', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const config = loadConfig({ SYMBOLS: 'BTCUSDT', ANALYSIS_MINUTES: '30' });
  const client = new BinanceClient({ baseUrl: 'https://x', fetchImpl: m.fetch });
  const calls = [];
  const evaluate = (series, i) => {
    calls.push({ len: series.closes.length, last: series.closes[i] });
    return { score: 4, signal: calls.length === 1 ? 'HOLD' : 'BUY', ready: true, methods: [] };
  };
  const bot = new TradingBot({ client, config, store: new JsonStore(null), logger: silentLogger, evaluate });
  m.markets.BTCUSDT.price = 123;
  await bot.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].len, MARKETS().BTCUSDT.closes.length + 1, 'kapanmış mumlar + oluşan mum');
  assert.equal(calls[0].last, 123, 'oluşan mumun kapanışı anlık fiyat');
  assert.equal(bot.state.analysis.BTCUSDT.partial, true);
  assert.ok(bot.state.analysis.BTCUSDT.nextAnalysisAt % (30 * 60e3) === 0);
  // süre dolmadan yeniden analiz yok
  await bot.tick();
  assert.equal(calls.length, 1);
  // 30 dakika geçti: yeniden analiz, sinyal hemen uygulanır (mum kapanışı beklenmez)
  bot.state.analysis.BTCUSDT.nextAnalysisAt = 0;
  assert.deepEqual((await bot.tick()).actions, ['BUY BTCUSDT']);
  assert.equal(calls.length, 2);
});

test('ANALYSIS_MINUTES=0 (varsayılan): sadece kapanmış mumlar kullanılır', async () => {
  const m = mockBinance({ markets: MARKETS() });
  const bot = makeBot(m);
  let len = 0;
  bot.evaluate = (series) => { len = series.closes.length; return { score: 0, signal: 'HOLD', ready: true, methods: [] }; };
  await bot.tick();
  assert.equal(len, MARKETS().BTCUSDT.closes.length);
  assert.equal(bot.state.analysis.BTCUSDT.partial, false);
  assert.throws(() => loadConfig({ ANALYSIS_MINUTES: '0.5' }), /ANALYSIS_MINUTES/);
});
