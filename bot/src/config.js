import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDED_ASSETS } from './universe.js';

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

const list = (v) => (v ? v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : []);

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

    // Coin evreni: SYMBOLS doluysa sabit liste, boşsa hacme göre ilk TOP_N coin
    symbols: list(env.SYMBOLS),
    topN: num(env.TOP_N, 10, 'TOP_N'),
    quoteAsset: (env.QUOTE_ASSET || 'USDT').toUpperCase(),
    excludeAssets: [...DEFAULT_EXCLUDED_ASSETS, ...list(env.EXCLUDE_ASSETS)],
    minListingDays: num(env.MIN_LISTING_DAYS, 365, 'MIN_LISTING_DAYS'),
    universeRefreshHours: num(env.UNIVERSE_REFRESH_HOURS, 24, 'UNIVERSE_REFRESH_HOURS'),

    // Analiz
    interval: env.KLINE_INTERVAL || '4h',
    buyScore: num(env.BUY_SCORE, 3, 'BUY_SCORE'),
    sellScore: num(env.SELL_SCORE, -2, 'SELL_SCORE'),
    requireTrend: bool(env.REQUIRE_TREND, true),
    tickSeconds: num(env.TICK_SECONDS, 60, 'TICK_SECONDS'),

    // Risk
    orderQuoteAmount: num(env.ORDER_QUOTE_AMOUNT, 20, 'ORDER_QUOTE_AMOUNT'),
    maxOpenPositions: num(env.MAX_OPEN_POSITIONS, 5, 'MAX_OPEN_POSITIONS'),
    maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 20, 'MAX_TRADES_PER_DAY'),
    stopLossPct: num(env.STOP_LOSS_PCT, 8, 'STOP_LOSS_PCT'),
    takeProfitPct: num(env.TAKE_PROFIT_PCT, 0, 'TAKE_PROFIT_PCT'),

    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 8787, 'PORT'),
    authToken: env.API_AUTH_TOKEN || '',
    allowedOrigin: env.ALLOWED_ORIGIN || '',
    autoStart: bool(env.AUTO_START, false),

    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',

    dataDir: env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  };

  if (cfg.topN < 1 || cfg.topN > 50) throw new Error('TOP_N 1 ile 50 arasında olmalı');
  if (cfg.buyScore < 1 || cfg.buyScore > 5) throw new Error('BUY_SCORE 1 ile 5 arasında olmalı');
  if (cfg.sellScore > 0 || cfg.sellScore < -5) throw new Error('SELL_SCORE -5 ile 0 arasında olmalı');
  if (cfg.tickSeconds < 5) throw new Error('TICK_SECONDS en az 5 olmalı');
  if (cfg.orderQuoteAmount <= 0) throw new Error('ORDER_QUOTE_AMOUNT pozitif olmalı');
  if (cfg.maxOpenPositions < 1) throw new Error('MAX_OPEN_POSITIONS en az 1 olmalı');
  if (!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret)) {
    throw new Error('DRY_RUN=false için BINANCE_API_KEY ve BINANCE_API_SECRET gerekli');
  }
  return cfg;
}

/** Durum ekranında gösterilebilecek, gizli bilgi içermeyen özet. */
export function publicConfig(cfg) {
  const { apiKey, apiSecret, authToken, telegramToken, telegramChatId, ...rest } = cfg;
  return { ...rest, hasApiKey: Boolean(apiKey && apiSecret), telegram: Boolean(telegramToken) };
}
