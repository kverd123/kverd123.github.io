// "İlk N coin" seçimi: USDT paritelerinde 24 saatlik işlem hacmine göre sıralama.

// Stablecoin, fiat ve sarmalanmış (wrapped) varlıklar coin olarak sayılmaz.
export const DEFAULT_EXCLUDED_ASSETS = [
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USD1', 'RLUSD', 'PYUSD', 'USDE', 'XUSD', 'U',
  'EUR', 'EURI', 'AEUR', 'GBP', 'TRY', 'BRL', 'WBTC', 'WBETH', 'BETH',
];

/** Fiyatı 1 civarında ve neredeyse hiç oynamayan varlıklar (stablecoin) otomatik elenir. */
export function looksStable(t) {
  const last = Number(t.lastPrice), hi = Number(t.highPrice), lo = Number(t.lowPrice);
  return Math.abs(last - 1) < 0.03 && last > 0 && (hi - lo) / last < 0.02;
}

/**
 * Hacme göre sıralı aday listesi (henüz listelenme yaşı kontrol edilmemiş).
 * tickers: /ticker/24hr çıktısı, symbols: exchangeInfo.symbols
 */
export function rankCandidates(tickers, symbols, { quote = 'USDT', exclude = DEFAULT_EXCLUDED_ASSETS } = {}) {
  const info = new Map(symbols.map((s) => [s.symbol, s]));
  const ex = new Set(exclude.map((a) => a.toUpperCase()));
  return tickers
    .map((t) => ({ t, s: info.get(t.symbol) }))
    .filter(({ t, s }) =>
      s && s.status === 'TRADING' && s.isSpotTradingAllowed !== false &&
      s.quoteAsset === quote && !ex.has(s.baseAsset) && !looksStable(t))
    .sort((a, b) => Number(b.t.quoteVolume) - Number(a.t.quoteVolume))
    .map(({ t, s }) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteVolume: Number(t.quoteVolume) }));
}

/**
 * İlk N coini seçer. Yeni listelenmiş (minListingDays'ten genç) semboller elenir:
 * tokenize hisseler ve yeni tokenlar genellikle bu yolla dışarıda kalır, ayrıca
 * göstergeler için yeterli geçmiş veri olur.
 * listingCache: { SYMBOL: ilkMumZamanı } — değişmediği için saklanır.
 */
export async function selectUniverse(client, { topN = 10, quote = 'USDT', exclude, minListingDays = 365, listingCache = {}, now = Date.now() }) {
  const [tickers, info] = await Promise.all([client.tickers24h(), client.exchangeInfo()]);
  const candidates = rankCandidates(tickers, info.symbols, { quote, exclude });
  const picked = [];
  const skipped = [];
  for (const c of candidates) {
    if (picked.length >= topN) break;
    if (minListingDays > 0) {
      if (listingCache[c.symbol] === undefined) listingCache[c.symbol] = await client.firstCandleTime(c.symbol);
      const ageDays = (now - listingCache[c.symbol]) / 86400e3;
      if (!(ageDays >= minListingDays)) {
        skipped.push({ symbol: c.symbol, reason: `yeni listelenmiş (${Math.floor(ageDays)} gün)` });
        continue;
      }
    }
    picked.push(c);
  }
  return { symbols: picked.map((c) => c.symbol), details: picked, skipped, listingCache };
}
