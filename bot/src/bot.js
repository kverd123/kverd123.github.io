import { floorToStep } from './binance.js';
import { computeSeries, evaluateAt, FETCH_CANDLES, MIN_CANDLES } from './analysis.js';
import { exitCheck } from './strategy.js';
import { selectUniverse } from './universe.js';
import { intervalMs } from './history.js';

const today = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Çoklu coin spot botu.
 *  - Coin evreni: sabit liste (SYMBOLS) ya da hacme göre ilk N coin (günde bir yenilenir).
 *  - Her coin, yeni bir mum kapandığında beş yöntemle analiz edilir (bkz. analysis.js).
 *  - Skor yeterliyse alır, skor düşerse veya zarar durdur / kâr al tetiklenirse satar.
 *  - Her coinde en fazla bir pozisyon, toplamda en fazla MAX_OPEN_POSITIONS pozisyon.
 *  - Sadece kendi aldığı miktarları satar; hesaptaki diğer varlıklara dokunmaz.
 *  - Evrenden düşen bir coinde açık pozisyon varsa, kapanana kadar yönetilmeye devam eder.
 */
export class TradingBot {
  constructor({ client, config, store, notify = async () => {}, logger, now = () => Date.now(), evaluate = evaluateAt }) {
    this.client = client;
    this.evaluate = evaluate; // testlerde sinyal üretimini değiştirmek için
    this.cfg = config;
    this.store = store;
    this.notify = notify;
    this.log = logger;
    this.now = now;
    this.rules = {};
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.lastError = null;
    this.symbolErrors = {};
    this.intervalMs = intervalMs(config.interval);
  }

  get state() {
    return this.store.state;
  }

  async init() {
    if (this.cfg.apiKey) {
      try {
        await this.client.syncTime();
      } catch (e) {
        this.log.warn(`Saat senkronu başarısız: ${e.message}`);
      }
    }
    await this.refreshUniverse(true);
    this.log.info(
      `Hazır: ${this.state.universe.symbols.join(', ')} | ${this.cfg.interval} | ortam=${this.cfg.binanceEnv} | dryRun=${this.cfg.dryRun}`,
    );
  }

  /** İzlenecek coin listesini günceller (sabit liste ya da hacme göre ilk N). */
  async refreshUniverse(force = false) {
    const u = this.state.universe;
    const stale = !u.updatedAt || this.now() - u.updatedAt > this.cfg.universeRefreshHours * 3600e3;
    if (!force && !stale && u.symbols.length) return;

    let symbols, skipped = [];
    if (this.cfg.symbols.length) {
      symbols = this.cfg.symbols;
    } else {
      const res = await selectUniverse(this.client, {
        topN: this.cfg.topN,
        quote: this.cfg.quoteAsset,
        exclude: this.cfg.excludeAssets,
        minListingDays: this.cfg.minListingDays,
        listingCache: this.state.listingCache,
        now: this.now(),
      });
      symbols = res.symbols;
      skipped = res.skipped;
    }
    if (!symbols.length) throw new Error('İzlenecek coin bulunamadı');

    const needed = [...new Set([...symbols, ...Object.keys(this.state.positions)])];
    const missing = needed.filter((s) => !this.rules[s]);
    if (missing.length) Object.assign(this.rules, await this.client.rulesFor(missing));

    const changed = symbols.join() !== u.symbols.join();
    this.state.universe = { symbols, skipped, updatedAt: this.now() };
    if (changed) this.log.info(`Coin listesi: ${symbols.join(', ')}`);
    this.store.save();
  }

  /** Analiz edilen coinler: güncel liste + listeden düşmüş ama pozisyonu açık olanlar. */
  watched() {
    return [...new Set([...this.state.universe.symbols, ...Object.keys(this.state.positions)])];
  }

  start() {
    if (this.running) return false;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, this.cfg.tickSeconds * 1000);
    };
    loop();
    this.log.info('Bot başlatıldı');
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    clearTimeout(this.timer);
    this.log.info('Bot durduruldu');
    return true;
  }

  /** Bir karar döngüsü: tüm coinleri gözden geçirir. Bir coindeki hata diğerlerini durdurmaz. */
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    const now = this.now();
    try {
      if (!this.state.universe.symbols.length) await this.init();
      try {
        await this.refreshUniverse();
      } catch (e) {
        this.log.warn(`Coin listesi yenilenemedi, eski liste kullanılıyor: ${e.message}`);
      }

      const symbols = this.watched();
      const prices = await this.client.prices(symbols);
      const actions = [];
      for (const symbol of symbols) {
        try {
          const action = await this.handleSymbol(symbol, prices[symbol], now);
          if (action) actions.push(`${action} ${symbol}`);
          delete this.symbolErrors[symbol];
        } catch (e) {
          this.symbolErrors[symbol] = { at: now, message: e.message };
          this.log.error(`${symbol}: ${e.message}`);
        }
      }

      this.state.lastTick = { at: now, actions };
      this.lastError = null;
      this.store.save();
      return this.state.lastTick;
    } catch (e) {
      this.lastError = { at: now, message: e.message };
      this.log.error(`Döngü hatası: ${e.message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  async handleSymbol(symbol, price, now) {
    if (!(price > 0)) throw new Error('fiyat alınamadı');
    if (!this.rules[symbol]) Object.assign(this.rules, await this.client.rulesFor([symbol]));

    // Yeni mum kapandıysa yeniden analiz et; sinyaller sadece mum kapanışında üretilir.
    let a = this.state.analysis[symbol];
    let fresh = false;
    if (!a || now >= a.nextCloseAt) {
      const klines = await this.client.klines(symbol, this.cfg.interval, FETCH_CANDLES + 1);
      const closed = klines.filter((k) => k.closeTime < now);
      if (closed.length < MIN_CANDLES) throw new Error(`yetersiz geçmiş veri (${closed.length} mum)`);
      const series = computeSeries(closed);
      const ev = this.evaluate(series, closed.length - 1, this.cfg, symbol);
      const last = closed.at(-1);
      a = {
        ...ev,
        candleCloseTime: last.closeTime,
        nextCloseAt: last.closeTime + this.intervalMs,
        analyzedAt: now,
      };
      this.state.analysis[symbol] = a;
      fresh = true;
    }
    a.price = price;

    const pos = this.state.positions[symbol];
    if (pos && Boolean(pos.dryRun) !== this.cfg.dryRun) {
      // Simülasyon pozisyonu gerçek satışa (ya da tersi) dönüşmesin.
      throw new Error(`pozisyon ${pos.dryRun ? 'DRY-RUN' : 'gerçek'} modda açılmış, şu anki mod farklı; işlem yapılmadı`);
    }
    const exitReason = exitCheck(pos, price, this.cfg);
    if (pos && (exitReason || (fresh && a.signal === 'SELL'))) {
      return (await this.sell(symbol, price, exitReason || `analiz skoru ${a.score}`)) ? 'SELL' : null;
    }
    if (!pos && fresh && a.signal === 'BUY' && this.state.universe.symbols.includes(symbol)) {
      const open = Object.keys(this.state.positions).length;
      if (open >= this.cfg.maxOpenPositions) {
        this.log.info(`${symbol}: alım sinyali var ama pozisyon limiti dolu (${open}/${this.cfg.maxOpenPositions})`);
        return null;
      }
      return (await this.buy(symbol, price, `analiz skoru ${a.score}`)) ? 'BUY' : null;
    }
    return null;
  }

  canBuyToday() {
    const d = today(this.now());
    if (this.state.daily.date !== d) this.state.daily = { date: d, trades: 0 };
    if (this.state.daily.trades >= this.cfg.maxTradesPerDay) {
      this.log.warn(`Günlük işlem limiti (${this.cfg.maxTradesPerDay}) doldu, alım atlandı`);
      return false;
    }
    return true;
  }

  async buy(symbol, price, reason) {
    if (!this.canBuyToday()) return false;
    const r = this.rules[symbol];
    const { orderQuoteAmount, dryRun } = this.cfg;
    if (r.minNotional && orderQuoteAmount < r.minNotional) {
      this.log.warn(`${symbol}: ORDER_QUOTE_AMOUNT borsa minimumunun (${r.minNotional}) altında`);
      return false;
    }
    const quoteQty = floorToStep(orderQuoteAmount, (10 ** -r.quotePrecision).toFixed(r.quotePrecision));
    let qty, avg, orderId;

    if (dryRun) {
      qty = Number(floorToStep(orderQuoteAmount / price, r.stepSize));
      avg = price;
      orderId = 'dry-run';
      if (this.cfg.apiKey) await this.client.testOrder({ symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty });
    } else {
      const bal = await this.client.balances();
      const free = bal[r.quoteAsset]?.free ?? 0;
      if (free < orderQuoteAmount) {
        this.log.warn(`${symbol}: yetersiz ${r.quoteAsset} bakiyesi (${free}), alım atlandı`);
        return false;
      }
      const res = await this.client.newOrder({ symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty });
      qty = Number(res.executedQty);
      avg = Number(res.cummulativeQuoteQty) / qty;
      orderId = res.orderId;
    }
    if (!(qty > 0)) {
      this.log.warn(`${symbol}: alım emri dolmadı`);
      return false;
    }

    this.state.positions[symbol] = { qty, entryPrice: avg, cost: qty * avg, openedAt: this.now(), dryRun };
    this.record({ symbol, side: 'BUY', qty, price: avg, orderId, reason });
    await this.notify(`${dryRun ? '[DRY-RUN] ' : ''}ALIM ${symbol}: ${qty} @ ${avg} (${reason})`);
    return true;
  }

  // Not: satışta günlük limit uygulanmaz; zarar durdur her zaman çalışabilmeli.
  async sell(symbol, price, reason) {
    const r = this.rules[symbol];
    const { dryRun } = this.cfg;
    const pos = this.state.positions[symbol];
    let qtyWanted = pos.qty;
    if (!dryRun) {
      const bal = await this.client.balances();
      qtyWanted = Math.min(pos.qty, bal[r.baseAsset]?.free ?? 0);
    }
    const qtyStr = floorToStep(qtyWanted, r.stepSize);
    const qtyNum = Number(qtyStr);
    if (qtyNum < r.minQty || qtyNum * price < r.minNotional) {
      // Pozisyon silinmez: bakiye kilitli olabilir ya da fiyat toparlanabilir; sonraki döngülerde tekrar denenir.
      const msg = `satılabilir miktar (${qtyStr}) borsa minimumunun altında; pozisyon korunuyor, tekrar denenecek`;
      if (pos.blocked?.reason !== msg) this.log.warn(`${symbol}: ${msg}`);
      pos.blocked = { at: this.now(), reason: msg };
      return false;
    }

    let avg, qty, orderId;
    if (dryRun) {
      qty = qtyNum;
      avg = price;
      orderId = 'dry-run';
      if (this.cfg.apiKey) await this.client.testOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: qtyStr });
    } else {
      const res = await this.client.newOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: qtyStr });
      qty = Number(res.executedQty);
      avg = Number(res.cummulativeQuoteQty) / qty;
      orderId = res.orderId;
    }

    const pnl = (avg - pos.entryPrice) * qty;
    this.state.realizedPnl += pnl;
    const remaining = Number(floorToStep(pos.qty - qty, r.stepSize));
    if (remaining >= r.minQty && remaining * price >= r.minNotional) {
      // Kısmi satış (ör. bakiyenin bir kısmı kilitliydi): kalan miktar izlenmeye devam eder.
      pos.qty = remaining;
      pos.cost = remaining * pos.entryPrice;
      pos.blocked = { at: this.now(), reason: `kısmi satış; ${remaining} kaldı` };
    } else {
      delete this.state.positions[symbol];
    }
    this.canBuyToday(); // gün değiştiyse sayacı sıfırlar
    this.record({ symbol, side: 'SELL', qty, price: avg, orderId, pnl, reason });
    await this.notify(
      `${dryRun ? '[DRY-RUN] ' : ''}SATIM ${symbol}: ${qty} @ ${avg} | K/Z: ${pnl.toFixed(4)} ${r.quoteAsset} | ${reason}`,
    );
    return true;
  }

  record(trade) {
    this.state.daily.trades += 1;
    this.state.history.unshift({ at: this.now(), dryRun: this.cfg.dryRun, ...trade });
    this.state.history = this.state.history.slice(0, 200);
    // Gerçekleşen işlem, döngünün geri kalanı beklenmeden hemen diske yazılır (çökmede kaybolmasın).
    this.store.save();
    this.log.info(
      `${trade.side} ${trade.symbol} ${trade.qty} @ ${trade.price}${trade.pnl !== undefined ? ` (K/Z ${trade.pnl.toFixed(4)})` : ''} — ${trade.reason}`,
    );
  }

  status() {
    const { listingCache, ...state } = this.state;
    return {
      running: this.running,
      lastError: this.lastError,
      symbolErrors: this.symbolErrors,
      quoteAsset: this.cfg.quoteAsset,
      ...state,
    };
  }
}
