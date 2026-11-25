import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvFile, loadConfig } from './config.js';
import { runBacktest, intrabarEvaluator } from './backtest.js';
import { loadHistory, loadCsv, intervalMs, HISTORY_BASE_URL } from './history.js';
import { BinanceClient } from './binance.js';
import { selectUniverse } from './universe.js';
import { FETCH_CANDLES } from './analysis.js';

const HELP = `
Kullanım: npm run backtest -- [seçenekler]

Coinler (varsayılan: .env, o da boşsa hacme göre BUGÜNKÜ ilk 10):
  --top 10                 Hacme göre ilk N coin
  --symbols BTCUSDT,ETHUSDT  Sabit liste
  --csv BTCUSDT=dosya.csv  İndirmek yerine CSV kullan (birden fazla verilebilir)

Dönem:
  --days N            Son N gün (varsayılan 365)
  --from 2025-01-01   Başlangıç tarihi (UTC)
  --to   2025-12-31   Bitiş tarihi (UTC, dahil)

Strateji (varsayılanlar .env dosyasından):
  --interval 4h       Mum aralığı
  --buy-score 3       Alım için gereken en az skor (1..5)
  --sell-score -2     Satış skoru (-5..0)
  --no-trend          Alımda "fiyat EMA200 üstünde" şartını kaldır
  --max-open 5        Aynı anda en fazla açık pozisyon
  --sl 8 --tp 0       Zarar durdur / kâr al % (0 = kapalı)
  --amount 20         Pozisyon başına quote tutarı
  --max-trades 20     Günlük en fazla işlem
  --fee 0.1 --slippage 0.05
  --analysis-minutes 30  Analizi mum kapanışını beklemeden her N dakikada yap (oluşan mum
                      anlık fiyatla). 15 dakikalık veri indirilir; N 15'in katı olmalı.
                      0 = sadece mum kapanışında (varsayılan .env'deki ANALYSIS_MINUTES)
  --direction long    long | short | both (short = vadeli işlem simülasyonu, 1x kaldıraç)
  --short-score 3     Short açmak için skor ≤ -N (ve fiyat EMA200 altında)
  --cover-score 2     Short kapatmak için skor ≥ N
  --funding 0.01      Short/both için 8 saatlik fonlama ücreti % (kötümser: her yön öder)
                      Short/both modunda komisyon varsayılanı %0.05 (futures)

Çıktı:
  --trades            Tüm işlemleri listele
  --sweep             Farklı skor eşiği / zarar durdur ayarlarını karşılaştır
  --json              Sonucu JSON olarak yaz
`;

const DAY = 86400e3;

function parse() {
  const s = { type: 'string' };
  const { values } = parseArgs({
    options: {
      top: s, symbols: s, csv: { type: 'string', multiple: true },
      days: s, from: s, to: s, interval: s,
      'buy-score': s, 'sell-score': s, 'no-trend': { type: 'boolean' },
      'max-open': s, sl: s, tp: s, amount: s, 'max-trades': s, fee: s, slippage: s,
      'analysis-minutes': s, direction: s, 'short-score': s, 'cover-score': s, funding: s,
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

function printSummary(s, o, q) {
  const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(
    `\n=== Backtest [${o.direction}]: ${s.symbols} coin | ${o.interval}${o.analysisMinutes ? `, analiz her ${o.analysisMinutes} dk` : ''} | long ≥${o.buyScore}/≤${o.sellScore}` +
    `${o.direction !== 'long' ? ` short ≤-${o.shortScore}/≥${o.coverScore}` : ''}${o.requireTrend ? ' + trend' : ''} | SL %${o.stopLossPct} TP %${o.takeProfitPct} ===`,
  );
  line('Dönem', `${day(s.from)} → ${day(s.to)} (${s.candles} mum)`);
  line('Sermaye', `${f2(s.capital)} ${q} (${o.maxOpenPositions} pozisyon × ${o.orderQuoteAmount}; komisyon %${o.feePct}, kayma %${o.slippagePct})`);
  console.log('');
  line('Toplam K/Z', `${sign(s.totalPnl)} ${q}  (${sign(s.returnPct)}% sermayeye göre)`);
  line('Aynı coinleri al-tut (eşit)', `${sign(s.buyHoldPct)}%`);
  line('İşlem sayısı', `${s.trades} (kazanan ${s.wins}, kaybeden ${s.losses})`);
  line('Kazanma oranı', `%${f2(s.winRatePct)}`);
  line('Ort. kazanç / ort. kayıp', `${sign(s.avgWin)} / ${sign(s.avgLoss)} ${q}`);
  line('En iyi / en kötü işlem', `${sign(s.bestTrade)} / ${sign(s.worstTrade)} ${q}`);
  line('Kâr faktörü', `${f2(s.profitFactor)}  (1'in altı = zarar)`);
  line('En büyük düşüş', `${f2(s.maxDrawdown)} ${q} (%${f2(s.maxDrawdownPct)})`);
  line('Ödenen komisyon', `${f2(s.feesPaid)} ${q}`);
  line('Pozisyonda geçen süre', `%${f2(s.exposurePct)} (aynı anda en çok ${s.maxConcurrent} pozisyon)`);
  if (o.direction !== 'long') {
    for (const [side, label] of [['long', 'Long'], ['short', 'Short']]) {
      const b = s.bySide[side];
      if (b.trades) line(`  ${label}`, `${b.trades} işlem, kazanma %${f2(b.winRatePct)}, K/Z ${sign(b.pnl)} ${q}, kâr fak. ${f2(b.profitFactor)}`);
    }
    line('Ödenen fonlama', `${f2(s.fundingPaid)} ${q} (8 saatte %${o.fundingPct})`);
  }
  line('Çıkış nedenleri', Object.entries(s.exitReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || '-');

  if (o.direction !== 'long') console.log('\n  Not: Fiyatlar spot piyasadan; vadeli işlem fiyatları çok yakın seyreder ama birebir aynı değildir.');
  console.log('\n  Coin          İşlem  Kazanma%        K/Z   Kâr fak.   Al-tut%');
  for (const p of [...s.perSymbol].sort((a, b) => b.pnl - a.pnl)) {
    console.log(
      `  ${p.symbol.padEnd(12)} ${String(p.trades).padStart(6)}  ${f2(p.winRatePct).padStart(8)}  ${sign(p.pnl).padStart(9)}  ${f2(p.profitFactor).padStart(9)}  ${sign(p.buyHoldPct).padStart(8)}`,
    );
  }
}

function printTrades(trades) {
  console.log('\n  Coin         Giriş              Çıkış              Giriş fiyatı    Çıkış fiyatı       K/Z      %  Neden');
  for (const t of [...trades].sort((a, b) => a.entryAt - b.entryAt)) {
    console.log(
      `  ${t.symbol.padEnd(11)}  ${dt(t.entryAt)}  ${dt(t.exitAt)}  ${t.entryPrice.toPrecision(7).padStart(13)}  ${t.exitPrice.toPrecision(7).padStart(13)}` +
      `  ${sign(t.pnl).padStart(8)}  ${sign(t.pnlPct).padStart(6)}  ${t.reason}`,
    );
  }
}

function sweep(data, base) {
  const rows = [];
  for (const buyScore of [2, 3, 4]) {
    for (const sellScore of [-1, -2, -3]) {
      for (const requireTrend of [true, false]) {
        for (const stopLossPct of [0, 5, 10]) {
          const { summary: s } = runBacktest(data, { ...base, buyScore, sellScore, requireTrend, stopLossPct });
          rows.push({
            buyScore, sellScore, requireTrend, stopLossPct, ...s,
            current: buyScore === base.buyScore && sellScore === base.sellScore && requireTrend === base.requireTrend && stopLossPct === base.stopLossPct,
          });
        }
      }
    }
  }
  rows.sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('\n=== Ayar karşılaştırması (K/Z’ye göre sıralı) ===');
  console.log('   Alım  Satış  Trend  SL%   İşlem  Kazanma%       K/Z  Getiri%  Max düşüş%  Kâr fak.');
  for (const r of rows) {
    console.log(
      `${r.current ? ' >' : '  '} ${String(r.buyScore).padStart(4)}  ${String(r.sellScore).padStart(5)}  ${(r.requireTrend ? 'evet' : 'hayır').padStart(5)}  ${String(r.stopLossPct).padStart(3)}` +
      `  ${String(r.trades).padStart(6)}  ${f2(r.winRatePct).padStart(8)}  ${sign(r.totalPnl).padStart(8)}  ${sign(r.returnPct).padStart(7)}  ${f2(r.maxDrawdownPct).padStart(10)}  ${f2(r.profitFactor).padStart(8)}`,
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
  const log = (m) => !a.json && process.stderr.write(m);

  const o = {
    interval: a.interval || cfg.interval,
    buyScore: num(a['buy-score'], cfg.buyScore, 'buy-score'),
    sellScore: num(a['sell-score'], cfg.sellScore, 'sell-score'),
    requireTrend: a['no-trend'] ? false : cfg.requireTrend,
    maxOpenPositions: num(a['max-open'], cfg.maxOpenPositions, 'max-open'),
    stopLossPct: num(a.sl, cfg.stopLossPct, 'sl'),
    takeProfitPct: num(a.tp, cfg.takeProfitPct, 'tp'),
    orderQuoteAmount: num(a.amount, cfg.orderQuoteAmount, 'amount'),
    maxTradesPerDay: num(a['max-trades'], cfg.maxTradesPerDay, 'max-trades'),
    analysisMinutes: num(a['analysis-minutes'], cfg.analysisMinutes, 'analysis-minutes'),
    direction: a.direction || 'long',
    shortScore: num(a['short-score'], 3, 'short-score'),
    coverScore: num(a['cover-score'], 2, 'cover-score'),
    fundingPct: num(a.funding, a.direction && a.direction !== 'long' ? 0.01 : 0, 'funding'),
    feePct: num(a.fee, a.direction && a.direction !== 'long' ? 0.05 : 0.1, 'fee'),
    slippagePct: num(a.slippage, 0.05, 'slippage'),
  };

  const step = intervalMs(o.interval);
  const intrabar = o.analysisMinutes > 0 && o.analysisMinutes * 60e3 < step;
  if (intrabar && (o.analysisMinutes % 15 !== 0 || a.csv)) throw new Error('--analysis-minutes 15’in katı olmalı ve --csv ile kullanılamaz');
  const dataInterval = intrabar ? '15m' : o.interval;
  const endTime = a.to ? parseDate(a.to, 'to') + DAY : Math.floor(Date.now() / step) * step;
  const startTime = a.from ? parseDate(a.from, 'from') : endTime - num(a.days, 365, 'days') * DAY;
  if (startTime >= endTime) throw new Error('Başlangıç tarihi bitişten önce olmalı');
  const warmStart = startTime - FETCH_CANDLES * step; // göstergeleri ısıtmak için ek geçmiş

  const data = {};
  let survivorshipNote = false;
  if (a.csv) {
    for (const spec of a.csv) {
      const [sym, file] = spec.split('=');
      if (!file) throw new Error('--csv SEMBOL=dosya.csv biçiminde olmalı');
      data[sym.toUpperCase()] = loadCsv(file).filter((k) => k.openTime >= warmStart && k.openTime < endTime);
    }
  } else {
    let symbols = a.symbols ? a.symbols.split(',').map((x) => x.trim().toUpperCase()) : cfg.symbols;
    if (!symbols.length) {
      const top = num(a.top, cfg.topN, 'top');
      log(`Hacme göre bugünkü ilk ${top} coin belirleniyor...`);
      const client = new BinanceClient({ baseUrl: HISTORY_BASE_URL, timeoutMs: 30000 });
      const u = await selectUniverse(client, {
        topN: top, quote: cfg.quoteAsset, exclude: cfg.excludeAssets, minListingDays: cfg.minListingDays,
      });
      symbols = u.symbols;
      survivorshipNote = true;
      log(` ${symbols.join(', ')}\n`);
      if (u.skipped.length) log(`  (elenen: ${u.skipped.map((x) => `${x.symbol} – ${x.reason}`).join('; ')})\n`);
    }
    for (const symbol of symbols) {
      log(`  ${symbol} ${dataInterval} indiriliyor...`);
      data[symbol] = await loadHistory(
        { symbol, interval: dataInterval, startTime: warmStart, endTime },
        path.join(cfg.dataDir, 'history'),
      );
      log(` ${data[symbol].length} mum\n`);
    }
  }

  const q = cfg.quoteAsset;
  if (intrabar) {
    const evals = Object.fromEntries(Object.keys(data).map((s) => [s, intrabarEvaluator(data[s], step, o.analysisMinutes)]));
    o.evaluate = (ser, i, opts, s) => evals[s](ser, i, opts);
    log(`  Analiz her ${o.analysisMinutes} dakikada (oluşan ${o.interval} mum dahil); emirler 15 dakikalık mumlarla simüle ediliyor.\n`);
  }
  const result = runBacktest(data, { ...o, tradeFrom: startTime });

  if (a.json) {
    delete o.evaluate;
    console.log(JSON.stringify({ options: o, summary: result.summary, trades: result.trades }, null, 2));
    return;
  }
  printSummary(result.summary, o, q);
  if (a.trades) printTrades(result.trades);
  if (a.sweep) sweep(data, { ...o, tradeFrom: startTime });
  if (survivorshipNote) {
    console.log('\n  Not: Coin listesi BUGÜNKÜ hacme göre seçildi. Geçmişte bu coinler ilk 10’da olmayabilirdi;');
    console.log('  bugün popüler olan coinler geçmişte iyi gitmiş olmaya yatkındır (hayatta kalma yanlılığı).');
  }
  console.log('\n  Not: Geçmiş performans gelecekteki sonuçları garanti etmez.\n');
}

main().catch((e) => {
  console.error(`\nBacktest başarısız: ${e.message}`);
  process.exit(1);
});
