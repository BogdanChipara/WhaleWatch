"""
download_1candleper10minutes.py
Downloads only the latest 10-minute candle history window (14 days) for each coin
in COIN_LIST and stores each in SQLite.

This keeps high-frequency downloads fast and bounded.

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

# Get 10-minute resolution configuration
RES_CONFIG = RESOLUTIONS["10m"]
CANDLE_SECONDS = RES_CONFIG["candle_seconds"]
MAX_CANDLES_PER_REQUEST = RES_CONFIG["max_candles_per_request"]
CANDLE_TYPE = RES_CONFIG["kucoin_type"]
MAX_10M_HISTORY_DAYS = 14
MAX_10M_HISTORY_SECONDS = MAX_10M_HISTORY_DAYS * 86400
AGG_BUCKET_SECONDS = 10 * 60

def _aggregate_5m_to_10m(raw_rows: list) -> list:
    """Aggregate KuCoin 5-minute candles into synthetic 10-minute candles."""
    if not raw_rows:
        return []

    parsed = []
    for row in raw_rows:
        parsed.append(
            {
                "time": int(row[0]),
                "open": float(row[1]),
                "close": float(row[2]),
                "high": float(row[3]),
                "low": float(row[4]),
                "volume": float(row[5]),
                "turnover": float(row[6]),
            }
        )

    parsed.sort(key=lambda x: x["time"])

    buckets: dict[int, list[dict]] = {}
    for candle in parsed:
        bucket = (candle["time"] // AGG_BUCKET_SECONDS) * AGG_BUCKET_SECONDS
        buckets.setdefault(bucket, []).append(candle)

    aggregated: list[list[str]] = []
    for bucket_ts in sorted(buckets.keys()):
        group = buckets[bucket_ts]
        group.sort(key=lambda x: x["time"])
        aggregated.append(
            [
                str(bucket_ts),
                str(group[0]["open"]),
                str(group[-1]["close"]),
                str(max(c["high"] for c in group)),
                str(min(c["low"] for c in group)),
                str(sum(c["volume"] for c in group)),
                str(sum(c["turnover"] for c in group)),
            ]
        )

    return aggregated


def fetch_candles(symbol: str, start_ts: int, end_ts: int) -> list:
    """Fetch 5-minute candles and aggregate them to 10-minute candles."""
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
    return _aggregate_5m_to_10m(data.get("data", []))


def download_symbol(symbol: str) -> str | None:
    """Download last 14 days of 10-minute candles for symbol and store in SQLite."""
    storage_symbol = candle_symbol(symbol, "10m")

    all_candles = {}  # keyed by timestamp to avoid duplicates

    end_ts = int(time.time())
    start_ts = end_ts - MAX_10M_HISTORY_SECONDS

    print(
        f"[{symbol}] Downloading 10-minute history for last {MAX_10M_HISTORY_DAYS} days "
        f"(from 5-minute source candles)..."
    )

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
            build_result = build_intervals_for_symbol(symbol, resolution="10m")
            maybe_save_json(build_result)
        time.sleep(0.5)
    print("Done.")


if __name__ == "__main__":
    main()
