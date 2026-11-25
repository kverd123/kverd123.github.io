export function createLogger(prefix = 'bot') {
  const fmt = (level, msg) => `${new Date().toISOString()} [${prefix}] ${level} ${msg}`;
  return {
    info: (m) => console.log(fmt('INFO ', m)),
    warn: (m) => console.warn(fmt('WARN ', m)),
    error: (m) => console.error(fmt('ERROR', m)),
  };
}

/** Telegram ayarlıysa mesaj gönderir; değilse sessizce geçer. Hata botu durdurmaz. */
export function createNotifier({ telegramToken, telegramChatId }, logger, fetchImpl = globalThis.fetch) {
  if (!telegramToken || !telegramChatId) return async () => {};
  return async (text) => {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramChatId, text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) logger.warn(`Telegram bildirimi başarısız: HTTP ${res.status}`);
    } catch (e) {
      logger.warn(`Telegram bildirimi başarısız: ${e.message}`);
    }
  };
}
