"""
download_1candleper6hours.py
Downloads only the latest 6-hour candle history window (180 days) for each coin
in COIN_LIST and stores each in SQLite.

Candle fields (KuCoin order):
    time (Unix seconds), open, close, high, low, volume, turnover
"""

import time

import requests

from build_intervals import build_intervals_for_symbol, maybe_save_json
from database import candle_symbol, insert_candles
from config import (
    COIN_LIST,
    KUCOIN_BASE_URL,
    KUCOIN_CANDLES_ENDPOINT,
    RESOLUTIONS,
)

RES_CONFIG = RESOLUTIONS["6h"]
CANDLE_TYPE = RES_CONFIG["kucoin_type"]
MAX_6H_HISTORY_DAYS = 180
MAX_6H_HISTORY_SECONDS = MAX_6H_HISTORY_DAYS * 86400

def fetch_candles(symbol: str, start_ts: int, end_ts: int) -> list:
    """Fetch 6-hour candles for a symbol between start_ts and end_ts."""
    url = KUCOIN_BASE_URL + KUCOIN_CANDLES_ENDPOINT
    params = {
        "symbol": symbol,
        "type": CANDLE_TYPE,
        "startAt": start_ts,
        "endAt": end_ts,
    }
    response = requests.get(url, params=params, timeout=15)
    response.raise_for_status()
    data = response.json()
    if data.get("code") != "200000":
        raise RuntimeError(f"KuCoin API error: {data}")
    return data.get("data", [])


def download_symbol(symbol: str) -> str | None:
    """Download last 180 days of 6-hour candles for symbol and store in SQLite."""
    storage_symbol = candle_symbol(symbol, "6h")

    all_candles = {}

    end_ts = int(time.time())
    start_ts = end_ts - MAX_6H_HISTORY_SECONDS

    print(f"[{symbol}] Downloading 6-hour history for last {MAX_6H_HISTORY_DAYS} days...")

    candles = fetch_candles(symbol, start_ts, end_ts)
    for candle in candles:
        ts = int(candle[0])
        all_candles[ts] = candle

    if candles:
        oldest_ts = min(int(c[0]) for c in candles)
        print(
            f"  Fetched {len(candles)} candles, oldest: {oldest_ts} "
            f"({time.strftime('%Y-%m-%d %H:%M', time.gmtime(oldest_ts))})"
        )

    if not all_candles:
        print(f"  No data returned for {symbol}.")
        return None

    sorted_candles = sorted(all_candles.values(), key=lambda c: int(c[0]))
    payload = [
        {
            "timestamp": int(row[0]),
            "open": float(row[1]),
            "high": float(row[3]),
            "low": float(row[4]),
            "close": float(row[2]),
            "volume": float(row[5]),
        }
        for row in sorted_candles
    ]
    inserted = insert_candles(storage_symbol, payload)

    print(f"  Saved {inserted} candles -> coindata.db")
    return storage_symbol


def main() -> None:
    for symbol in COIN_LIST:
        saved = download_symbol(symbol)
        if saved:
            build_result = build_intervals_for_symbol(symbol, resolution="6h")
            maybe_save_json(build_result)
        time.sleep(0.5)
    print("Done.")


if __name__ == "__main__":
    main()
