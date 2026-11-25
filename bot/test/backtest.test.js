import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBacktest } from '../src/backtest.js';
import { fetchHistory, loadCsv } from '../src/history.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 0, 1);

// Kapanış dizisinden saatlik mumlar üretir. Açılış = önceki kapanış (aksi verilmedikçe).
function candles(closes, { opens = {}, highs = {}, lows = {}, t0 = T0 } = {}) {
  return closes.map((c, i) => {
    const o = opens[i] ?? (i ? closes[i - 1] : c);
    return {
      openTime: t0 + i * H, closeTime: t0 + (i + 1) * H - 1, open: o, close: c,
      high: highs[i] ?? Math.max(o, c), low: lows[i] ?? Math.min(o, c), volume: 1,
    };
  });
}

// Sinyalleri doğrudan veren değerlendirici: { SYMBOL: { mumIndeksi: 'BUY' | 'SELL' } }
const signalsAt = (map) => (_s, i, _o, symbol) => ({ signal: map[symbol]?.[i] ?? 'HOLD', score: 0, methods: [] });

//               0   1   2   3   4   5   6   7   8  9 10
const UP_DOWN = [10, 10, 10, 10, 10, 20, 20, 20, 20, 5, 5];
// mum 5 kapanışında AL -> mum 6 açılışında (20) alır; mum 9 kapanışında SAT -> mum 10 açılışında (5) satar
const SIG = { A: { 5: 'BUY', 9: 'SELL' } };
const base = { orderQuoteAmount: 100, feePct: 0, slippagePct: 0, evaluate: signalsAt(SIG) };

test('emir sinyalden sonraki mumun açılışında dolar', () => {
  const r = runBacktest({ A: candles(UP_DOWN) }, base);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.symbol, 'A');
  assert.equal(t.entryAt, T0 + 6 * H);
  assert.equal(t.entryPrice, 20);
  assert.equal(t.exitAt, T0 + 10 * H);
  assert.equal(t.exitPrice, 5);
  assert.equal(t.reason, 'analiz');
  assert.equal(t.pnl, -75); // 100/20 = 5 adet, 5 × 5 = 25
});

test('zarar durdur mum içi en düşük fiyatla tetiklenir ve seviyeden dolar', () => {
  const r = runBacktest({ A: candles(UP_DOWN, { lows: { 7: 17 } }) }, { ...base, stopLossPct: 10 });
  assert.equal(r.trades[0].reason, 'zarar durdur');
  assert.equal(r.trades[0].exitPrice, 18);
  assert.equal(r.trades[0].pnl, -10);
});

test('fiyat zarar durdurun altında açılırsa (boşluk) açılıştan dolar', () => {
  const r = runBacktest({ A: candles(UP_DOWN, { opens: { 7: 15 } }) }, { ...base, stopLossPct: 10 });
  assert.equal(r.trades[0].exitPrice, 15);
  assert.equal(r.trades[0].pnl, -25);
});

test('kâr al; aynı mumda ikisi birden olursa zarar durdur sayılır', () => {
  const tp = runBacktest({ A: candles(UP_DOWN, { highs: { 7: 25 } }) }, { ...base, takeProfitPct: 10 });
  assert.equal(tp.trades[0].reason, 'kâr al');
  assert.equal(tp.trades[0].exitPrice, 22);
  assert.ok(Math.abs(tp.trades[0].pnl - 10) < 1e-9);
  const both = runBacktest({ A: candles(UP_DOWN, { highs: { 7: 25 }, lows: { 7: 17 } }) }, { ...base, stopLossPct: 10, takeProfitPct: 10 });
  assert.equal(both.trades[0].reason, 'zarar durdur');
});

test('komisyon ve kayma sonuca yansır', () => {
  const r = runBacktest({ A: candles(UP_DOWN) }, { ...base, feePct: 0.1, slippagePct: 0.05 });
  const entry = 20 * 1.0005;
  const qty = (100 * 0.999) / entry;
  const gross = qty * 5 * 0.9995;
  assert.ok(Math.abs(r.summary.totalPnl - (gross * 0.999 - 100)) < 1e-9);
  assert.ok(Math.abs(r.summary.feesPaid - (0.1 + gross * 0.001)) < 1e-9);
});

test('dönem sonunda açık pozisyon kapatılır, özet doğru', () => {
  const r = runBacktest({ A: candles([10, 10, 10, 10, 10, 20, 20, 30]) }, { ...base, maxOpenPositions: 1 });
  assert.equal(r.trades[0].reason, 'dönem sonu');
  assert.equal(r.summary.totalPnl, 50); // 5 adet × 30 − 100
  assert.equal(r.summary.wins, 1);
  assert.equal(r.summary.capital, 100);
  assert.equal(r.summary.returnPct, 50);
  assert.equal(r.summary.buyHoldPct, 200);
  assert.equal(r.equity.at(-1).v, 50);
});

test('günlük işlem limiti alımı engeller', () => {
  const r = runBacktest({ A: candles(UP_DOWN) }, { ...base, maxTradesPerDay: 0 });
  assert.equal(r.trades.length, 0);
});

test('portföy: pozisyon limiti, öncelik sırası ve coin bazında sonuçlar', () => {
  const data = { A: candles(UP_DOWN), B: candles(UP_DOWN.map((x) => x * 2)), C: candles(UP_DOWN) };
  const evaluate = signalsAt({ A: { 5: 'BUY', 9: 'SELL' }, B: { 5: 'BUY', 9: 'SELL' }, C: { 5: 'BUY', 9: 'SELL' } });
  const r = runBacktest(data, { ...base, evaluate, maxOpenPositions: 2 });
  assert.deepEqual(r.trades.map((t) => t.symbol).sort(), ['A', 'B']); // C limite takıldı
  assert.equal(r.summary.maxConcurrent, 2);
  assert.equal(r.summary.capital, 200);
  assert.deepEqual(r.summary.perSymbol.map((p) => [p.symbol, p.trades]), [['A', 1], ['B', 1], ['C', 0]]);
  assert.equal(r.summary.totalPnl, -150);
});

test('ısınma dönemi: tradeFrom öncesinde işlem yapılmaz ama göstergeler o veriyi görür', () => {
  let seenLength = 0;
  const evaluate = (s, i) => { seenLength = s.closes.length; return { signal: i === 5 ? 'BUY' : 'HOLD' }; };
  const r = runBacktest({ A: candles(UP_DOWN) }, { ...base, evaluate, tradeFrom: T0 + 7 * H });
  assert.equal(r.trades.length, 0); // sinyal ısınma döneminde kaldı
  assert.equal(seenLength, UP_DOWN.length);
  assert.equal(r.summary.candles, UP_DOWN.length - 7);
  assert.equal(r.summary.buyHoldPct, ((5 - 20) / 20) * 100); // test dönemi açılışından
});

test('en büyük düşüş zirveden hesaplanır', () => {
  const c = [10, 10, 10, 10, 10, 20, 20, 30, 30, 5, 5, 5, 5];
  const r = runBacktest({ A: candles(c) }, { ...base, evaluate: signalsAt({ A: { 5: 'BUY', 9: 'SELL' } }) });
  const peak = Math.max(...r.equity.map((p) => p.v));
  assert.equal(peak, 50);
  assert.equal(r.summary.maxDrawdown, 50 - -75);
});

test('fetchHistory 1000’lik sayfalarla indirir', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const start = Number(u.searchParams.get('startTime'));
    const end = Number(u.searchParams.get('endTime'));
    const rows = [];
    for (let t = start; t <= end && rows.length < 1000; t += H) rows.push([t, '1', '2', '0.5', '1.5', '10', t + H - 1]);
    return { ok: true, json: async () => rows };
  };
  const out = await fetchHistory({ symbol: 'BTCUSDT', interval: '1h', startTime: T0, endTime: T0 + 2500 * H, fetchImpl: fakeFetch });
  assert.equal(out.length, 2500);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].searchParams.get('startTime'), String(T0 + 1000 * H));
  assert.equal(calls[0].origin, 'https://data-api.binance.vision');
});

test('CSV: başlık, mikrosaniye zaman damgası ve tekrarlar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const f = path.join(dir, 'a.csv');
  const us = (ms) => String(ms * 1000);
  fs.writeFileSync(f, [
    'open_time,open,high,low,close,volume,close_time,qv,n,tb,tq,ignore',
    `${us(T0 + H)},2,2,2,2,1,${us(T0 + 2 * H - 1)},0,0,0,0,0`,
    `${T0},1,1,1,1,1,${T0 + H - 1},0,0,0,0,0`,
    `${T0},1,1,1,1,1,${T0 + H - 1},0,0,0,0,0`,
    '',
  ].join('\n'));
  const out = loadCsv(f);
  assert.equal(out.length, 2);
  assert.equal(out[0].openTime, T0);
  assert.equal(out[1].openTime, T0 + H);
  assert.equal(out[1].close, 2);
});

// ---- Short (vadeli işlem simülasyonu) ----

// mum 5 kapanışında short sinyali (skor -4) -> mum 6 açılışında (20) short; mum 9'da kapat (skor +3) -> mum 10 açılışında (5)
const DOWN = [20, 20, 20, 20, 20, 20, 20, 15, 10, 5, 5];
const scoreAt = (map) => (_s, i, _o, symbol) => {
  const score = map[symbol]?.[i] ?? 0;
  return { score, signal: 'HOLD', methods: [{ key: 'trend', vote: score < 0 ? -1 : 1 }] };
};

test('short: düşüşte kazanır, komisyon ve kayma aleyhe uygulanır', () => {
  const evaluate = scoreAt({ A: { 5: -4, 9: 3 } });
  const r = runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'short' });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.side, 'short');
  assert.equal(t.entryPrice, 20);
  assert.equal(t.exitPrice, 5);
  assert.equal(t.pnl, 75); // 5 adet × (20 − 5)
  const f = runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'short', feePct: 0.05, slippagePct: 0.05 });
  const entry = 20 * 0.9995, qty = (100 * 0.9995) / entry, exit = 5 * 1.0005;
  assert.ok(Math.abs(f.trades[0].pnl - (qty * (entry - exit) - 0.05 - qty * exit * 0.0005)) < 1e-9);
  assert.equal(r.summary.bySide.short.trades, 1);
});

test('short: long modunda short açılmaz, both modunda açılır', () => {
  const evaluate = scoreAt({ A: { 5: -4 } });
  assert.equal(runBacktest({ A: candles(DOWN) }, { ...base, evaluate }).trades.length, 0);
  assert.equal(runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'both' }).trades[0].side, 'short');
});

test('short: trend şartı (fiyat EMA200 üstündeyse short yok)', () => {
  const evaluate = () => ({ score: -4, signal: 'HOLD', methods: [{ key: 'trend', vote: 1 }] });
  assert.equal(runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'short' }).trades.length, 0);
  assert.ok(runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'short', requireTrend: false }).trades.length > 0);
});

test('short: zarar durdur yükselişte tetiklenir; boşlukta tasfiye ve kayıp teminatla sınırlı', () => {
  const UP = [20, 20, 20, 20, 20, 20, 20, 21, 30, 30, 30];
  const evaluate = scoreAt({ A: { 5: -4 } });
  const sl = runBacktest({ A: candles(UP, { highs: { 7: 22 } }) }, { ...base, evaluate, direction: 'short', stopLossPct: 8 });
  assert.equal(sl.trades[0].reason, 'zarar durdur');
  assert.equal(sl.trades[0].exitPrice, 21.6);
  assert.ok(Math.abs(sl.trades[0].pnl - -8) < 1e-9);
  // fiyat 50'den açılıyor (2,5 kat): tasfiye, kayıp = teminat
  const gap = runBacktest({ A: candles(UP, { opens: { 7: 50 }, highs: { 7: 50 } }) }, { ...base, evaluate, direction: 'short', stopLossPct: 8 });
  assert.equal(gap.trades[0].reason, 'tasfiye');
  assert.equal(gap.trades[0].pnl, -100);
});

test('fonlama ücreti açık pozisyon süresince birikir', () => {
  const evaluate = scoreAt({ A: { 5: -4, 9: 3 } });
  const r = runBacktest({ A: candles(DOWN) }, { ...base, evaluate, direction: 'short', fundingPct: 0.01 });
  // 6..9. mumlar açık (4 saatlik değil, 1 saatlik mumlar): her mumda qty × kapanış × 0,0001 × 1/8
  const expected = 5 * (20 + 15 + 10 + 5) * 0.0001 / 8;
  assert.ok(Math.abs(r.trades[0].funding - expected) < 1e-12);
  assert.ok(Math.abs(r.summary.totalPnl - (75 - expected)) < 1e-9);
});

test('intrabarEvaluator: oluşan büyük mumla analiz, canlı analizle aynı sonuç', async () => {
  const { intrabarEvaluator } = await import('../src/backtest.js');
  const { computeSeries, evaluateAt } = await import('../src/analysis.js');
  const B = 4 * H; // büyük mum = 4 küçük (1s) mum
  const small = [];
  for (let i = 0; i < 300 * 4; i++) {
    const c = 100 + Math.sin(i / 37) * 10 + i * 0.01;
    small.push({ openTime: T0 + i * H, closeTime: T0 + (i + 1) * H - 1, open: c, high: c, low: c, close: c });
  }
  const bigCloses = [];
  for (let g = 0; g < 300; g++) bigCloses.push(small[g * 4 + 3].close);
  const opts = { buyScore: 3, sellScore: -2, requireTrend: true };

  // sadece büyük mum kapanışında (everyMin = 240): son bar = son büyük mumun kapanışı
  const evClose = intrabarEvaluator(small, B, 240);
  assert.equal(evClose(null, 1198, opts).methods.length, 0, 'ara barda analiz yok');
  const want = evaluateAt(computeSeries(bigCloses.map((close) => ({ close }))), 299, opts);
  assert.deepEqual(evClose(null, 1199, opts), want);

  // saatte bir: büyük mumun 2. küçük barında, oluşan mumun kapanışı o barın kapanışı
  const evHourly = intrabarEvaluator(small, B, 60);
  const partial = [...bigCloses.slice(0, 299), small[299 * 4 + 1].close].map((close) => ({ close }));
  assert.deepEqual(evHourly(null, 299 * 4 + 1, opts), evaluateAt(computeSeries(partial), 299, opts));
});
