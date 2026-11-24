import http from 'node:http';
import crypto from 'node:crypto';
import { publicConfig } from './config.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Bot ve hesap için küçük bir HTTP API.
 *   GET  /health                -> token gerektirmez
 *   GET  /api/status            -> bot durumu, pozisyon, son işlemler
 *   GET  /api/price?symbol=     -> anlık fiyat
 *   GET  /api/balance           -> sıfır olmayan bakiyeler
 *   GET  /api/orders/open       -> açık emirler
 *   GET  /api/klines            -> grafik için kapanış fiyatları + SMA
 *   POST /api/bot/start | stop | tick
 * /api/* uçları "Authorization: Bearer <API_AUTH_TOKEN>" ister.
 */
export function createServer({ bot, client, config, logger }) {
  if (!config.authToken || config.authToken.length < 16) {
    throw new Error('API_AUTH_TOKEN en az 16 karakter olmalı (.env.example dosyasına bakın)');
  }

  const routes = {
    'GET /api/status': async () => ({ config: publicConfig(config), bot: bot.status() }),
    'GET /api/price': async (url) => {
      const symbol = (url.searchParams.get('symbol') || config.symbol).toUpperCase();
      if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw Object.assign(new Error('geçersiz sembol'), { status: 400 });
      return { symbol, price: await client.price(symbol) };
    },
    'GET /api/balance': async () => ({ balances: await client.balances() }),
    'GET /api/orders/open': async (url) => ({
      orders: await client.openOrders((url.searchParams.get('symbol') || config.symbol).toUpperCase()),
    }),
    'GET /api/klines': async () => {
      const { symbol, interval, smaFast, smaSlow } = config;
      const now = Date.now();
      const rows = (await client.klines(symbol, interval, 120)).filter((k) => k.closeTime < now);
      const closes = rows.map((k) => k.close);
      const smaAt = (p, i) => (i + 1 < p ? null : closes.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p);
      return {
        symbol,
        interval,
        candles: rows.map((k, i) => ({ t: k.closeTime, c: k.close, fast: smaAt(smaFast, i), slow: smaAt(smaSlow, i) })),
      };
    },
    'POST /api/bot/start': async () => ({ started: bot.start() }),
    'POST /api/bot/stop': async () => ({ stopped: bot.stop() }),
    'POST /api/bot/tick': async () => ({ tick: await bot.tick(), lastError: bot.lastError }),
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
