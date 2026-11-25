// Gerçek ağa çıkmadan Binance REST yanıtlarını taklit eden sahte fetch (çoklu coin).
//
// markets: { SYMBOL: { price, closes?, volume?, listedAt?, base? } }
const DAY = 86400e3;
const H4 = 4 * 3600e3;

export function mockBinance({ markets = {}, balances = { USDT: 1000 } } = {}) {
  const state = { markets, balances: { ...balances }, calls: [], orders: [] };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const baseOf = (sym) => markets[sym]?.base ?? sym.replace(/USDT$/, '');

  const symbolInfo = (sym) => ({
    symbol: sym,
    status: 'TRADING',
    isSpotTradingAllowed: true,
    baseAsset: baseOf(sym),
    quoteAsset: 'USDT',
    quoteAssetPrecision: 8,
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
      { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
      { filterType: 'NOTIONAL', minNotional: '5.00000000' },
    ],
  });

  state.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    state.calls.push({ method: opts.method, path: u.pathname, params: p, headers: opts.headers });
    const list = p.symbols ? JSON.parse(p.symbols) : null;
    const unknown = (list || (p.symbol ? [p.symbol] : [])).find((s) => !markets[s]);
    if (unknown) return json(400, { code: -1121, msg: `Invalid symbol: ${unknown}` });

    switch (`${opts.method} ${u.pathname}`) {
      case 'GET /api/v3/time':
        return json(200, { serverTime: Date.now() });
      case 'GET /api/v3/ticker/price':
        if (list) return json(200, list.map((s) => ({ symbol: s, price: String(markets[s].price) })));
        return json(200, { symbol: p.symbol, price: String(markets[p.symbol].price) });
      case 'GET /api/v3/ticker/24hr':
        return json(200, Object.entries(markets).map(([s, m]) => ({
          symbol: s, lastPrice: String(m.price), highPrice: String(m.high ?? m.price * 1.05),
          lowPrice: String(m.low ?? m.price * 0.95), quoteVolume: String(m.volume ?? 1000),
        })));
      case 'GET /api/v3/exchangeInfo':
        return json(200, { symbols: (list || Object.keys(markets)).map(symbolInfo) });
      case 'GET /api/v3/klines': {
        const m = markets[p.symbol];
        if (p.interval === '1d' && p.startTime === '0') {
          const t = m.listedAt ?? Date.now() - 1000 * DAY;
          return json(200, [[t, '1', '1', '1', '1', '1', t + DAY - 1]]);
        }
        // Kapanmış mumlar + sonda henüz kapanmamış bir mum (bot bunu yok saymalı)
        const closes = m.closes ?? [m.price];
        const end = Math.floor(Date.now() / H4) * H4;
        const rows = closes.map((c, i) => {
          const open = end - (closes.length - i) * H4;
          const o = i ? closes[i - 1] : c;
          return [open, String(o), String(Math.max(o, c)), String(Math.min(o, c)), String(c), '1', open + H4 - 1];
        });
        const lc = String(closes.at(-1));
        rows.push([end, lc, lc, lc, lc, '1', end + H4 - 1]);
        return json(200, rows.slice(-Number(p.limit || 500)));
      }
      case 'GET /api/v3/account':
        return json(200, {
          balances: Object.entries(state.balances).map(([asset, free]) => ({ asset, free: String(free), locked: '0' })),
        });
      case 'GET /api/v3/openOrders':
        return json(200, []);
      case 'POST /api/v3/order/test':
        return json(200, {});
      case 'POST /api/v3/order': {
        const m = markets[p.symbol];
        const base = baseOf(p.symbol);
        state.orders.push(p);
        if (p.side === 'BUY') {
          const qty = Math.floor((Number(p.quoteOrderQty) / m.price) * 1e5) / 1e5;
          state.balances.USDT -= qty * m.price;
          state.balances[base] = (state.balances[base] || 0) + qty;
          return json(200, { orderId: state.orders.length, executedQty: String(qty), cummulativeQuoteQty: String(qty * m.price) });
        }
        const qty = Number(p.quantity);
        state.balances[base] -= qty;
        state.balances.USDT += qty * m.price;
        return json(200, { orderId: state.orders.length, executedQty: String(qty), cummulativeQuoteQty: String(qty * m.price) });
      }
      default:
        return json(400, { code: -1, msg: `mock: bilinmeyen uç ${u.pathname}` });
    }
  };
  return state;
}

/** Analizi atlayıp her coin için istenen sinyali döndüren sahte değerlendirici. */
export function fixedSignals(signals) {
  return (_series, _i, _opts, symbol) => {
    const signal = signals[symbol] ?? 'HOLD';
    return { score: signal === 'BUY' ? 4 : signal === 'SELL' ? -3 : 0, signal, ready: true, methods: [] };
  };
}

/** Göstergelerin hesaplanabilmesi için yeterince uzun, hafif yükselen fiyat serisi. */
export const longSeries = (base, n = 260) => Array.from({ length: n }, (_, i) => base * (1 + i / 1000));

export const silentLogger = { info() {}, warn() {}, error() {} };
