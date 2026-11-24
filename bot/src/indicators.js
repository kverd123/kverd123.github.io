// Teknik göstergeler. Hepsi tüm seri için dizi döner; hesaplanamayan başlangıç değerleri null'dır.

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Üssel hareketli ortalama. Baştaki null değerleri atlar, ilk değer SMA ile başlatılır. */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v !== null && v !== undefined);
  if (start < 0 || values.length - start < period) return out;
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  out[start + period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI (Wilder yumuşatması). */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const rsi = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = rsi(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsi(gain, loss);
  }
  return out;
}

export function macdSeries(closes, fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macd = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const sig = emaSeries(macd, signal);
  const hist = macd.map((m, i) => (m !== null && sig[i] !== null ? m - sig[i] : null));
  return { macd, signal: sig, hist };
}

export function bollingerSeries(closes, period = 20, mult = 2) {
  const mid = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}
