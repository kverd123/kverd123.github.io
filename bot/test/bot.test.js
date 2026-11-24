import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceClient, floorToStep } from '../src/binance.js';
import { sma, smaCrossSignal, exitCheck } from '../src/strategy.js';
import { loadConfig, publicConfig } from '../src/config.js';
import { JsonStore } from '../src/store.js';
import { TradingBot } from '../src/bot.js';
import { createServer } from '../src/server.js';
import { mockBinance, silentLogger } from './mock.js';

test('HMAC imzası Binance dokümantasyonundaki örnekle aynı', () => {
  const c = new BinanceClient({
    baseUrl: 'https://x',
    apiSecret: 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
  });
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(c.sign(q), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('imzalı istek: timestamp, signature ve API key başlığı eklenir', async () => {
  const m = mockBinance();
  const c = new BinanceClient({ baseUrl: 'https://x', apiKey: 'k', apiSecret: 's', fetchImpl: m.fetch });
  await c.balances();
  const call = m.calls.at(-1);
  assert.equal(call.headers['X-MBX-APIKEY'], 'k');
  assert.ok(call.params.timestamp && call.params.signature);
});

test('imzalı istek anahtarsız reddedilir', async () => {
  const c = new BinanceClient({ baseUrl: 'https://x', fetchImpl: mockBinance().fetch });
  await assert.rejects(c.balances(), /API_KEY/);
});

test('floorToStep aşağı yuvarlar', () => {
  assert.equal(floorToStep(0.123456789, '0.00001000'), '0.12345');
  assert.equal(floorToStep(1.9999, '1.00000000'), '1');
  assert.equal(floorToStep(0.3, '0.1'), '0.3');
});

test('SMA ve kesişim sinyalleri', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(smaCrossSignal([5, 5, 5, 5, 5, 10], 2, 4).signal, 'BUY');
  assert.equal(smaCrossSignal([5, 5, 5, 5, 5, 1], 2, 4).signal, 'SELL');
  assert.equal(smaCrossSignal([5, 5, 5, 5, 5, 5], 2, 4).signal, 'HOLD');
  assert.equal(smaCrossSignal([1, 2], 2, 4).signal, 'HOLD');
});

test('zarar durdur / kâr al', () => {
  const pos = { entryPrice: 100 };
  assert.match(exitCheck(pos, 96, { stopLossPct: 3, takeProfitPct: 6 }), /zarar/);
  assert.match(exitCheck(pos, 107, { stopLossPct: 3, takeProfitPct: 6 }), /kâr/);
  assert.equal(exitCheck(pos, 101, { stopLossPct: 3, takeProfitPct: 6 }), null);
});

test('config: güvenli varsayılanlar ve gizli bilgilerin gizlenmesi', () => {
  const cfg = loadConfig({ BINANCE_API_KEY: 'a', BINANCE_API_SECRET: 'b' });
  assert.equal(cfg.binanceEnv, 'testnet');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.baseUrl, 'https://testnet.binance.vision');
  const pub = publicConfig(cfg);
  assert.equal(pub.apiSecret, undefined);
  assert.equal(pub.hasApiKey, true);
  assert.throws(() => loadConfig({ DRY_RUN: 'false' }), /API_KEY/);
  assert.throws(() => loadConfig({ BINANCE_ENV: 'prod' }), /testnet/);
});

function makeBot(m, overrides = {}) {
  const config = { ...loadConfig({ SMA_FAST: '2', SMA_SLOW: '4', ...overrides.env }), ...overrides.cfg };
  const client = new BinanceClient({ baseUrl: 'https://x', apiKey: config.apiKey, apiSecret: config.apiSecret, fetchImpl: m.fetch });
  return new TradingBot({ client, config, store: new JsonStore(null), logger: silentLogger });
}

test('dry-run: yukarı kesişimde alır, aşağı kesişimde satar, gerçek emir göndermez', async () => {
  const m = mockBinance({ closes: [5, 5, 5, 5, 5, 10], price: 10 });
  const bot = makeBot(m);
  assert.equal((await bot.tick()).action, 'BUY');
  assert.equal(bot.state.position.qty, 2);

  m.closes = [10, 10, 10, 10, 10, 1];
  m.price = 12;
  assert.equal((await bot.tick()).action, 'SELL');
  assert.equal(bot.state.position, null);
  assert.equal(bot.state.realizedPnl, 4);
  assert.ok(!m.calls.some((c) => c.path === '/api/v3/order'), 'gerçek emir gönderilmemeli');
});

test('canlı mod: market emri gönderir ve sadece kendi aldığı miktarı satar', async () => {
  const m = mockBinance({ closes: [5, 5, 5, 5, 5, 10], price: 10, balances: { USDT: 1000, BTC: 5 } });
  const bot = makeBot(m, { env: { DRY_RUN: 'false', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' } });
  await bot.tick();
  const buy = m.calls.find((c) => c.path === '/api/v3/order' && c.params.side === 'BUY');
  assert.equal(buy.params.type, 'MARKET');
  assert.equal(buy.params.quoteOrderQty, '20.00000000');

  m.closes = [10, 10, 10, 10, 10, 1];
  await bot.tick();
  const sell = m.calls.find((c) => c.path === '/api/v3/order' && c.params.side === 'SELL');
  assert.equal(sell.params.quantity, '2.00000');
  assert.equal(m.balances.BTC, 5, 'önceden var olan BTC bakiyesine dokunulmamalı');
});

test('zarar durdur, sinyal olmasa da satar; günlük limit satışı engellemez', async () => {
  const m = mockBinance({ closes: [5, 5, 5, 5, 5, 10], price: 10 });
  const bot = makeBot(m, { env: { MAX_TRADES_PER_DAY: '1' } });
  await bot.tick();
  m.closes = [10, 10, 10, 10, 10, 10];
  m.price = 9; // -10%
  assert.equal((await bot.tick()).action, 'SELL');
  assert.match(bot.state.history[0].reason, /zarar/);
});

test('günlük limit dolunca yeni alım yapılmaz', async () => {
  const m = mockBinance({ closes: [5, 5, 5, 5, 5, 10], price: 10 });
  const bot = makeBot(m, { env: { MAX_TRADES_PER_DAY: '0' } });
  assert.equal((await bot.tick()).action, 'HOLD');
});

test('API sunucusu: token olmadan 401, token ile 200', async () => {
  const m = mockBinance({ price: 42 });
  const bot = makeBot(m);
  const config = { ...bot.cfg, authToken: 'x'.repeat(32) };
  const server = createServer({ bot, client: bot.client, config, logger: silentLogger });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer yanlis' } })).status, 401);
    const r = await fetch(`${base}/api/price`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } });
    assert.deepEqual(await r.json(), { symbol: 'BTCUSDT', price: 42 });
    const s = await (await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).json();
    assert.equal(s.config.authToken, undefined);
  } finally {
    server.close();
  }
  assert.throws(() => createServer({ bot, client: bot.client, config: { ...config, authToken: '' }, logger: silentLogger }));
});
