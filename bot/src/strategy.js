export function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/**
 * Hızlı SMA yavaş SMA'yı yukarı keserse BUY, aşağı keserse SELL, aksi halde HOLD.
 * Sadece kapanmış mumların kapanış fiyatları verilmeli.
 */
export function smaCrossSignal(closes, fast, slow) {
  if (closes.length < slow + 1) {
    return { signal: 'HOLD', reason: 'yetersiz veri', fast: null, slow: null };
  }
  const prev = closes.slice(0, -1);
  const fPrev = sma(prev, fast);
  const sPrev = sma(prev, slow);
  const fNow = sma(closes, fast);
  const sNow = sma(closes, slow);

  let signal = 'HOLD';
  if (fPrev <= sPrev && fNow > sNow) signal = 'BUY';
  else if (fPrev >= sPrev && fNow < sNow) signal = 'SELL';
  return { signal, fast: fNow, slow: sNow, reason: signal === 'HOLD' ? 'kesişim yok' : 'SMA kesişimi' };
}

/** Açık pozisyon için zarar durdur / kâr al kontrolü. */
export function exitCheck(position, price, { stopLossPct, takeProfitPct }) {
  if (!position) return null;
  const change = ((price - position.entryPrice) / position.entryPrice) * 100;
  if (stopLossPct > 0 && change <= -stopLossPct) return `zarar durdur (${change.toFixed(2)}%)`;
  if (takeProfitPct > 0 && change >= takeProfitPct) return `kâr al (${change.toFixed(2)}%)`;
  return null;
}
