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
 * Short (direction: 'short' | 'both') — vadeli işlem (futures) simülasyonu, 1x kaldıraç:
 *  - Skor ≤ -shortScore ve (requireTrend ise) fiyat EMA200 altındaysa short açılır.
 *  - Skor ≥ coverScore olunca ya da fiyat stopLossPct kadar yükselince kapanır.
 *  - fundingPct: her 8 saatte pozisyon büyüklüğüne uygulanan fonlama ücreti. Kötümser
 *    varsayımla her iki yön de öder (gerçekte işareti piyasaya göre değişir).
 *  - 1x kaldıraçta fiyat iki katına çıkarsa pozisyon tasfiye olur: kayıp en fazla teminat kadardır.
 *
 * dataBySymbol: { SYMBOL: mumlar[] } (sıra = öncelik)
 */
export function runBacktest(dataBySymbol, opts) {
  const {
    stopLossPct = 0, takeProfitPct = 0, orderQuoteAmount = 100, maxOpenPositions = 5,
    maxTradesPerDay = Infinity, feePct = 0.1, slippagePct = 0.05,
    buyScore = 3, sellScore = -2, requireTrend = true,
    tradeFrom = -Infinity, // bu zamandan önceki mumlar sadece göstergeleri ısıtmak için kullanılır
    evaluate = evaluateAt, // testlerde sinyal üretimini değiştirmek için
    direction = 'long', shortScore = 3, coverScore = 2, fundingPct = 0,
  } = opts;
  if (!['long', 'short', 'both'].includes(direction)) throw new Error(`direction long/short/both olmalı (gelen: ${direction})`);
  const allowLong = direction !== 'short';
  const allowShort = direction !== 'long';
  const funding = fundingPct / 100;
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

  const open = (s, k, side = 'long') => {
    feesPaid += orderQuoteAmount * fee;
    if (side === 'long') {
      const price = k.open * (1 + slip);
      positions[s] = {
        side, qty: (orderQuoteAmount * (1 - fee)) / price, entryPrice: price, cost: orderQuoteAmount, openedAt: k.openTime, funding: 0,
        slPrice: stopLossPct > 0 ? price * (1 - stopLossPct / 100) : null,
        tpPrice: takeProfitPct > 0 ? price * (1 + takeProfitPct / 100) : null,
      };
    } else {
      const price = k.open * (1 - slip); // açığa satışta kayma aleyhe: daha düşük fiyattan satılır
      positions[s] = {
        side, qty: (orderQuoteAmount * (1 - fee)) / price, entryPrice: price, cost: orderQuoteAmount, openedAt: k.openTime, funding: 0,
        slPrice: stopLossPct > 0 ? price * (1 + stopLossPct / 100) : null,
        tpPrice: takeProfitPct > 0 ? price * (1 - takeProfitPct / 100) : null,
        liqPrice: price * 2,
      };
    }
    countTrade(k.openTime);
  };
  // Pozisyonun (komisyonlar ve fonlama dahil) değeri − teminat
  const valueOf = (pos, rawPrice, exitSlip) => {
    if (pos.side === 'long') {
      const gross = pos.qty * rawPrice * (1 - exitSlip);
      return { pnl: gross * (1 - fee) - pos.cost - pos.funding, exitFee: gross * fee, price: rawPrice * (1 - exitSlip) };
    }
    const price = rawPrice * (1 + exitSlip);
    const exitFee = pos.qty * price * fee;
    const pnl = pos.qty * (pos.entryPrice - price) - orderQuoteAmount * fee - exitFee - pos.funding;
    return { pnl: Math.max(pnl, -pos.cost), exitFee, price };
  };
  const close = (s, rawPrice, at, reason) => {
    const pos = positions[s];
    const { pnl, exitFee, price } = valueOf(pos, rawPrice, slip);
    feesPaid += exitFee;
    realized += pnl;
    trades.push({
      symbol: s, side: pos.side, entryAt: pos.openedAt, exitAt: at, entryPrice: pos.entryPrice, exitPrice: price,
      pnl, pnlPct: (pnl / pos.cost) * 100, funding: pos.funding, reason,
    });
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

      // 1) Önceki mumun sinyalini bu mumun açılışında uygula (aynı mumda yön değiştirilmez)
      const sig = pending[s];
      pending[s] = null;
      const cur = positions[s];
      if (sig && cur) {
        if (cur.side === 'long' && sig.closeLong) close(s, k.open, k.openTime, 'analiz');
        else if (cur.side === 'short' && sig.closeShort) close(s, k.open, k.openTime, 'analiz');
      } else if (sig && Object.keys(positions).length < maxOpenPositions && canBuy(k.openTime)) {
        if (allowLong && sig.openLong) open(s, k, 'long');
        else if (allowShort && sig.openShort) open(s, k, 'short');
      }

      // 2) Mum içinde tasfiye / zarar durdur / kâr al
      const pos = positions[s];
      if (pos?.side === 'long') {
        if (pos.slPrice && k.low <= pos.slPrice) close(s, Math.min(k.open, pos.slPrice), k.openTime, 'zarar durdur');
        else if (pos.tpPrice && k.high >= pos.tpPrice) close(s, Math.max(k.open, pos.tpPrice), k.openTime, 'kâr al');
      } else if (pos?.side === 'short') {
        if (pos.slPrice && k.high >= pos.slPrice) {
          const fill = Math.max(k.open, pos.slPrice); // boşlukla açılırsa açılış fiyatından
          close(s, fill, k.openTime, fill >= pos.liqPrice ? 'tasfiye' : 'zarar durdur');
        } else if (!pos.slPrice && k.high >= pos.liqPrice) close(s, Math.max(k.open, pos.liqPrice), k.openTime, 'tasfiye');
        else if (pos.tpPrice && k.low <= pos.tpPrice) close(s, Math.min(k.open, pos.tpPrice), k.openTime, 'kâr al');
      }
      // Fonlama: pozisyon açık kaldığı süre boyunca (8 saatlik orana göre)
      if (positions[s] && funding) {
        const p = positions[s];
        p.funding += p.qty * k.close * funding * ((k.closeTime + 1 - k.openTime) / (8 * 3600e3));
      }

      // 3) Mum kapanışında analiz
      const ev = evaluate(series[s], i, { buyScore, sellScore, requireTrend }, s);
      const trendVote = ev.methods?.find((m) => m.key === 'trend')?.vote;
      pending[s] = {
        openLong: ev.signal === 'BUY',
        closeLong: ev.signal === 'SELL',
        openShort: ev.score <= -shortScore && (!requireTrend || trendVote === undefined || trendVote === -1),
        closeShort: ev.score >= coverScore,
      };
    }
    if (!live) continue;

    const n = Object.keys(positions).length;
    if (n) barsWithPosition += 1;
    maxConcurrent = Math.max(maxConcurrent, n);
    let unrealized = 0;
    for (const [s, p] of Object.entries(positions)) unrealized += valueOf(p, lastClose[s], 0).pnl;
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
    bySide: {
      long: stats(trades.filter((t) => t.side === 'long')),
      short: stats(trades.filter((t) => t.side === 'short')),
    },
    fundingPaid: trades.reduce((a, t) => a + (t.funding || 0), 0),
    exitReasons,
    perSymbol,
  };
}
