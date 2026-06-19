import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from config import INTERVALS_IN_DAYS, OUTPUT_DIR, OUTPUT_FILE_TEMPLATE, SAVE_DEBUG_JSON, COIN_LIST, RESOLUTIONS
from database import candle_symbol, get_candles


Candle = Dict[str, float | int]


def aggregate_candle_group(group: List[Candle]) -> Candle:
    """Aggregate a consecutive group of daily candles into one candle."""
    return {
        "time": int(group[0]["time"]),
        "open": float(group[0]["open"]),
        "high": max(float(c["high"]) for c in group),
        "low": min(float(c["low"]) for c in group),
        "close": float(group[-1]["close"]),
        "volume": sum(float(c["volume"]) for c in group),
    }


def aggregate_by_days(candles: List[Candle], group_days: Optional[int]) -> List[Candle]:
    """Aggregate candles by fixed-size day groups. None keeps full daily series."""
    if not candles:
        return []

    if group_days is None:
        return candles

    if group_days <= 1:
        return candles

    aggregated: List[Candle] = []
    for index in range(0, len(candles), group_days):
        group = candles[index : index + group_days]
        if not group:
            continue
        aggregated.append(aggregate_candle_group(group))

    return aggregated


def build_intervals_for_symbol(symbol: str, csv_path: Path | None = None, resolution: str = "1d") -> Dict:
    """Build a JSON-serializable interval dictionary for one symbol and resolution."""
    storage_symbol = candle_symbol(symbol, resolution)
    candles = get_candles(storage_symbol)

    intervals: Dict[str, List[Candle]] = {}
    for name, days in INTERVALS_IN_DAYS.items():
        if name in {"1D", "FULL"}:
            intervals[name] = candles
            continue
        intervals[name] = aggregate_by_days(candles, days)

    result = {
        "symbol": symbol,
        "resolution": resolution,
        "source_file": "coindata.db",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "total_candles": len(candles),
        "intervals": intervals,
    }
    return result


def maybe_save_json(result: Dict) -> Optional[Path]:
    """Persist result to JSON if SAVE_DEBUG_JSON is enabled."""
    if not SAVE_DEBUG_JSON:
        return None

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    symbol = result["symbol"].replace("-", "_")
    resolution = result.get("resolution", "1d")
    output_path = OUTPUT_DIR / OUTPUT_FILE_TEMPLATE.format(symbol=symbol, resolution=resolution)

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)

    return output_path


def build_all_symbols() -> Dict[str, Dict]:
    """Build interval data for all configured symbols and resolutions."""
    output: Dict[str, Dict] = {}
    for symbol in COIN_LIST:
        for resolution in RESOLUTIONS.keys():
            if not get_candles(candle_symbol(symbol, resolution)):
                continue
            result = build_intervals_for_symbol(symbol, resolution=resolution)
            maybe_save_json(result)
            key = f"{symbol}_{resolution}"
            output[key] = result
    return output


def main() -> None:
    results = build_all_symbols()
    print(json.dumps({"symbols": list(results.keys())}, indent=2))


if __name__ == "__main__":
    main()
