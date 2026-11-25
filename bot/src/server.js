import http from 'node:http';
import crypto from 'node:crypto';
import { publicConfig } from './config.js';
import { computeSeries, FETCH_CANDLES } from './analysis.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Bot ve hesap için küçük bir HTTP API.
 *   GET  /health                -> token gerektirmez
 *   GET  /api/status             -> bot durumu, coin listesi, analizler, pozisyonlar, işlemler
 *   GET  /api/price?symbol=      -> anlık fiyat
 *   GET  /api/balance            -> sıfır olmayan bakiyeler
 *   GET  /api/orders/open        -> açık emirler (tüm semboller)
 *   GET  /api/klines?symbol=     -> grafik verisi (kapanış, EMA'lar, Bollinger, RSI)
 *   POST /api/bot/start | stop | tick
 *   POST /api/universe/refresh   -> coin listesini hemen yenile
 * /api/* uçları "Authorization: Bearer <API_AUTH_TOKEN>" ister.
 */
export function createServer({ bot, client, config, logger }) {
  if (!config.authToken || config.authToken.length < 16) {
    throw new Error('API_AUTH_TOKEN en az 16 karakter olmalı (.env.example dosyasına bakın)');
  }

  const symbolParam = (url, def) => {
    const symbol = (url.searchParams.get('symbol') || def || '').toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw Object.assign(new Error('geçersiz sembol'), { status: 400 });
    return symbol;
  };

  const routes = {
    'GET /api/status': async () => ({ config: publicConfig(config), bot: bot.status() }),
    'GET /api/price': async (url) => {
      const symbol = symbolParam(url, bot.state.universe.symbols[0]);
      return { symbol, price: await client.price(symbol) };
    },
    'GET /api/balance': async () => ({ balances: await client.balances() }),
    'GET /api/orders/open': async (url) => ({
      orders: await client.openOrders(url.searchParams.get('symbol') ? symbolParam(url) : undefined),
    }),
    // Grafik: kapanışlar + EMA'lar + Bollinger bantları + RSI
    'GET /api/klines': async (url) => {
      const symbol = symbolParam(url, bot.state.universe.symbols[0]);
      const now = Date.now();
      const rows = (await client.klines(symbol, config.interval, FETCH_CANDLES)).filter((k) => k.closeTime < now);
      const s = computeSeries(rows);
      const from = Math.max(0, rows.length - 150);
      const r = (v) => (v === null ? null : Number(v.toPrecision(8)));
      return {
        symbol,
        interval: config.interval,
        candles: rows.slice(from).map((k, j) => {
          const i = from + j;
          return {
            t: k.closeTime, c: k.close, ema200: r(s.ema200[i]), emaFast: r(s.emaFast[i]), emaSlow: r(s.emaSlow[i]),
            bbU: r(s.bb.upper[i]), bbL: r(s.bb.lower[i]), rsi: r(s.rsi[i]),
          };
        }),
      };
    },
    'POST /api/bot/start': async () => ({ started: bot.start() }),
    'POST /api/bot/stop': async () => ({ stopped: bot.stop() }),
    'POST /api/bot/tick': async () => ({ tick: await bot.tick(), lastError: bot.lastError }),
    'POST /api/universe/refresh': async () => {
      await bot.refreshUniverse(true);
      return { universe: bot.state.universe };
    },
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (config.allowedOrigin) {
      headers['access-control-allow-origin'] = config.allowedOrigin;
      headers['access-control-allow-headers'] = 'authorization, content-type';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      headers.vary = 'Origin';
      // Chrome: https sayfadan localhost/özel ağa erişim izni (Private Network Access)
      headers['access-control-allow-private-network'] = 'true';
    }
    const send = (status, body) => {
      res.writeHead(status, headers);
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') return send(204);
    if (url.pathname === '/health') return send(200, { ok: true });

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: 'bulunamadı' });

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, config.authToken)) return send(401, { error: 'yetkisiz' });

    try {
      send(200, await handler(url));
    } catch (e) {
      logger.error(`${req.method} ${url.pathname}: ${e.message}`);
      send(e.status || 502, { error: e.message });
    }
  });
}
