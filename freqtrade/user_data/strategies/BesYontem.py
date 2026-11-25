"""
BesYontem: bot/ klasöründeki Node.js botunun stratejisinin Freqtrade sürümü.

Her mum kapanışında beş yöntem +1 / 0 / -1 oy verir:
  Trend (EMA200)   : fiyat EMA200 üstünde +1, altında -1
  EMA 20/50        : EMA20 > EMA50 +1, aksi -1
  MACD (12/26/9)   : histogram pozitif ve artıyor +1, negatif ve azalıyor -1
  RSI (14)         : < 30 (aşırı satım) +1, > 70 (aşırı alım) -1
  Bollinger (20,2) : fiyat alt bandın altında +1, üst bandın üstünde -1
Alım : skor >= buy_score ve fiyat EMA200 üstünde
Satış: skor <= sell_score ya da %8 zarar durdur
Sadece spot, sadece long. Kâr garantisi yoktur.
"""
from pandas import DataFrame, Series
import numpy as np

from freqtrade.strategy import IStrategy, IntParameter


def ema(s: Series, n: int) -> Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi_wilder(close: Series, n: int = 14) -> Series:
    d = close.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = gain / loss
    out = 100 - 100 / (1 + rs)
    out[(loss == 0) & (gain > 0)] = 100
    out[(loss == 0) & (gain == 0)] = 50
    return out


class BesYontem(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = False

    # Sadece analiz sinyaliyle ve zarar durdurla çıkış (sabit kâr hedefi yok)
    minimal_roi = {"0": 100}
    stoploss = -0.08
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False

    process_only_new_candles = True
    startup_candle_count = 600  # EMA200'ün doğru hesaplanması için ısınma

    order_types = {
        "entry": "market",
        "exit": "market",
        "stoploss": "market",
        "stoploss_on_exchange": True,  # zarar durdur emri Binance'te bekler (bot kapansa da)
    }

    # Hyperopt ile denenebilir (aşırı uyuma dikkat!)
    buy_score = IntParameter(2, 5, default=3, space="buy")
    sell_score = IntParameter(-4, -1, default=-2, space="sell")

    def populate_indicators(self, df: DataFrame, metadata: dict) -> DataFrame:
        c = df["close"]
        df["ema200"] = ema(c, 200)
        df["ema20"] = ema(c, 20)
        df["ema50"] = ema(c, 50)
        df["rsi"] = rsi_wilder(c, 14)
        macd = ema(c, 12) - ema(c, 26)
        df["macd_hist"] = macd - ema(macd, 9)
        mid = c.rolling(20).mean()
        sd = c.rolling(20).std(ddof=0)
        df["bb_upper"] = mid + 2 * sd
        df["bb_lower"] = mid - 2 * sd

        h, hp = df["macd_hist"], df["macd_hist"].shift(1)
        df["v_trend"] = np.where(c > df["ema200"], 1, -1)
        df["v_ema"] = np.where(df["ema20"] > df["ema50"], 1, -1)
        df["v_macd"] = np.select([(h > 0) & (h > hp), (h < 0) & (h < hp)], [1, -1], 0)
        df["v_rsi"] = np.select([df["rsi"] < 30, df["rsi"] > 70], [1, -1], 0)
        df["v_bb"] = np.select([c < df["bb_lower"], c > df["bb_upper"]], [1, -1], 0)

        ready = df[["ema200", "ema20", "ema50", "rsi", "macd_hist", "bb_upper"]].notna().all(axis=1) & hp.notna()
        df["score"] = (df[["v_trend", "v_ema", "v_macd", "v_rsi", "v_bb"]].sum(axis=1)).where(ready)
        return df

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[
            (df["score"] >= self.buy_score.value) & (df["v_trend"] == 1) & (df["volume"] > 0),
            ["enter_long", "enter_tag"],
        ] = (1, "skor")
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[(df["score"] <= self.sell_score.value) & (df["volume"] > 0), ["exit_long", "exit_tag"]] = (1, "skor")
        return df
