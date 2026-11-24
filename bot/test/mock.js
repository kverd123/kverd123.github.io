// Gerçek ağa çıkmadan Binance REST yanıtlarını taklit eden sahte fetch.
export function mockBinance({ closes = [], price = 100, balances = { USDT: 1000, BTC: 0 } } = {}) {
  const state = { closes, price, balances: { ...balances }, calls: [] };
  const now = Date.now();

  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  state.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    state.calls.push({ method: opts.method, path: u.pathname, params: p, headers: opts.headers });
    switch (`${opts.method} ${u.pathname}`) {
      case 'GET /api/v3/time':
        return json(200, { serverTime: Date.now() });
      case 'GET /api/v3/ticker/price':
        return json(200, { symbol: p.symbol, price: String(state.price) });
      case 'GET /api/v3/klines': {
        // Son mum hâlâ açık (closeTime gelecekte) -> bot onu yok saymalı.
        const rows = state.closes.map((c, i) => {
          const closeTime = now - (state.closes.length - i) * 60_000 + 59_999;
          return [closeTime - 59_999, String(c), String(c), String(c), String(c), '1', closeTime];
        });
        rows.push([now, '999999', '999999', '999999', '999999', '1', now + 60_000]);
        return json(200, rows);
      }
      case 'GET /api/v3/exchangeInfo':
        return json(200, {
          symbols: [
            {
              symbol: p.symbol,
              status: 'TRADING',
              baseAsset: 'BTC',
              quoteAsset: 'USDT',
              quoteAssetPrecision: 8,
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
                { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
                { filterType: 'NOTIONAL', minNotional: '5.00000000' },
              ],
            },
          ],
        });
      case 'GET /api/v3/account':
        return json(200, {
          balances: Object.entries(state.balances).map(([asset, free]) => ({ asset, free: String(free), locked: '0' })),
        });
      case 'GET /api/v3/openOrders':
        return json(200, []);
      case 'POST /api/v3/order/test':
        return json(200, {});
      case 'POST /api/v3/order': {
        if (p.side === 'BUY') {
          const quote = Number(p.quoteOrderQty);
          const qty = Math.floor((quote / state.price) * 1e5) / 1e5;
          state.balances.USDT -= qty * state.price;
          state.balances.BTC = (state.balances.BTC || 0) + qty;
          return json(200, { orderId: 1, executedQty: String(qty), cummulativeQuoteQty: String(qty * state.price) });
        }
        const qty = Number(p.quantity);
        state.balances.BTC -= qty;
        state.balances.USDT += qty * state.price;
        return json(200, { orderId: 2, executedQty: String(qty), cummulativeQuoteQty: String(qty * state.price) });
      }
      default:
        return json(400, { code: -1, msg: `mock: bilinmeyen uç ${u.pathname}` });
    }
  };
  return state;
}

export const silentLogger = { info() {}, warn() {}, error() {} };
