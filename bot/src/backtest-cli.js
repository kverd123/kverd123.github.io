import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvFile, loadConfig } from './config.js';
import { runBacktest } from './backtest.js';
import { loadHistory, loadCsv, intervalMs } from './history.js';

const HELP = `
Kullanım: npm run backtest -- [seçenekler]

Veri:
  --days N            Son N gün (varsayılan 90)
  --from 2026-01-01   Başlangıç tarihi (UTC)
  --to   2026-06-30   Bitiş tarihi (UTC, dahil)
  --csv dosya.csv     İndirmek yerine data.binance.vision CSV dosyası kullan (birden fazla verilebilir)

Strateji (varsayılanlar .env dosyasından):
  --symbol BTCUSDT  --interval 15m  --fast 9  --slow 21
  --sl 3            Zarar durdur %  (0 = kapalı)
  --tp 6            Kâr al %        (0 = kapalı)
  --amount 20       İşlem başına quote tutarı
  --max-trades 10   Günlük en fazla işlem
  --fee 0.1         İşlem başına komisyon % (BNB ile ödeme: 0.075)
  --slippage 0.05   İşlem başına kayma %

Çıktı:
  --trades          Tüm işlemleri listele
  --sweep           Farklı SMA kombinasyonlarını karşılaştır
  --json            Sonucu JSON olarak yaz
`;

const DAY = 86400e3;

function parse() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      csv: { type: 'string', multiple: true },
      symbol: { type: 'string' }, interval: { type: 'string' },
      fast: { type: 'string' }, slow: { type: 'string' },
      sl: { type: 'string' }, tp: { type: 'string' }, amount: { type: 'string' },
      'max-trades': { type: 'string' }, fee: { type: 'string' }, slippage: { type: 'string' },
      trades: { type: 'boolean' }, sweep: { type: 'boolean' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return values;
}

function num(v, def, name) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} sayı olmalı`);
  return n;
}

function parseDate(s, name) {
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`--${name} YYYY-AA-GG biçiminde olmalı`);
  return t;
}

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '∞');
const sign = (n) => (n > 0 ? '+' : '') + f2(n);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const dt = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function printSummary(s, o, quote) {
  const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\n=== Backtest: ${o.symbol} ${o.interval} | SMA ${o.smaFast}/${o.smaSlow} | SL %${o.stopLossPct} TP %${o.takeProfitPct} ===`);
  line('Dönem', `${day(s.from)} → ${day(s.to)} (${s.candles} mum)`);
  line('İşlem başına tutar', `${o.orderQuoteAmount} ${quote} (komisyon %${o.feePct}, kayma %${o.slippagePct})`);
  console.log('');
  line('Toplam K/Z', `${sign(s.totalPnl)} ${quote}  (${sign(s.returnPct)}% işlem tutarına göre)`);
  line('Aynı dönemde al-tut', `${sign(s.buyHoldPct)}%`);
  line('İşlem sayısı', `${s.trades} (kazanan ${s.wins}, kaybeden ${s.losses})`);
  line('Kazanma oranı', `%${f2(s.winRatePct)}`);
  line('Ort. kazanç / ort. kayıp', `${sign(s.avgWin)} / ${sign(s.avgLoss)} ${quote}`);
  line('En iyi / en kötü işlem', `${sign(s.bestTrade)} / ${sign(s.worstTrade)} ${quote}`);
  line('Kâr faktörü', `${f2(s.profitFactor)}  (1'in altı = zarar)`);
  line('En büyük düşüş', `${f2(s.maxDrawdown)} ${quote} (%${f2(s.maxDrawdownPct)})`);
  line('Ödenen komisyon', `${f2(s.feesPaid)} ${quote}`);
  line('Piyasada kalma süresi', `%${f2(s.exposurePct)}`);
  line('Çıkış nedenleri', Object.entries(s.exitReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || '-');
}

function printTrades(trades) {
  console.log('\n  Giriş              Çıkış              Giriş fiyatı    Çıkış fiyatı         K/Z      %  Neden');
  for (const t of trades) {
    console.log(
      `  ${dt(t.entryAt)}  ${dt(t.exitAt)}  ${t.entryPrice.toFixed(4).padStart(13)}  ${t.exitPrice.toFixed(4).padStart(13)}` +
      `  ${sign(t.pnl).padStart(9)}  ${sign(t.pnlPct).padStart(6)}  ${t.reason}`,
    );
  }
}

function sweep(candles, base) {
  const fasts = [5, 9, 12, 20, 50];
  const slows = [21, 30, 50, 100, 200];
  const rows = [];
  for (const smaFast of fasts) {
    for (const smaSlow of slows) {
      if (smaSlow <= smaFast || candles.length < smaSlow + 2) continue;
      const { summary } = runBacktest(candles, { ...base, smaFast, smaSlow });
      rows.push({ smaFast, smaSlow, ...summary, current: smaFast === base.smaFast && smaSlow === base.smaSlow });
    }
  }
  rows.sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('\n=== SMA karşılaştırması (K/Z’ye göre sıralı) ===');
  console.log('   Hızlı/Yavaş   İşlem  Kazanma%       K/Z   Getiri%   Max düşüş%  Kâr faktörü');
  for (const r of rows) {
    console.log(
      `${r.current ? ' >' : '  '} ${`${r.smaFast}/${r.smaSlow}`.padStart(11)}  ${String(r.trades).padStart(6)}  ${f2(r.winRatePct).padStart(8)}` +
      `  ${sign(r.totalPnl).padStart(8)}  ${sign(r.returnPct).padStart(8)}  ${f2(r.maxDrawdownPct).padStart(11)}  ${f2(r.profitFactor).padStart(11)}`,
    );
  }
  console.log('  (> = .env dosyasındaki mevcut ayar)');
  console.log('\n  UYARI: Geçmişte en iyi çıkan ayar gelecekte de en iyi olmaz (aşırı uyum / overfitting).');
  console.log('  Seçtiğiniz ayarı mutlaka BAŞKA bir dönemde de test edin (ör. --from/--to ile).');
}

async function main() {
  const a = parse();
  if (a.help) return console.log(HELP);
  loadEnvFile();
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    cfg = loadConfig({}); // .env eksik/hatalıysa varsayılanlar
  }

  const o = {
    symbol: (a.symbol || cfg.symbol).toUpperCase(),
    interval: a.interval || cfg.interval,
    smaFast: num(a.fast, cfg.smaFast, 'fast'),
    smaSlow: num(a.slow, cfg.smaSlow, 'slow'),
    stopLossPct: num(a.sl, cfg.stopLossPct, 'sl'),
    takeProfitPct: num(a.tp, cfg.takeProfitPct, 'tp'),
    orderQuoteAmount: num(a.amount, cfg.orderQuoteAmount, 'amount'),
    maxTradesPerDay: num(a['max-trades'], cfg.maxTradesPerDay, 'max-trades'),
    feePct: num(a.fee, 0.1, 'fee'),
    slippagePct: num(a.slippage, 0.05, 'slippage'),
  };
  if (o.smaSlow <= o.smaFast) throw new Error('--slow, --fast değerinden büyük olmalı');

  let candles;
  if (a.csv) {
    candles = loadCsv(a.csv);
  } else {
    const step = intervalMs(o.interval);
    const endTime = a.to ? parseDate(a.to, 'to') + DAY : Math.floor(Date.now() / step) * step;
    const startTime = a.from ? parseDate(a.from, 'from') : endTime - num(a.days, 90, 'days') * DAY;
    if (startTime >= endTime) throw new Error('Başlangıç tarihi bitişten önce olmalı');
    if (!a.json) process.stderr.write(`Geçmiş veri indiriliyor: ${o.symbol} ${o.interval} ${day(startTime)} → ${day(endTime - 1)} ...`);
    candles = await loadHistory(
      { symbol: o.symbol, interval: o.interval, startTime, endTime, onProgress: (n) => !a.json && process.stderr.write(`\r  ${n} mum indirildi   `) },
      path.join(cfg.dataDir, 'history'),
    );
    if (!a.json) process.stderr.write('\n');
  }

  const quote = o.symbol.match(/(USDT|USDC|FDUSD|BUSD|TRY|EUR|BTC|ETH|BNB)$/)?.[1] || 'quote';
  const result = runBacktest(candles, o);

  if (a.json) {
    console.log(JSON.stringify({ options: o, summary: result.summary, trades: result.trades }, null, 2));
    return;
  }
  printSummary(result.summary, o, quote);
  if (a.trades) printTrades(result.trades);
  if (a.sweep) sweep(candles, o);
  console.log('\n  Not: Geçmiş performans gelecekteki sonuçları garanti etmez.\n');
}

main().catch((e) => {
  console.error(`\nBacktest başarısız: ${e.message}`);
  process.exit(1);
});
