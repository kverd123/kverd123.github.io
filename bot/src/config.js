import fs from 'node:fs';
import path from 'node:path';

const BASE_URLS = {
  testnet: 'https://testnet.binance.vision',
  live: 'https://api.binance.com',
};

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function num(v, def, name) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} sayı olmalı (gelen: "${v}")`);
  return n;
}

/** .env dosyasını (varsa) yükler; zaten tanımlı ortam değişkenlerinin üzerine yazmaz. */
export function loadEnvFile(file = path.resolve(process.cwd(), '.env')) {
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

export function loadConfig(env = process.env) {
  const binanceEnv = (env.BINANCE_ENV || 'testnet').toLowerCase();
  if (!BASE_URLS[binanceEnv]) {
    throw new Error(`BINANCE_ENV "testnet" veya "live" olmalı (gelen: "${env.BINANCE_ENV}")`);
  }

  const cfg = {
    binanceEnv,
    baseUrl: env.BINANCE_BASE_URL || BASE_URLS[binanceEnv],
    apiKey: env.BINANCE_API_KEY || '',
    apiSecret: env.BINANCE_API_SECRET || '',
    dryRun: bool(env.DRY_RUN, true),

    symbol: (env.SYMBOL || 'BTCUSDT').toUpperCase(),
    interval: env.KLINE_INTERVAL || '15m',
    smaFast: num(env.SMA_FAST, 9, 'SMA_FAST'),
    smaSlow: num(env.SMA_SLOW, 21, 'SMA_SLOW'),
    tickSeconds: num(env.TICK_SECONDS, 60, 'TICK_SECONDS'),

    orderQuoteAmount: num(env.ORDER_QUOTE_AMOUNT, 20, 'ORDER_QUOTE_AMOUNT'),
    maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 10, 'MAX_TRADES_PER_DAY'),
    stopLossPct: num(env.STOP_LOSS_PCT, 3, 'STOP_LOSS_PCT'),
    takeProfitPct: num(env.TAKE_PROFIT_PCT, 6, 'TAKE_PROFIT_PCT'),

    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 8787, 'PORT'),
    authToken: env.API_AUTH_TOKEN || '',
    allowedOrigin: env.ALLOWED_ORIGIN || '',
    autoStart: bool(env.AUTO_START, false),

    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',

    dataDir: env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  };

  if (cfg.smaFast < 1 || cfg.smaSlow <= cfg.smaFast) {
    throw new Error('SMA_FAST >= 1 ve SMA_SLOW > SMA_FAST olmalı');
  }
  if (cfg.tickSeconds < 5) throw new Error('TICK_SECONDS en az 5 olmalı');
  if (cfg.orderQuoteAmount <= 0) throw new Error('ORDER_QUOTE_AMOUNT pozitif olmalı');
  if (!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret)) {
    throw new Error('DRY_RUN=false için BINANCE_API_KEY ve BINANCE_API_SECRET gerekli');
  }
  return cfg;
}

/** Durum ekranında gösterilebilecek, gizli bilgi içermeyen özet. */
export function publicConfig(cfg) {
  const { apiKey, apiSecret, authToken, telegramToken, ...rest } = cfg;
  return { ...rest, hasApiKey: Boolean(apiKey && apiSecret), telegram: Boolean(telegramToken) };
}
