import { computeSeries, evaluateAt } from './analysis.js';

/**
 * Canlı botla aynı kurallarla, birden çok coin üzerinde portföy simülasyonu.
 *
 * Gerçekçilik varsayımları:
 *  - Sinyal mum kapanışında hesaplanır, emir BİR SONRAKİ mumun açılışında dolar.
 *  - Zarar durdur / kâr al mum içindeki en düşük / en yüksek fiyata göre kontrol edilir.
 *    Fiyat seviyenin ötesinde açılırsa (boşluk) açılış fiyatından dolar.
 *    Aynı mumda ikisi birden tetiklenirse kötümser varsayımla zarar durdur sayılır.
 *  - Her alım ve satımda komisyon (feePct) ve kayma (slippagePct) uygulanır.
 *  - Aynı anda en fazla maxOpenPositions pozisyon; günlük işlem limiti sadece alımları durdurur.
 *  - Aynı mumda birden çok alım sinyali varsa, coin listesindeki sıraya göre (hacim) öncelik verilir.
 *
 * dataBySymbol: { SYMBOL: mumlar[] } (sıra = öncelik)
 */
export function runBacktest(dataBySymbol, opts) {
  const {
    stopLossPct = 0, takeProfitPct = 0, orderQuoteAmount = 100, maxOpenPositions = 5,
    maxTradesPerDay = Infinity, feePct = 0.1, slippagePct = 0.05,
    buyScore = 3, sellScore = -2, requireTrend = true,
    tradeFrom = -Infinity, // bu zamandan önceki mumlar sadece göstergeleri ısıtmak için kullanılır
  } = opts;
  const fee = feePct / 100;
  const slip = slippagePct / 100;
  const symbols = Object.keys(dataBySymbol).filter((s) => dataBySymbol[s].length > 0);
  if (!symbols.length) throw new Error('Veri yok');

  const series = {}, ptr = {}, pending = {}, lastClose = {};
  for (const s of symbols) {
    series[s] = computeSeries(dataBySymbol[s]);
    ptr[s] = 0;
  }
  const allTimes = [...new Set(symbols.flatMap((s) => dataBySymbol[s].map((k) => k.openTime)))].sort((a, b) => a - b);
  const times = allTimes.filter((t) => t >= tradeFrom);
  if (!times.length) throw new Error('Test dönemi için veri yok');
  const firstOpen = {};

  const positions = {};
  const trades = [];
  const equity = [];
  let realized = 0, feesPaid = 0, barsWithPosition = 0, maxConcurrent = 0;
  const daily = { date: null, trades: 0 };
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const countTrade = (t) => {
    if (daily.date !== dayOf(t)) Object.assign(daily, { date: dayOf(t), trades: 0 });
    daily.trades += 1;
  };
  const canBuy = (t) => (daily.date === dayOf(t) ? daily.trades : 0) < maxTradesPerDay;

  const open = (s, k) => {
    const price = k.open * (1 + slip);
    feesPaid += orderQuoteAmount * fee;
    positions[s] = {
      qty: (orderQuoteAmount * (1 - fee)) / price, entryPrice: price, cost: orderQuoteAmount, openedAt: k.openTime,
      slPrice: stopLossPct > 0 ? price * (1 - stopLossPct / 100) : null,
      tpPrice: takeProfitPct > 0 ? price * (1 + takeProfitPct / 100) : null,
    };
    countTrade(k.openTime);
  };
  const close = (s, rawPrice, at, reason) => {
    const pos = positions[s];
    const price = rawPrice * (1 - slip);
    const gross = pos.qty * price;
    feesPaid += gross * fee;
    const pnl = gross * (1 - fee) - pos.cost;
    realized += pnl;
    trades.push({ symbol: s, entryAt: pos.openedAt, exitAt: at, entryPrice: pos.entryPrice, exitPrice: price, pnl, pnlPct: (pnl / pos.cost) * 100, reason });
    countTrade(at);
    delete positions[s];
  };

  for (const t of allTimes) {
    const live = t >= tradeFrom;
    for (const s of symbols) {
      const candles = dataBySymbol[s];
      const i = ptr[s];
      if (i >= candles.length || candles[i].openTime !== t) continue;
      const k = candles[i];
      ptr[s] += 1;
      lastClose[s] = k.close;
      if (!live) continue;
      if (firstOpen[s] === undefined) firstOpen[s] = k.open;

      // 1) Önceki mumun sinyalini bu mumun açılışında uygula
      if (pending[s] === 'SELL' && positions[s]) close(s, k.open, k.openTime, 'analiz');
      else if (pending[s] === 'BUY' && !positions[s] && Object.keys(positions).length < maxOpenPositions && canBuy(k.openTime)) open(s, k);
      pending[s] = null;

      // 2) Mum içinde zarar durdur / kâr al
      const pos = positions[s];
      if (pos?.slPrice && k.low <= pos.slPrice) close(s, Math.min(k.open, pos.slPrice), k.openTime, 'zarar durdur');
      else if (pos?.tpPrice && k.high >= pos.tpPrice) close(s, Math.max(k.open, pos.tpPrice), k.openTime, 'kâr al');

      // 3) Mum kapanışında analiz
      const ev = evaluateAt(series[s], i, { buyScore, sellScore, requireTrend });
      if (ev.signal !== 'HOLD') pending[s] = ev.signal;
    }
    if (!live) continue;

    const n = Object.keys(positions).length;
    if (n) barsWithPosition += 1;
    maxConcurrent = Math.max(maxConcurrent, n);
    let unrealized = 0;
    for (const [s, p] of Object.entries(positions)) unrealized += p.qty * lastClose[s] * (1 - fee) - p.cost;
    equity.push({ t, v: realized + unrealized });
  }

  // Dönem sonunda açık pozisyonlar son kapanıştan kapatılır (rapor için)
  for (const s of Object.keys(positions)) close(s, lastClose[s], dataBySymbol[s].at(-1).closeTime, 'dönem sonu');
  equity[equity.length - 1].v = realized;

  const capital = orderQuoteAmount * Math.min(maxOpenPositions, symbols.length);
  return {
    trades,
    equity,
    summary: summarize({ trades, equity, realized, feesPaid, capital, times, barsWithPosition, maxConcurrent, dataBySymbol, symbols, firstOpen }),
  };
}

function stats(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnl: grossWin - grossLoss,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
  };
}

function summarize({ trades, equity, realized, feesPaid, capital, times, barsWithPosition, maxConcurrent, dataBySymbol, symbols, firstOpen }) {
  const traded = symbols.filter((s) => firstOpen[s] !== undefined);
  const buyHold = (s) => ((dataBySymbol[s].at(-1).close - firstOpen[s]) / firstOpen[s]) * 100;
  let peak = 0, maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.v);
    maxDd = Math.max(maxDd, peak - p.v);
  }
  const exitReasons = {};
  for (const t of trades) exitReasons[t.reason] = (exitReasons[t.reason] || 0) + 1;

  const perSymbol = traded.map((s) => ({
    symbol: s,
    ...stats(trades.filter((t) => t.symbol === s)),
    buyHoldPct: buyHold(s),
  }));

  return {
    from: times[0],
    to: Math.max(...symbols.map((s) => dataBySymbol[s].at(-1).closeTime)),
    candles: times.length,
    symbols: symbols.length,
    capital,
    ...stats(trades),
    totalPnl: realized,
    returnPct: (realized / capital) * 100,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: (maxDd / capital) * 100,
    feesPaid,
    exposurePct: (barsWithPosition / times.length) * 100,
    maxConcurrent,
    // Karşılaştırma: aynı sermayeyi coinlere eşit bölüp alıp tutmak
    buyHoldPct: perSymbol.reduce((a, p) => a + p.buyHoldPct, 0) / perSymbol.length,
    exitReasons,
    perSymbol,
  };
}
