"""
download_1candleperday.py
Downloads full daily candle history for each coin in COIN_LIST from KuCoin
and stores each in SQLite.

KuCoin candles API returns up to 1500 candles per request.
We paginate backwards in time until no more data is returned.

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

# Get 1D resolution configuration
RES_CONFIG = RESOLUTIONS["1d"]
CANDLE_SECONDS = RES_CONFIG["candle_seconds"]
MAX_CANDLES_PER_REQUEST = RES_CONFIG["max_candles_per_request"]
CANDLE_TYPE = RES_CONFIG["kucoin_type"]
REQUEST_WINDOW = MAX_CANDLES_PER_REQUEST * CANDLE_SECONDS

def fetch_candles(symbol: str, start_ts: int, end_ts: int) -> list:
    """Fetch up to 1500 daily candles for a symbol between start_ts and end_ts."""
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
    """Download all available daily candles for symbol and store in SQLite."""
    storage_symbol = candle_symbol(symbol, "1d")

    all_candles = {}  # keyed by timestamp to avoid duplicates

    # Start from now and walk backwards
    end_ts = int(time.time())

    print(f"[{symbol}] Downloading full daily history...")

    while True:
        start_ts = end_ts - REQUEST_WINDOW

        candles = fetch_candles(symbol, start_ts, end_ts)

        if not candles:
            break

        for candle in candles:
            ts = int(candle[0])
            all_candles[ts] = candle

        oldest_ts = min(int(c[0]) for c in candles)
        print(f"  Fetched {len(candles)} candles, oldest: {oldest_ts} "
              f"({time.strftime('%Y-%m-%d', time.gmtime(oldest_ts))})")

        # If we got fewer candles than possible, we've reached the beginning
        if len(candles) < MAX_CANDLES_PER_REQUEST:
            break

        end_ts = oldest_ts - 1  # step back before the oldest candle received
        time.sleep(0.3)  # be polite to the API

    if not all_candles:
        print(f"  No data returned for {symbol}.")
        return None

    # Sort by time ascending and persist
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


def main():
    for symbol in COIN_LIST:
        saved = download_symbol(symbol)
        if not saved:
            continue

        # Build and save intervals immediately for each downloaded coin.
        result = build_intervals_for_symbol(symbol, resolution="1d")
        json_path = maybe_save_json(result)
        if json_path:
            print(f"  Saved intervals JSON -> {json_path}")
        time.sleep(0.5)  # be polite between coins

    print("Done.")


if __name__ == "__main__":
    main()
