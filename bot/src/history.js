import fs from 'node:fs';
import path from 'node:path';

// Geçmiş veri için her zaman gerçek piyasa verisi kullanılır (testnet verisi gerçekçi değil).
// data-api.binance.vision sadece herkese açık piyasa verisi sunan resmi uçtur.
export const HISTORY_BASE_URL = 'https://data-api.binance.vision';

const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3, '12h': 43200e3,
  '1d': 86400e3,
};

export function intervalMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new Error(`Desteklenmeyen aralık: ${interval} (${Object.keys(INTERVAL_MS).join(', ')})`);
  return ms;
}

const toCandle = (r) => ({
  openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
  close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]),
});

/** [startTime, endTime) aralığındaki kapanmış mumları 1000'lik sayfalarla indirir. */
export async function fetchHistory({ symbol, interval, startTime, endTime, baseUrl = HISTORY_BASE_URL, fetchImpl = globalThis.fetch, onProgress }) {
  const step = intervalMs(interval);
  const out = [];
  let from = startTime;
  while (from < endTime) {
    const qs = new URLSearchParams({ symbol, interval, startTime: String(from), endTime: String(endTime - 1), limit: '1000' });
    const res = await fetchImpl(`${baseUrl}/api/v3/klines?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Geçmiş veri alınamadı: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push(toCandle(r));
    from = Number(rows.at(-1)[0]) + step;
    onProgress?.(out.length);
    if (rows.length < 1000) break;
  }
  const now = Date.now();
  return out.filter((k) => k.closeTime < now);
}

/** İndirilen veriyi diske önbellekler; aynı istek tekrar indirilmez. */
export async function loadHistory(opts, cacheDir) {
  const { symbol, interval, startTime, endTime } = opts;
  const file = cacheDir && path.join(cacheDir, `klines-${symbol}-${interval}-${startTime}-${endTime}.json`);
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const candles = await fetchHistory(opts);
  if (file) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(candles));
  }
  return candles;
}

/**
 * data.binance.vision'dan indirilen CSV (veya birden fazla CSV) dosyalarını okur.
 * Sütunlar: open_time, open, high, low, close, volume, close_time, ...
 * 2025 sonrası dosyalarda zaman damgaları mikrosaniye olabilir; otomatik çevrilir.
 */
export function loadCsv(files) {
  const out = [];
  for (const f of [].concat(files)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const cols = line.split(',');
      if (cols.length < 7 || !/^\d+$/.test(cols[0])) continue; // başlık / boş satır
      const k = toCandle(cols);
      if (k.openTime > 1e14) { k.openTime = Math.floor(k.openTime / 1000); k.closeTime = Math.floor(k.closeTime / 1000); }
      out.push(k);
    }
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out.filter((k, i) => i === 0 || k.openTime !== out[i - 1].openTime);
}
