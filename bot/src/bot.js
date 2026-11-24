import { floorToStep } from './binance.js';
import { smaCrossSignal, exitCheck } from './strategy.js';

const today = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Basit spot botu: SMA kesişiminde alır, ters kesişimde veya zarar durdur / kâr al
 * seviyesinde satar. Aynı anda en fazla bir pozisyon tutar ve sadece kendi aldığı
 * miktarı satar (hesaptaki diğer varlıklarınıza dokunmaz).
 */
export class TradingBot {
  constructor({ client, config, store, notify = async () => {}, logger, now = () => Date.now() }) {
    this.client = client;
    this.cfg = config;
    this.store = store;
    this.notify = notify;
    this.log = logger;
    this.now = now;
    this.rules = null;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.lastError = null;
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
    this.rules = await this.client.symbolRules(this.cfg.symbol);
    if (this.rules.status !== 'TRADING') {
      throw new Error(`${this.cfg.symbol} şu an işleme kapalı (durum: ${this.rules.status})`);
    }
    if (this.rules.minNotional && this.cfg.orderQuoteAmount < this.rules.minNotional) {
      throw new Error(
        `ORDER_QUOTE_AMOUNT (${this.cfg.orderQuoteAmount}) borsanın minimumunun altında (${this.rules.minNotional} ${this.rules.quoteAsset})`,
      );
    }
    this.log.info(
      `Hazır: ${this.cfg.symbol} ${this.cfg.interval} | ortam=${this.cfg.binanceEnv} | dryRun=${this.cfg.dryRun}`,
    );
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

  /** Bir karar döngüsü. Hataları yakalar, döngüyü kırmaz. */
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (!this.rules) await this.init();
      const { symbol, interval, smaFast, smaSlow } = this.cfg;
      const now = this.now();

      const klines = await this.client.klines(symbol, interval, smaSlow + 5);
      const closes = klines.filter((k) => k.closeTime < now).map((k) => k.close);
      const sig = smaCrossSignal(closes, smaFast, smaSlow);
      const price = await this.client.price(symbol);
      const exitReason = exitCheck(this.state.position, price, this.cfg);

      let action = 'HOLD';
      if (!this.state.position && sig.signal === 'BUY') {
        action = (await this.buy(price)) ? 'BUY' : 'HOLD';
      } else if (this.state.position && (sig.signal === 'SELL' || exitReason)) {
        action = (await this.sell(price, exitReason || sig.reason)) ? 'SELL' : 'HOLD';
      }

      this.state.lastTick = { at: now, price, signal: sig.signal, fast: sig.fast, slow: sig.slow, action };
      this.lastError = null;
      this.store.save();
      return this.state.lastTick;
    } catch (e) {
      this.lastError = { at: this.now(), message: e.message };
      this.log.error(`Döngü hatası: ${e.message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  canTrade() {
    const d = today(this.now());
    if (this.state.daily.date !== d) this.state.daily = { date: d, trades: 0 };
    if (this.state.daily.trades >= this.cfg.maxTradesPerDay) {
      this.log.warn(`Günlük işlem limiti (${this.cfg.maxTradesPerDay}) doldu, işlem atlandı`);
      return false;
    }
    return true;
  }

  async buy(price) {
    if (!this.canTrade()) return false;
    const { symbol, orderQuoteAmount, dryRun } = this.cfg;
    const quoteQty = floorToStep(orderQuoteAmount, (10 ** -this.rules.quotePrecision).toFixed(this.rules.quotePrecision));
    let qty, avg, orderId;

    if (dryRun) {
      qty = Number(floorToStep(orderQuoteAmount / price, this.rules.stepSize));
      avg = price;
      orderId = 'dry-run';
      if (this.cfg.apiKey) {
        await this.client.testOrder({ symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty });
      }
    } else {
      const bal = await this.client.balances();
      const free = bal[this.rules.quoteAsset]?.free ?? 0;
      if (free < orderQuoteAmount) {
        this.log.warn(`Yetersiz ${this.rules.quoteAsset} bakiyesi (${free}), alım atlandı`);
        return false;
      }
      const res = await this.client.newOrder({ symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty });
      qty = Number(res.executedQty);
      avg = Number(res.cummulativeQuoteQty) / qty;
      orderId = res.orderId;
    }
    if (!(qty > 0)) {
      this.log.warn('Alım emri dolmadı');
      return false;
    }

    this.state.position = { qty, entryPrice: avg, openedAt: this.now(), dryRun };
    this.record({ side: 'BUY', qty, price: avg, orderId });
    await this.notify(`${dryRun ? '[DRY-RUN] ' : ''}ALIM ${symbol}: ${qty} @ ${avg.toFixed(4)}`);
    return true;
  }

  // Not: satışta günlük limit uygulanmaz; zarar durdur her zaman çalışabilmeli.
  async sell(price, reason) {
    this.canTrade(); // gün değiştiyse sayacı sıfırlar
    const { symbol, dryRun } = this.cfg;
    const pos = this.state.position;
    let qtyWanted = pos.qty;
    if (!dryRun) {
      const bal = await this.client.balances();
      qtyWanted = Math.min(pos.qty, bal[this.rules.baseAsset]?.free ?? 0);
    }
    const qtyStr = floorToStep(qtyWanted, this.rules.stepSize);
    const qtyNum = Number(qtyStr);
    if (qtyNum < this.rules.minQty || qtyNum * price < this.rules.minNotional) {
      this.log.warn(`Satılacak miktar borsa minimumunun altında (${qtyStr}); pozisyon kapatıldı olarak işaretlendi`);
      this.state.position = null;
      return false;
    }

    let avg, qty, orderId;
    if (dryRun) {
      qty = qtyNum;
      avg = price;
      orderId = 'dry-run';
      if (this.cfg.apiKey) {
        await this.client.testOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: qtyStr });
      }
    } else {
      const res = await this.client.newOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: qtyStr });
      qty = Number(res.executedQty);
      avg = Number(res.cummulativeQuoteQty) / qty;
      orderId = res.orderId;
    }

    const pnl = (avg - pos.entryPrice) * qty;
    this.state.realizedPnl += pnl;
    this.state.position = null;
    this.record({ side: 'SELL', qty, price: avg, orderId, pnl, reason });
    await this.notify(
      `${dryRun ? '[DRY-RUN] ' : ''}SATIM ${symbol}: ${qty} @ ${avg.toFixed(4)} | K/Z: ${pnl.toFixed(4)} ${this.rules.quoteAsset} | ${reason}`,
    );
    return true;
  }

  record(trade) {
    this.state.daily.trades += 1;
    this.state.history.unshift({ at: this.now(), dryRun: this.cfg.dryRun, ...trade });
    this.state.history = this.state.history.slice(0, 100);
    this.log.info(`${trade.side} ${trade.qty} @ ${trade.price}${trade.pnl !== undefined ? ` (K/Z ${trade.pnl.toFixed(4)})` : ''}`);
  }

  status() {
    return {
      running: this.running,
      rules: this.rules,
      lastError: this.lastError,
      ...this.state,
    };
  }
}
