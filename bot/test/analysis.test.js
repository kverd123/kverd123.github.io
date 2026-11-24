import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries } from '../src/indicators.js';
import { computeSeries, evaluateAt, INDICATORS } from '../src/analysis.js';
import { rankCandidates, looksStable } from '../src/universe.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('SMA ve EMA', () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = emaSeries([1, 2, 3, 4, 5], 3); // ilk değer SMA(1,2,3)=2, k=0.5
  assert.deepEqual(e, [null, null, 2, 3, 4]);
  // baştaki null değerler atlanır
  assert.deepEqual(emaSeries([null, null, 2, 2, 2], 2), [null, null, null, 2, 2]);
});

test('RSI: sadece yükseliş 100, eşit iniş-çıkış 50', () => {
  assert.equal(rsiSeries([1, 2, 3, 4, 5, 6], 3).at(-1), 100);
  const zigzag = [10, 11, 10, 11, 10, 11, 10];
  close(rsiSeries(zigzag, 2)[2], 50);
  assert.equal(rsiSeries([5, 5, 5, 5], 2).at(-1), 50);
});

test('MACD ve Bollinger: sabit fiyatta sıfır / dar bant', () => {
  const flat = new Array(60).fill(7);
  const m = macdSeries(flat);
  assert.equal(m.hist.at(-1), 0);
  assert.equal(m.hist[30], null); // 26 + 9 − 1 = 34. mumdan önce hazır değil
  const bb = bollingerSeries(flat, 20, 2);
  assert.equal(bb.upper.at(-1), 7);
  assert.equal(bb.lower.at(-1), 7);
  const bb2 = bollingerSeries([1, 3], 2, 1); // ort 2, std 1
  assert.equal(bb2.upper[1], 3);
  assert.equal(bb2.lower[1], 1);
});

// Gösterge değerlerini doğrudan veren sahte seri
function fakeSeries({ c, ema200, ef, es, rsi, h, hPrev, up, lo }) {
  return {
    closes: [c, c], ema200: [ema200, ema200], emaFast: [ef, ef], emaSlow: [es, es], rsi: [rsi, rsi],
    macd: { hist: [hPrev, h] }, bb: { upper: [up, up], lower: [lo, lo] },
  };
}

test('beş yöntemin oyları ve toplam skor', () => {
  // hepsi al yönlü: trend↑, EMA↑, MACD pozitif & artıyor, RSI < 30, alt bandın altında
  const bull = evaluateAt(fakeSeries({ c: 90, ema200: 80, ef: 95, es: 85, rsi: 25, h: 2, hPrev: 1, up: 120, lo: 95 }), 1);
  assert.deepEqual(bull.methods.map((x) => x.vote), [1, 1, 1, 1, 1]);
  assert.equal(bull.score, 5);
  assert.equal(bull.signal, 'BUY');

  const bear = evaluateAt(fakeSeries({ c: 130, ema200: 140, ef: 100, es: 110, rsi: 80, h: -2, hPrev: -1, up: 120, lo: 95 }), 1);
  assert.deepEqual(bear.methods.map((x) => x.vote), [-1, -1, -1, -1, -1]);
  assert.equal(bear.signal, 'SELL');

  // MACD pozitif ama azalıyor -> 0; RSI nötr -> 0; bant içi -> 0
  const mixed = evaluateAt(fakeSeries({ c: 100, ema200: 90, ef: 101, es: 99, rsi: 50, h: 1, hPrev: 2, up: 110, lo: 90 }), 1);
  assert.deepEqual(mixed.methods.map((x) => x.vote), [1, 1, 0, 0, 0]);
  assert.equal(mixed.signal, 'HOLD');
  assert.equal(evaluateAt(fakeSeries({ c: 100, ema200: 90, ef: 101, es: 99, rsi: 50, h: 1, hPrev: 2, up: 110, lo: 90 }), 1, { buyScore: 2 }).signal, 'BUY');
});

test('trend şartı: EMA200 altında skor yüksek olsa da alım yok (kapatılabilir)', () => {
  const s = fakeSeries({ c: 90, ema200: 100, ef: 95, es: 85, rsi: 25, h: 2, hPrev: 1, up: 120, lo: 95 });
  const a = evaluateAt(s, 1);
  assert.equal(a.score, 3);
  assert.equal(a.signal, 'HOLD');
  assert.equal(evaluateAt(s, 1, { requireTrend: false }).signal, 'BUY');
});

test('yetersiz veride HOLD; gerçek seride hesaplanır', () => {
  const short = Array.from({ length: 50 }, (_, i) => ({ close: 100 + i }));
  assert.equal(evaluateAt(computeSeries(short), 49).ready, false);
  const long = Array.from({ length: INDICATORS.trendEma + 60 }, (_, i) => ({ close: 100 + Math.sin(i / 5) * 5 + i * 0.1 }));
  const a = evaluateAt(computeSeries(long), long.length - 1);
  assert.equal(a.ready, true);
  assert.equal(a.methods.length, 5);
  assert.ok(a.methods.every((m) => typeof m.detail === 'string'));
});

test('coin adayları: USDT, işlemde, hariç listesi ve stablecoin filtresi', () => {
  const sym = (symbol, baseAsset, extra = {}) => ({ symbol, baseAsset, quoteAsset: 'USDT', status: 'TRADING', ...extra });
  const tick = (symbol, quoteVolume, lastPrice = 10, highPrice = 11, lowPrice = 9) => ({ symbol, quoteVolume, lastPrice, highPrice, lowPrice });
  const symbols = [
    sym('BTCUSDT', 'BTC'), sym('ETHUSDT', 'ETH'), sym('USDCUSDT', 'USDC'), sym('NEWSTABLEUSDT', 'NEWSTABLE'),
    sym('OLDUSDT', 'OLD', { status: 'BREAK' }), { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
  ];
  const tickers = [
    tick('ETHUSDT', 500), tick('BTCUSDT', 900), tick('USDCUSDT', 9999, 1, 1.001, 0.999),
    tick('NEWSTABLEUSDT', 8000, 1.0001, 1.002, 0.999), tick('OLDUSDT', 7000), tick('ETHBTC', 6000),
  ];
  assert.deepEqual(rankCandidates(tickers, symbols).map((c) => c.symbol), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(looksStable({ lastPrice: '1.0002', highPrice: '1.001', lowPrice: '0.999' }), true);
  assert.equal(looksStable({ lastPrice: '1.01', highPrice: '1.10', lowPrice: '0.95' }), false);
});
