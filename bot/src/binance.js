import crypto from 'node:crypto';

export class BinanceError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'BinanceError';
    this.status = status;
    this.code = code;
  }
}

/** Değeri adım büyüklüğüne (stepSize / tickSize) aşağı yuvarlar, string döner. */
export function floorToStep(value, step) {
  const s = Number(step);
  if (!s) return String(value);
  const decimals = (String(step).split('.')[1] || '').replace(/0+$/, '').length;
  const floored = Math.floor(value / s + 1e-9) * s;
  return floored.toFixed(decimals);
}

/** Minimal, bağımlılıksız Binance Spot REST istemcisi. */
export class BinanceClient {
  constructor({ baseUrl, apiKey = '', apiSecret = '', recvWindow = 5000, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.timeOffset = 0;
  }

  sign(query) {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  async request(method, path, params = {}, { signed = false } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    }
    const headers = {};
    if (signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new BinanceError('Bu işlem için BINANCE_API_KEY ve BINANCE_API_SECRET gerekli');
      }
      qs.append('recvWindow', String(this.recvWindow));
      qs.append('timestamp', String(Date.now() + this.timeOffset));
      qs.append('signature', this.sign(qs.toString()));
    }
    if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey;

    const query = qs.toString();
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const res = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { msg: text };
    }
    if (!res.ok) {
      throw new BinanceError(`Binance ${res.status}: ${data.msg || text}`, { status: res.status, code: data.code });
    }
    return data;
  }

  // ---- Herkese açık uçlar ----
  ping() {
    return this.request('GET', '/api/v3/ping');
  }

  /** Yerel saat ile Binance saati arasındaki farkı ayarlar (imza hatalarını önler). */
  async syncTime() {
    const { serverTime } = await this.request('GET', '/api/v3/time');
    this.timeOffset = serverTime - Date.now();
    return this.timeOffset;
  }

  async price(symbol) {
    const { price } = await this.request('GET', '/api/v3/ticker/price', { symbol });
    return Number(price);
  }

  async klines(symbol, interval, limit = 100) {
    const rows = await this.request('GET', '/api/v3/klines', { symbol, interval, limit });
    return rows.map((r) => ({
      openTime: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: r[6],
    }));
  }

  /** Sembolün işlem kurallarını (min. miktar, adım, min. tutar) döner. */
  async symbolRules(symbol) {
    const info = await this.request('GET', '/api/v3/exchangeInfo', { symbol });
    const s = info.symbols?.[0];
    if (!s) throw new BinanceError(`Sembol bulunamadı: ${symbol}`);
    const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
    return {
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      quotePrecision: s.quoteAssetPrecision ?? s.quotePrecision ?? 8,
      stepSize: f.LOT_SIZE?.stepSize ?? '0.00000001',
      minQty: Number(f.LOT_SIZE?.minQty ?? 0),
      tickSize: f.PRICE_FILTER?.tickSize ?? '0.01',
      minNotional: Number(f.NOTIONAL?.minNotional ?? f.MIN_NOTIONAL?.minNotional ?? 0),
    };
  }

  // ---- Hesap uçları (imzalı) ----
  account() {
    return this.request('GET', '/api/v3/account', { omitZeroBalances: true }, { signed: true });
  }

  /** { ASSET: { free, locked } } biçiminde, sıfır olmayan bakiyeler. */
  async balances() {
    const acc = await this.account();
    const out = {};
    for (const b of acc.balances || []) {
      const free = Number(b.free);
      const locked = Number(b.locked);
      if (free > 0 || locked > 0) out[b.asset] = { free, locked };
    }
    return out;
  }

  openOrders(symbol) {
    return this.request('GET', '/api/v3/openOrders', { symbol }, { signed: true });
  }

  newOrder(params) {
    return this.request('POST', '/api/v3/order', { newOrderRespType: 'FULL', ...params }, { signed: true });
  }

  /** Emri doğrular ama borsaya göndermez. */
  testOrder(params) {
    return this.request('POST', '/api/v3/order/test', params, { signed: true });
  }

  cancelOrder(symbol, orderId) {
    return this.request('DELETE', '/api/v3/order', { symbol, orderId }, { signed: true });
  }
}
