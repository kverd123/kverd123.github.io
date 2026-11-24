import { emaSeries, rsiSeries, macdSeries, bollingerSeries } from './indicators.js';

export const INDICATORS = {
  trendEma: 200,
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiLow: 30,
  rsiHigh: 70,
  macd: [12, 26, 9],
  bbPeriod: 20,
  bbMult: 2,
};

/** Analiz için gereken en az kapanmış mum sayısı ve indirilecek önerilen sayı. */
export const MIN_CANDLES = INDICATORS.trendEma + 2;
export const FETCH_CANDLES = INDICATORS.trendEma * 3;

/** Tüm göstergeleri bir kez hesaplar (canlı bot ve backtest aynı fonksiyonu kullanır). */
export function computeSeries(candles) {
  const closes = candles.map((k) => k.close);
  const p = INDICATORS;
  return {
    closes,
    ema200: emaSeries(closes, p.trendEma),
    emaFast: emaSeries(closes, p.emaFast),
    emaSlow: emaSeries(closes, p.emaSlow),
    rsi: rsiSeries(closes, p.rsiPeriod),
    macd: macdSeries(closes, ...p.macd),
    bb: bollingerSeries(closes, p.bbPeriod, p.bbMult),
  };
}

const ready = (...v) => v.every((x) => x !== null && x !== undefined && Number.isFinite(x));

/**
 * i. mum kapanışında beş yöntemin oyu (+1 al yönlü, -1 sat yönlü, 0 nötr) ve toplam skor.
 * opts: { buyScore, sellScore, requireTrend }
 */
export function evaluateAt(s, i, { buyScore = 3, sellScore = -2, requireTrend = true } = {}) {
  const p = INDICATORS;
  const c = s.closes[i];
  const e200 = s.ema200[i], ef = s.emaFast[i], es = s.emaSlow[i], rsi = s.rsi[i];
  const h = s.macd.hist[i], hPrev = s.macd.hist[i - 1];
  const up = s.bb.upper[i], lo = s.bb.lower[i];
  if (!ready(c, e200, ef, es, rsi, h, hPrev, up, lo)) {
    return { score: 0, signal: 'HOLD', ready: false, methods: [] };
  }

  const methods = [
    {
      key: 'trend', name: `Trend (EMA${p.trendEma})`,
      vote: c > e200 ? 1 : -1, value: e200,
      detail: `Fiyat EMA${p.trendEma}'ün ${c > e200 ? 'üstünde' : 'altında'}`,
    },
    {
      key: 'ema', name: `EMA ${p.emaFast}/${p.emaSlow}`,
      vote: ef > es ? 1 : -1, value: ef - es,
      detail: `EMA${p.emaFast} ${ef > es ? '>' : '<'} EMA${p.emaSlow}`,
    },
    {
      key: 'macd', name: `MACD (${p.macd.join('/')})`,
      vote: h > 0 && h > hPrev ? 1 : h < 0 && h < hPrev ? -1 : 0, value: h,
      detail: `Histogram ${h > 0 ? 'pozitif' : 'negatif'}, ${h > hPrev ? 'artıyor' : 'azalıyor'}`,
    },
    {
      key: 'rsi', name: `RSI (${p.rsiPeriod})`,
      vote: rsi < p.rsiLow ? 1 : rsi > p.rsiHigh ? -1 : 0, value: rsi,
      detail: `RSI ${rsi.toFixed(1)} (${rsi < p.rsiLow ? 'aşırı satım' : rsi > p.rsiHigh ? 'aşırı alım' : 'nötr'})`,
    },
    {
      key: 'bb', name: `Bollinger (${p.bbPeriod}, ${p.bbMult})`,
      vote: c < lo ? 1 : c > up ? -1 : 0, value: (c - lo) / (up - lo),
      detail: c < lo ? 'Alt bandın altında' : c > up ? 'Üst bandın üstünde' : 'Bant içinde',
    },
  ];

  const score = methods.reduce((a, m) => a + m.vote, 0);
  const trendOk = !requireTrend || methods[0].vote === 1;
  let signal = 'HOLD';
  if (score >= buyScore && trendOk) signal = 'BUY';
  else if (score <= sellScore) signal = 'SELL';
  return { score, signal, ready: true, methods };
}

/** Son kapanmış mum için analiz. */
export function analyze(candles, opts) {
  const s = computeSeries(candles);
  return evaluateAt(s, candles.length - 1, opts);
}
