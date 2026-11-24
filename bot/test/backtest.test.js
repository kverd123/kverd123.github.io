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
function candles(closes, { opens = {}, highs = {}, lows = {} } = {}) {
  return closes.map((c, i) => {
    const o = opens[i] ?? (i ? closes[i - 1] : c);
    return {
      openTime: T0 + i * H, closeTime: T0 + (i + 1) * H - 1, open: o, close: c,
      high: highs[i] ?? Math.max(o, c), low: lows[i] ?? Math.min(o, c), volume: 1,
    };
  });
}

// SMA 2/4 ile: mum 5 kapanışında AL sinyali, mum 9 kapanışında SAT sinyali.
//               0   1   2   3   4   5   6   7   8  9 10
const UP_DOWN = [10, 10, 10, 10, 10, 20, 20, 20, 20, 5, 5];
const base = { smaFast: 2, smaSlow: 4, orderQuoteAmount: 100, feePct: 0, slippagePct: 0 };

test('emir sinyalden sonraki mumun açılışında dolar', () => {
  const r = runBacktest(candles(UP_DOWN), base);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryAt, T0 + 6 * H);
  assert.equal(t.entryPrice, 20);
  assert.equal(t.exitAt, T0 + 10 * H);
  assert.equal(t.exitPrice, 5);
  assert.equal(t.reason, 'SMA kesişimi');
  assert.equal(t.pnl, -75); // 100/20 = 5 adet, 5 × 5 = 25
});

test('zarar durdur mum içi en düşük fiyatla tetiklenir ve seviyeden dolar', () => {
  const r = runBacktest(candles(UP_DOWN, { lows: { 7: 17 } }), { ...base, stopLossPct: 10 });
  const t = r.trades[0];
  assert.equal(t.reason, 'zarar durdur');
  assert.equal(t.exitPrice, 18);
  assert.equal(t.pnl, -10);
});

test('fiyat zarar durdurun altında açılırsa (boşluk) açılıştan dolar', () => {
  const r = runBacktest(candles(UP_DOWN, { opens: { 7: 15 } }), { ...base, stopLossPct: 10 });
  assert.equal(r.trades[0].exitPrice, 15);
  assert.equal(r.trades[0].pnl, -25);
});

test('kâr al ve aynı mumda ikisi birden olursa zarar durdur sayılır', () => {
  const tp = runBacktest(candles(UP_DOWN, { highs: { 7: 25 } }), { ...base, takeProfitPct: 10 });
  assert.equal(tp.trades[0].reason, 'kâr al');
  assert.equal(tp.trades[0].exitPrice, 22);
  assert.ok(Math.abs(tp.trades[0].pnl - 10) < 1e-9);

  const both = runBacktest(candles(UP_DOWN, { highs: { 7: 25 }, lows: { 7: 17 } }), { ...base, stopLossPct: 10, takeProfitPct: 10 });
  assert.equal(both.trades[0].reason, 'zarar durdur');
});

test('komisyon ve kayma sonuca yansır', () => {
  const r = runBacktest(candles(UP_DOWN), { ...base, feePct: 0.1, slippagePct: 0.05 });
  const entry = 20 * 1.0005;
  const qty = (100 * 0.999) / entry;
  const gross = qty * 5 * 0.9995;
  const expected = gross * 0.999 - 100;
  assert.ok(Math.abs(r.summary.totalPnl - expected) < 1e-9);
  assert.ok(Math.abs(r.summary.feesPaid - (0.1 + gross * 0.001)) < 1e-9);
});

test('dönem sonunda açık pozisyon kapatılır, özet doğru', () => {
  const c = [10, 10, 10, 10, 10, 20, 20, 30];
  const r = runBacktest(candles(c), base);
  assert.equal(r.trades[0].reason, 'dönem sonu');
  assert.equal(r.summary.totalPnl, 50); // 5 adet × 30 − 100
  assert.equal(r.summary.wins, 1);
  assert.equal(r.summary.buyHoldPct, 200);
  assert.equal(r.equity.at(-1).v, 50);
});

test('günlük işlem limiti alımı engeller', () => {
  const r = runBacktest(candles(UP_DOWN), { ...base, maxTradesPerDay: 0 });
  assert.equal(r.trades.length, 0);
});

test('en büyük düşüş zirveden hesaplanır', () => {
  // önce +50 kazanç, sonra −75 kayıp
  const c = [10, 10, 10, 10, 10, 20, 20, 30, 30, 5, 5, 5, 5, 5, 20, 20, 5, 5];
  const r = runBacktest(candles(c), base);
  assert.ok(r.summary.trades >= 2);
  assert.ok(r.summary.maxDrawdown > 0);
  const peak = Math.max(...r.equity.map((p) => p.v));
  const trough = Math.min(...r.equity.slice(r.equity.findIndex((p) => p.v === peak)).map((p) => p.v));
  assert.equal(r.summary.maxDrawdown, peak - trough);
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
