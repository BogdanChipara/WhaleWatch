"""
update_coin_history.py
For each coin in COIN_LIST and each resolution (5m, 10m, 30m, 6h, 12h, 1h, 1d):
- If database rows are missing: download full history.
- If rows exist: fetch only newer candles and upsert.
- Rebuild interval JSON only when data changed.
"""

import time
from typing import List, Optional

from build_intervals import build_intervals_for_symbol, maybe_save_json
from coin_list import COIN_LIST
from config import RESOLUTIONS
from database import candle_symbol, delete_older_than, get_earliest_timestamp, get_latest_timestamp, insert_candles
from download_1candleper5minutes import (
    MAX_5M_HISTORY_SECONDS,
    download_symbol as download_5m,
    fetch_candles as fetch_5m_candles,
)
from download_1candleper10minutes import (
    MAX_10M_HISTORY_SECONDS,
    download_symbol as download_10m,
    fetch_candles as fetch_10m_candles,
)
from download_1candleper30minutes import (
    MAX_30M_HISTORY_SECONDS,
    download_symbol as download_30m,
    fetch_candles as fetch_30m_candles,
)
from download_1candleper6hours import (
    MAX_6H_HISTORY_SECONDS,
    download_symbol as download_6h,
    fetch_candles as fetch_6h_candles,
)
from download_1candleper12hours import (
    MAX_12H_HISTORY_SECONDS,
    download_symbol as download_12h,
    fetch_candles as fetch_12h_candles,
)
from download_1candleperday import (
    download_symbol as download_daily,
    fetch_candles as fetch_daily_candles,
)
from download_1candleperhour import (
    MAX_HOURLY_HISTORY_SECONDS,
    download_symbol as download_hourly,
    fetch_candles as fetch_hourly_candles,
)


def get_first_timestamp(storage_symbol: str) -> Optional[int]:
    """Return earliest candle timestamp found in SQLite, or None for empty data."""
    return get_earliest_timestamp(storage_symbol)


def fetch_incremental_candles(
    fetch_func,
    symbol: str,
    start_ts: int,
    end_ts: int,
    resolution: str,
) -> List[List[str]]:
    """Fetch candles in forward chunks from start_ts to end_ts."""
    res_config = RESOLUTIONS[resolution]
    candle_seconds = res_config["candle_seconds"]
    max_candles = res_config["max_candles_per_request"]
    request_window = max_candles * candle_seconds

    all_rows: List[List[str]] = []
    cursor = start_ts

    while cursor <= end_ts:
        chunk_end = min(cursor + request_window, end_ts)
        rows = fetch_func(symbol, cursor, chunk_end)
        if rows:
            all_rows.extend(rows)

        if chunk_end >= end_ts:
            break

        cursor = chunk_end + 1
        time.sleep(0.25)

    return all_rows


def append_new_rows(storage_symbol: str, rows: List[List[str]], last_ts: int) -> int:
    """Upsert candles from last_ts onward. Returns number of inserted/updated rows."""
    # Keep candles at/after last_ts so the most recent candle can be refreshed after it closes.
    dedup: dict[int, List[str]] = {}
    for row in rows:
        ts = int(row[0])
        if ts >= last_ts:
            dedup[ts] = row

    upsert_rows = [dedup[ts] for ts in sorted(dedup.keys())]
    if not upsert_rows:
        return 0

    payload = [
        {
            "timestamp": int(row[0]),
            "open": float(row[1]),
            "high": float(row[3]),
            "low": float(row[4]),
            "close": float(row[2]),
            "volume": float(row[5]),
        }
        for row in upsert_rows
    ]
    return insert_candles(storage_symbol, payload)


def trim_rows_to_window(storage_symbol: str, end_ts: int, max_window_seconds: int) -> int:
    """Trim SQLite rows to rolling window. Returns removed row count."""
    cutoff_ts = end_ts - max_window_seconds
    return delete_older_than(storage_symbol, cutoff_ts)


def rebuild_intervals(symbol: str, resolution: str) -> None:
    """Rebuild interval JSON for a symbol and resolution."""
    result = build_intervals_for_symbol(symbol, resolution=resolution)
    json_path = maybe_save_json(result)
    if json_path:
        print(f"  Saved intervals JSON -> {json_path}")


def update_symbol_resolution(symbol: str, resolution: str) -> None:
    """Update a single coin and resolution."""
    storage_symbol = candle_symbol(symbol, resolution)

    # Determine which download and fetch functions to use
    if resolution == "5m":
        download_func = download_5m
        fetch_func = fetch_5m_candles
    elif resolution == "10m":
        download_func = download_10m
        fetch_func = fetch_10m_candles
    elif resolution == "30m":
        download_func = download_30m
        fetch_func = fetch_30m_candles
    elif resolution == "6h":
        download_func = download_6h
        fetch_func = fetch_6h_candles
    elif resolution == "12h":
        download_func = download_12h
        fetch_func = fetch_12h_candles
    elif resolution == "1d":
        download_func = download_daily
        fetch_func = fetch_daily_candles
    elif resolution == "1h":
        download_func = download_hourly
        fetch_func = fetch_hourly_candles
    else:
        raise ValueError(f"Unknown resolution: {resolution}")

    res_config = RESOLUTIONS[resolution]
    candle_seconds = res_config["candle_seconds"]

    last_ts = get_latest_timestamp(storage_symbol)
    if last_ts is None:
        print(f"[{symbol}/{resolution}] Data missing. Downloading full history...")
        downloaded = download_func(symbol)
        if not downloaded:
            print(f"[{symbol}/{resolution}] Failed to download full history.")
            return
        rebuild_intervals(symbol, resolution)
        return

    end_ts = int(time.time())
    # Only ingest fully closed candles to avoid persisting partial intrabar OHLC values.
    latest_closed_ts = ((end_ts // candle_seconds) * candle_seconds) - candle_seconds
    # Re-fetch the latest stored timestamp so that an earlier partial candle is corrected.
    start_ts = last_ts

    retention_windows = {
        "5m": MAX_5M_HISTORY_SECONDS,
        "10m": MAX_10M_HISTORY_SECONDS,
        "30m": MAX_30M_HISTORY_SECONDS,
        "6h": MAX_6H_HISTORY_SECONDS,
        "12h": MAX_12H_HISTORY_SECONDS,
        "1h": MAX_HOURLY_HISTORY_SECONDS,
    }

    if resolution in retention_windows:
        max_window_seconds = retention_windows[resolution]
        removed = trim_rows_to_window(storage_symbol, end_ts, max_window_seconds)
        if removed > 0:
            print(f"[{symbol}/{resolution}] Trimmed {removed} old candles outside retention window.")

        cutoff_ts = end_ts - max_window_seconds
        first_ts = get_first_timestamp(storage_symbol)
        if last_ts < cutoff_ts or first_ts is None or first_ts > cutoff_ts:
            print(f"[{symbol}/{resolution}] Existing data too old. Re-downloading retention window...")
            downloaded = download_func(symbol)
            if not downloaded:
                print(f"[{symbol}/{resolution}] Failed to download retention window.")
                return
            rebuild_intervals(symbol, resolution)
            return

    if start_ts > latest_closed_ts:
        if resolution in retention_windows:
            rebuild_intervals(symbol, resolution)
        print(f"[{symbol}/{resolution}] Already up to date.")
        return

    print(f"[{symbol}/{resolution}] Checking updates from {start_ts} to {latest_closed_ts}...")
    rows = fetch_incremental_candles(fetch_func, symbol, start_ts, latest_closed_ts, resolution)
    appended = append_new_rows(storage_symbol, rows, last_ts)

    if appended == 0:
        if resolution in retention_windows:
            rebuild_intervals(symbol, resolution)
        print(f"[{symbol}/{resolution}] Already up to date.")
        return

    if resolution in retention_windows:
        removed = trim_rows_to_window(storage_symbol, end_ts, retention_windows[resolution])
        if removed > 0:
            print(f"[{symbol}/{resolution}] Trimmed {removed} old candles outside retention window.")

    print(f"[{symbol}/{resolution}] Upserted {appended} candles -> coindata.db")
    rebuild_intervals(symbol, resolution)


def main() -> None:
    for symbol in COIN_LIST:
        for resolution in RESOLUTIONS.keys():
            update_symbol_resolution(symbol, resolution)
            time.sleep(0.3)
    print("Done.")


if __name__ == "__main__":
    main()
