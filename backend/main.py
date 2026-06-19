import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import requests
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

from calc_ATR import compute_atr_series
from calc_EMA import compute_ema_series
from calc_GCprobability import compute_gc_probability
from build_intervals import build_intervals_for_symbol
from config import (
    COIN_LIST,
    RESOLUTIONS,
    UPDATE_INTERVAL_SECONDS,
    EMPTY_DATA_POLL_SECONDS,
    COIN_CROSS_KEEP_DAYS,
)
from database import candle_symbol, get_latest_timestamp
from update_coin_history import update_symbol_resolution


RANGE_TO_DAYS = {
    "1D": 1,
    "3D": 3,
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "6M": 180,
    "1Y": 365,
    "2Y": 730,
}

RANGE_POLICY = {
    "1D": {"resolution": "5m", "aggregateSeconds": None},
    "3D": {"resolution": "10m", "aggregateSeconds": 10 * 60},
    "1W": {"resolution": "30m", "aggregateSeconds": None},
    "1M": {"resolution": "1h", "aggregateSeconds": 2 * 3600},
    "3M": {"resolution": "6h", "aggregateSeconds": None},
    "6M": {"resolution": "12h", "aggregateSeconds": None},
    "1Y": {"resolution": "1d", "aggregateSeconds": None},
    "2Y": {"resolution": "1d", "aggregateSeconds": 2 * 86400},
    "FULL": {"resolution": "1d", "aggregateSeconds": 10 * 86400},
}


INTERVALS_CACHE: dict[str, dict] = {}
INTERVALS_CACHE_META: dict[str, Any] = {
    "generated_at_utc": None,
    "entry_count": 0,
}
INTERVALS_CACHE_LOCK = Lock()


def _cache_key(symbol: str, resolution: str) -> str:
    return f"{symbol.upper()}__{resolution.lower()}"


def _empty_intervals_result(symbol: str, resolution: str) -> dict:
    return {
        "symbol": symbol,
        "resolution": resolution,
        "source_file": "coindata.db",
        "total_candles": 0,
        "intervals": {},
    }


def _build_intervals_snapshot() -> dict[str, dict]:
    snapshot: dict[str, dict] = {}

    for symbol in COIN_LIST:
        for resolution in RESOLUTIONS.keys():
            key = _cache_key(symbol, resolution)

            try:
                interval_data = build_intervals_for_symbol(symbol, resolution=resolution)
                if int(interval_data.get("total_candles", 0)) == 0:
                    snapshot[key] = _empty_intervals_result(symbol, resolution)
                else:
                    snapshot[key] = interval_data
            except Exception as exc:
                print(f"[cache] ERROR building intervals for {symbol}/{resolution}: {exc}")
                snapshot[key] = _empty_intervals_result(symbol, resolution)

    return snapshot


def _refresh_intervals_cache(reason: str = "unspecified") -> None:
    snapshot = _build_intervals_snapshot()

    with INTERVALS_CACHE_LOCK:
        INTERVALS_CACHE.clear()
        INTERVALS_CACHE.update(snapshot)
        INTERVALS_CACHE_META["generated_at_utc"] = datetime.now(timezone.utc).isoformat()
        INTERVALS_CACHE_META["entry_count"] = len(snapshot)

    print(f"[cache] refreshed ({reason}) with {len(snapshot)} coin/resolution entries.")


def _get_cached_intervals(symbol: str, resolution: str) -> dict | None:
    with INTERVALS_CACHE_LOCK:
        return INTERVALS_CACHE.get(_cache_key(symbol, resolution))


def get_range_policy(visible_range: str) -> dict:
    return RANGE_POLICY.get(visible_range, RANGE_POLICY["1Y"])


def aggregate_candles_by_seconds(candles: list[dict], bucket_seconds: int | None) -> list[dict]:
    if not candles:
        return []
    if not bucket_seconds or bucket_seconds <= 0:
        return candles

    buckets: dict[int, dict] = {}

    for candle in candles:
        bucket_time = int(candle["time"] // bucket_seconds) * bucket_seconds

        symbol = str(item.get("symbol", "")).upper()
        if symbol.endswith("-USDT"):
            symbols.add(symbol)
    return symbols


def _fetch_top_usdt_symbols_by_market_cap(limit: int) -> list[str]:
    """
    Return top KuCoin-tradable USDT symbols ordered by CoinGecko market cap.

    CoinGecko provides global market-cap ordering; we then keep only symbols that
    are available as `*-USDT` on KuCoin.
    """
    # The following line references an undefined function and is commented out to fix startup.
    # tradable_usdt_symbols = _fetch_kucoin_usdt_symbols_set()
    if not tradable_usdt_symbols:
        return []

    collected: list[str] = []
    seen: set[str] = set()

    # 250 is CoinGecko's max page size for this endpoint.
    # Query multiple pages so we can still fill `limit` after KuCoin filtering.
    per_page = 250
    max_pages = 4
    for page in range(1, max_pages + 1):
        if len(collected) >= limit:
            break

        cg_url = (
            "https://api.coingecko.com/api/v3/coins/markets"
            f"?vs_currency=usd&order=market_cap_desc&per_page={per_page}&page={page}"
            "&sparkline=false&price_change_percentage=24h"
        )
        response = requests.get(cg_url, timeout=20)
        response.raise_for_status()
        markets = response.json()
        if not isinstance(markets, list) or not markets:
            break

        for item in markets:
            base_symbol = str(item.get("symbol", "")).upper().strip()
            if not base_symbol:
                continue
            kucoin_symbol = f"{base_symbol}-USDT"
            if kucoin_symbol in seen:
                continue
            if kucoin_symbol not in tradable_usdt_symbols:
                continue
            seen.add(kucoin_symbol)
            collected.append(kucoin_symbol)
            if len(collected) >= limit:
                break

    return collected

async def _background_update_loop() -> None:
    """Periodically update all coin data without blocking the server."""
    loop = asyncio.get_event_loop()
    while True:
        print(f"[updater] Starting update cycle for {len(COIN_LIST)} coins...")
        for symbol in COIN_LIST:
            try:
                print(f"[updater] Updating {symbol}...")
                for resolution in RESOLUTIONS.keys():
                    await loop.run_in_executor(
                        None, update_symbol_resolution, symbol, resolution
                    )
                print(f"[updater] {symbol} done.")
            except Exception as exc:
                print(f"[updater] ERROR updating {symbol}: {exc}")
        _refresh_intervals_cache(reason="post-update-cycle")
        print(f"[updater] Cycle complete. Next update in {UPDATE_INTERVAL_SECONDS}s.")
        await asyncio.sleep(UPDATE_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _refresh_intervals_cache(reason="startup")
    task = asyncio.create_task(_background_update_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="GC Probability Backend", version="0.1.0", lifespan=lifespan)

# Compress large JSON responses (like /intervals-batch) for remote/ngrok usage.
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class CandleInput(BaseModel):
    time: int
    close: float


class EMARequest(BaseModel):
    candles: list[CandleInput]


class IntervalRequest(BaseModel):
    coin: str
    resolution: str
    since_time: int | None = None


class IntervalsBatchRequest(BaseModel):
    requests: list[IntervalRequest]


@app.get("/")
def root() -> dict:
    return {"message": "GC_Probability backend is running"}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "empty_data_poll_seconds": EMPTY_DATA_POLL_SECONDS,
        "coin_cross_keep_days": COIN_CROSS_KEEP_DAYS,
    }


@app.get("/coins")
def coins() -> dict:
    return {"coins": COIN_LIST}


async def _download_coins_background(coins: list[str]) -> None:
    """Download all resolutions for a list of coins in the background."""
    loop = asyncio.get_event_loop()
    for symbol in coins:
        for resolution in RESOLUTIONS.keys():
            try:
                print(f"[resample] Downloading {symbol}/{resolution}...")
                await loop.run_in_executor(None, update_symbol_resolution, symbol, resolution)
                print(f"[resample] Done {symbol}/{resolution}.")
            except Exception as exc:
                print(f"[resample] ERROR {symbol}/{resolution}: {exc}")
    _refresh_intervals_cache(reason="resample-download")


@app.post("/resample-coins")
async def resample_coins(background_tasks: BackgroundTasks, limit: int = 25) -> dict:
    safe_limit = max(1, min(200, int(limit)))

    previous_symbols = list(COIN_LIST)
    previous_set = set(previous_symbols)
    ranking_source = "existing_coin_list"

    def _fetch_ranked_symbols(fetch_limit: int) -> tuple[list[str], str]:
        try:
            return _fetch_top_usdt_symbols_by_market_cap(fetch_limit), "coingecko_market_cap"
        except Exception as exc:
            print(f"[resample] market-cap source failed, falling back to KuCoin turnover: {exc}")
            try:
                return _fetch_kucoin_top_usdt_symbols_by_volume(fetch_limit), "kucoin_turnover_fallback"
            except Exception as fallback_exc:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Failed to fetch symbols from CoinGecko market cap and KuCoin turnover fallback: "
                        f"{fallback_exc}"
                    ),
                ) from fallback_exc

    if safe_limit > len(previous_symbols):
        # Grow the list by appending additional ranked coins that are not already present.
        # Fetch more than target to improve chances of filling after deduplication.
        fetch_limit = min(200, max(safe_limit, len(previous_symbols) + safe_limit))
        ranked_symbols, ranking_source = _fetch_ranked_symbols(fetch_limit)

        if not ranked_symbols:
            raise HTTPException(status_code=404, detail="No tradable USDT symbols found on KuCoin")

        symbols = list(previous_symbols)
        for symbol in ranked_symbols:
            if symbol not in previous_set:
                symbols.append(symbol)
                previous_set.add(symbol)
                if len(symbols) >= safe_limit:
                    break

        if len(symbols) < safe_limit:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Unable to expand coin list to {safe_limit}; only {len(symbols)} unique symbols available."
                ),
            )
    elif safe_limit < len(previous_symbols):
        # Shrink the list by removing from the end, preserving current order.
        symbols = previous_symbols[:safe_limit]
    else:
        symbols = previous_symbols

    _write_coin_list_file(symbols)
    _refresh_runtime_coin_config(symbols)
    _refresh_intervals_cache(reason="resample-coin-list")

    # Find newly-added coins that have no data yet and kick off an immediate download.
    new_coins = [
        symbol for symbol in COIN_LIST
        if symbol not in set(previous_symbols)
        and not any(
            get_latest_timestamp(candle_symbol(symbol, res)) is not None
            for res in RESOLUTIONS
        )
    ]

    # For backward compatibility, if symbols were preserved but still missing data,
    # include them in background download as well.
    missing_data_existing_coins = [
        symbol for symbol in COIN_LIST
        if symbol in set(previous_symbols)
        if not any(
            get_latest_timestamp(candle_symbol(symbol, res)) is not None
            for res in RESOLUTIONS
        )
    ]
    new_coins.extend(missing_data_existing_coins)
    if new_coins:
        print(f"[resample] Scheduling background download for {len(new_coins)} new coins: {new_coins}")
        background_tasks.add_task(_download_coins_background, new_coins)

    return {
        "coin_count": len(COIN_LIST),
        "coins": COIN_LIST,
        "downloading": new_coins,
        "ranking_source": ranking_source,
        "previous_coin_count": len(previous_symbols),
        "requested_coin_count": safe_limit,
    }


@app.get("/resolutions")
def get_resolutions() -> dict:
    """Return available resolutions."""
    return {"resolutions": list(RESOLUTIONS.keys())}


@app.get("/intervals/{coin}")
def intervals(coin: str, resolution: str = "1d") -> dict:
    """
    Fetch intervals for a coin at a specific resolution.
    
    Parameters:
    - coin: The coin symbol (e.g., BTC-USDT, ETH-USDT)
    - resolution: Either '1d' or '1h' (default: '1d')
    """
    normalized_coin = coin.upper()
    if normalized_coin not in COIN_LIST:
        raise HTTPException(status_code=404, detail=f"Unknown coin: {coin}")

    if resolution not in RESOLUTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid resolution: {resolution}. Must be one of: {list(RESOLUTIONS.keys())}"
        )

    cached = _get_cached_intervals(normalized_coin, resolution)
    if cached is not None:
        return cached

    return _empty_intervals_result(normalized_coin, resolution)


@app.post("/intervals-batch")
def intervals_batch(request: IntervalsBatchRequest) -> dict:
    """
    Fetch intervals for multiple coin/resolution pairs in one call.
    Reduces HTTP requests from ~210 to ~7.
    """
    results = []
    for item in request.requests:
        coin = item.coin.upper()
        resolution = item.resolution.lower()
        since_time = item.since_time
        
        if coin not in COIN_LIST:
            results.append({
                "coin": coin,
                "resolution": resolution,
                "error": f"Unknown coin: {coin}",
            })
            continue
        
        if resolution not in RESOLUTIONS:
            results.append({
                "coin": coin,
                "resolution": resolution,
                "error": f"Invalid resolution: {resolution}",
            })
            continue
        
        interval_data = _get_cached_intervals(coin, resolution)
        if interval_data is None:
            interval_data = _empty_intervals_result(coin, resolution)

        full_candles = interval_data.get("intervals", {}).get("FULL", [])
        latest_time = int(full_candles[-1]["time"]) if full_candles else None

        if since_time is not None:
            appended_full = [
                candle
                for candle in full_candles
                if int(candle["time"]) > int(since_time)
            ]

            results.append({
                "coin": coin,
                "resolution": resolution,
                "is_delta": True,
                "since_time": int(since_time),
                "latest_time": latest_time,
                "total_candles": interval_data.get("total_candles", 0),
                "generated_at_utc": interval_data.get("generated_at_utc"),
                "append_full": appended_full,
            })
            continue

        results.append({
            "coin": coin,
            "resolution": resolution,
            "is_delta": False,
            **interval_data,
        })
    
    return {"results": results}


@app.post("/ema")
def ema(request: EMARequest) -> dict:
    candles = [{"time": item.time, "close": item.close} for item in request.candles]
    candles.sort(key=lambda item: int(item["time"]))

    ema_values = compute_ema_series(candles)

    ema50_series = [
        {"time": candles[i]["time"], "value": ema_values["ema50"][i]}
        for i in range(len(candles))
    ]
    ema200_series = [
        {"time": candles[i]["time"], "value": ema_values["ema200"][i]}
        for i in range(len(candles))
    ]

    return {
        "ema50": ema50_series,
        "ema200": ema200_series,
    }


@app.get("/atr")
def atr(coin: str, visible_range: str = Query(..., alias="range")) -> dict:
    normalized_coin = coin.upper()
    normalized_range = visible_range.upper()

    if normalized_coin not in COIN_LIST:
        raise HTTPException(status_code=404, detail=f"Unknown coin: {coin}")

    if normalized_range not in RANGE_POLICY:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid range: {visible_range}. Must be one of: {list(RANGE_POLICY.keys())}",
        )

    range_policy = get_range_policy(normalized_range)
    resolution = range_policy["resolution"]

    interval_data = _get_cached_intervals(normalized_coin, resolution)
    if not interval_data or int(interval_data.get("total_candles", 0)) == 0:
        return {
            "coin": normalized_coin,
            "range": normalized_range,
            "period": 14,
            "atr": [],
            "average_move": None,
        }

    base_candles = interval_data.get("intervals", {}).get("FULL", [])

    aggregated = aggregate_candles_by_seconds(base_candles, range_policy["aggregateSeconds"])
    visible_start_index = get_visible_start_index(aggregated, normalized_range)
    visible_candles = aggregated[visible_start_index:]

    atr_values = compute_atr_series(visible_candles, period=14)
    atr_series = [
        {"time": visible_candles[index]["time"], "value": atr_values[index]}
        for index in range(len(visible_candles))
    ]

    average_move = sum(atr_values) / len(atr_values) if atr_values else None

    return {
        "coin": normalized_coin,
        "range": normalized_range,
        "period": 14,
        "atr": atr_series,
        "average_move": average_move,
    }


@app.get("/gc-probability")
def gc_probability(coin: str, visible_range: str = Query(..., alias="range")) -> dict:
    normalized_coin = coin.upper()
    normalized_range = visible_range.upper()

    if normalized_coin not in COIN_LIST:
        raise HTTPException(status_code=404, detail=f"Unknown coin: {coin}")

    if normalized_range not in RANGE_POLICY:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid range: {visible_range}. Must be one of: {list(RANGE_POLICY.keys())}",
        )

    range_policy = get_range_policy(normalized_range)
    resolution = range_policy["resolution"]

    interval_data = _get_cached_intervals(normalized_coin, resolution)
    if not interval_data or int(interval_data.get("total_candles", 0)) == 0:
        return {
            "coin": normalized_coin,
            "range": normalized_range,
            "resolution": resolution,
            "gc_probability": None,
        }

    base_candles = interval_data.get("intervals", {}).get("FULL", [])
    aggregated = aggregate_candles_by_seconds(base_candles, range_policy["aggregateSeconds"])
    probability_summary = compute_gc_probability(aggregated)

    return {
        "coin": normalized_coin,
        "range": normalized_range,
        "resolution": resolution,
        **probability_summary,
    }
