/** Açık pozisyon için zarar durdur / kâr al kontrolü. */
export function exitCheck(position, price, { stopLossPct, takeProfitPct }) {
  if (!position) return null;
  const change = ((price - position.entryPrice) / position.entryPrice) * 100;
  if (stopLossPct > 0 && change <= -stopLossPct) return `zarar durdur (${change.toFixed(2)}%)`;
  if (takeProfitPct > 0 && change >= takeProfitPct) return `kâr al (${change.toFixed(2)}%)`;
  return null;
}
