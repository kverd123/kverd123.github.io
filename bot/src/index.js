import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, loadConfig } from './config.js';
import { BinanceClient } from './binance.js';
import { JsonStore } from './store.js';
import { TradingBot } from './bot.js';
import { createServer } from './server.js';
import { createLogger, createNotifier } from './notify.js';

// Tek coinli eski sürümden kalan açık pozisyon varsa kullanıcıyı uyar (otomatik taşınmaz).
function warnOldState(config, logger) {
  if (!fs.existsSync(config.dataDir)) return;
  for (const f of fs.readdirSync(config.dataDir)) {
    if (!/^state-.*\.json$/.test(f) || f.endsWith('-portfolio.json')) continue;
    try {
      const old = JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8'));
      if (old.position) {
        logger.warn(`Eski sürümden açık pozisyon var (${f}: ${old.position.qty} @ ${old.position.entryPrice}). Bu pozisyonu yeni bot yönetmez; gerekirse Binance'te elle kapatın.`);
      }
    } catch {}
  }
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger();

  if (config.binanceEnv === 'live' && !config.dryRun) {
    logger.warn('!!! CANLI MOD: Gerçek parayla emir gönderilecek !!!');
  }

  const client = new BinanceClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, apiSecret: config.apiSecret });
  // Simülasyon ve gerçek işlemler ayrı dosyalarda tutulur: DRY_RUN değişince pozisyonlar karışmaz.
  const mode = config.dryRun ? 'dryrun' : 'real';
  const store = new JsonStore(path.join(config.dataDir, `state-${config.binanceEnv}-${mode}-portfolio.json`));
  warnOldState(config, logger);
  const notify = createNotifier(config, logger);
  const bot = new TradingBot({ client, config, store, notify, logger });

  // Tek seferlik çalıştırma (cron ile kullanım için): npm run tick
  if (process.argv.includes('--once')) {
    const result = await bot.tick();
    console.log(JSON.stringify({ tick: result, lastError: bot.lastError }, null, 2));
    process.exit(bot.lastError ? 1 : 0);
  }

  const server = createServer({ bot, client, config, logger }); // token kontrolü ağdan önce
  await bot.init();
  server.listen(config.port, config.host, () => {
    logger.info(`API: http://${config.host}:${config.port}`);
  });
  if (config.autoStart) bot.start();

  const shutdown = () => {
    bot.stop();
    store.save();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`Başlatılamadı: ${e.message}`);
  process.exit(1);
});
