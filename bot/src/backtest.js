import { smaCrossSignal } from './strategy.js';

/**
 * Canlı botla aynı kurallarla geçmiş mumlar üzerinde simülasyon.
 *
 * Gerçekçilik varsayımları:
 *  - Sinyal mum kapanışında hesaplanır, emir BİR SONRAKİ mumun açılışında dolar
 *    (canlı bot da kapanmış mumu gördükten sonra market emri verir).
 *  - Zarar durdur / kâr al mum içindeki en düşük / en yüksek fiyata göre kontrol edilir.
 *    Fiyat seviyenin ötesinde açılırsa (boşluk) açılış fiyatından dolar.
 *    Aynı mumda ikisi birden tetiklenirse kötümser varsayımla zarar durdur sayılır.
 *  - Her alım ve satımda komisyon (feePct) ve kayma (slippagePct) uygulanır.
 *  - Günlük işlem limiti yeni alımları durdurur, satışları durdurmaz.
 */
export function runBacktest(candles, opts) {
  const {
    smaFast, smaSlow, stopLossPct = 0, takeProfitPct = 0,
    orderQuoteAmount = 100, maxTradesPerDay = Infinity,
    feePct = 0.1, slippagePct = 0.05,
  } = opts;
  if (candles.length < smaSlow + 2) throw new Error(`En az ${smaSlow + 2} mum gerekli (gelen: ${candles.length})`);

  const fee = feePct / 100;
  const slip = slippagePct / 100;
  const trades = [];
  const equity = []; // kümülatif K/Z (quote) her mum sonunda
  let pos = null; // { qty, entryPrice, cost, openedAt, slPrice, tpPrice }
  let realized = 0;
  let feesPaid = 0;
  let barsInMarket = 0;
  const daily = { date: null, trades: 0 };
  const closes = [];

  const countTrade = (t) => {
    const d = new Date(t).toISOString().slice(0, 10);
    if (daily.date !== d) Object.assign(daily, { date: d, trades: 0 });
    daily.trades += 1;
  };
  const canBuy = (t) => {
    const d = new Date(t).toISOString().slice(0, 10);
    return (daily.date === d ? daily.trades : 0) < maxTradesPerDay;
  };

  const open = (k) => {
    const price = k.open * (1 + slip);
    const qty = (orderQuoteAmount * (1 - fee)) / price;
    feesPaid += orderQuoteAmount * fee;
    pos = {
      qty, entryPrice: price, cost: orderQuoteAmount, openedAt: k.openTime,
      slPrice: stopLossPct > 0 ? price * (1 - stopLossPct / 100) : null,
      tpPrice: takeProfitPct > 0 ? price * (1 + takeProfitPct / 100) : null,
    };
    countTrade(k.openTime);
  };
  const close = (rawPrice, at, reason) => {
    const price = rawPrice * (1 - slip);
    const gross = pos.qty * price;
    const fees = gross * fee;
    feesPaid += fees;
    const pnl = gross - fees - pos.cost;
    realized += pnl;
    trades.push({
      entryAt: pos.openedAt, exitAt: at, entryPrice: pos.entryPrice, exitPrice: price,
      pnl, pnlPct: (pnl / pos.cost) * 100, reason,
    });
    countTrade(at);
    pos = null;
  };

  let pending = null; // bir önceki mum kapanışında üretilen sinyal
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];

    // 1) Önceki mumun sinyalini bu mumun açılışında uygula
    if (pending === 'BUY' && !pos && canBuy(k.openTime)) open(k);
    else if (pending === 'SELL' && pos) close(k.open, k.openTime, 'SMA kesişimi');
    pending = null;

    // 2) Mum içinde zarar durdur / kâr al
    if (pos) {
      if (pos.slPrice && k.low <= pos.slPrice) {
        close(Math.min(k.open, pos.slPrice), k.openTime, 'zarar durdur');
      } else if (pos.tpPrice && k.high >= pos.tpPrice) {
        close(Math.max(k.open, pos.tpPrice), k.openTime, 'kâr al');
      }
    }
    if (pos) barsInMarket += 1;

    // 3) Mum kapanışında sinyal
    closes.push(k.close);
    const window = closes.slice(-(smaSlow + 1));
    pending = smaCrossSignal(window, smaFast, smaSlow).signal;
    if (pending === 'HOLD') pending = null;

    const unrealized = pos ? pos.qty * k.close * (1 - fee) - pos.cost : 0;
    equity.push({ t: k.closeTime, v: realized + unrealized });
  }

  // Dönem sonunda açık pozisyon son kapanıştan kapatılır (rapor için)
  const last = candles.at(-1);
  if (pos) close(last.close, last.closeTime, 'dönem sonu');
  equity[equity.length - 1].v = realized;

  return { trades, equity, summary: summarize({ trades, equity, candles, realized, feesPaid, barsInMarket, orderQuoteAmount }) };
}

function summarize({ trades, equity, candles, realized, feesPaid, barsInMarket, orderQuoteAmount }) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
  const grossWin = sum(wins);
  const grossLoss = -sum(losses);

  let peak = 0, maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.v);
    maxDd = Math.max(maxDd, peak - p.v);
  }
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const first = candles[0], last = candles.at(-1);
  return {
    from: first.openTime,
    to: last.closeTime,
    candles: candles.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnl: realized,
    // Getiri, işlem başına ayrılan tutara göre (bot her seferinde aynı tutarla girer)
    returnPct: (realized / orderQuoteAmount) * 100,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: (maxDd / orderQuoteAmount) * 100,
    feesPaid,
    exposurePct: (barsInMarket / candles.length) * 100,
    buyHoldPct: ((last.close - first.open) / first.open) * 100,
    exitReasons: byReason,
  };
}
