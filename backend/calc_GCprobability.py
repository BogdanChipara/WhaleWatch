from typing import Dict, List

from calc_ATR import compute_atr_series
from calc_EMA import compute_ema_series


LOOKBACK_CANDLE_COUNT = 10


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def _safe_divide(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def compute_gc_probability(candles: List[Dict[str, float | int]]) -> Dict[str, float | int | None]:
    """Compute the latest Golden Cross probability for a candle series."""
    if len(candles) < max(LOOKBACK_CANDLE_COUNT + 1, 200, 3):
        return {
            "probability": None,
            "lookback": LOOKBACK_CANDLE_COUNT,
            "atr": None,
        }

    ordered_candles = sorted(candles, key=lambda candle: int(candle["time"]))
    ema_values = compute_ema_series(ordered_candles)
    atr_values = compute_atr_series(ordered_candles, period=14)

    ema50 = ema_values["ema50"]
    ema200 = ema_values["ema200"]
    latest_index = len(ordered_candles) - 1

    if latest_index < 5:
        return {
            "probability": None,
            "lookback": LOOKBACK_CANDLE_COUNT,
            "atr": None,
        }

    ema50_t = ema50[latest_index]
    ema50_t1 = ema50[latest_index - 1]
    ema50_t2 = ema50[latest_index - 2]
    ema200_t = ema200[latest_index]
    ema200_t1 = ema200[latest_index - 1]
    ema200_t2 = ema200[latest_index - 2]
    ema200_t5 = ema200[latest_index - 5]
    atr_t = atr_values[latest_index] if atr_values else None

    if None in {ema50_t, ema50_t1, ema50_t2, ema200_t, ema200_t1, ema200_t2, ema200_t5} or atr_t is None:
        return {
            "probability": None,
            "lookback": LOOKBACK_CANDLE_COUNT,
            "atr": atr_t,
        }

    gap_t = float(ema50_t) - float(ema200_t)
    gap_t1 = float(ema50_t1) - float(ema200_t1)
    gap_t2 = float(ema50_t2) - float(ema200_t2)

    def _gate_debug():
        return {
            "gap_t": gap_t,
            "atr_t": atr_t,
            "ema200_t": float(ema200_t),
            "ema200_t5": float(ema200_t5),
            "distance_score": None,
            "velocity_score": None,
            "long_slope_score": None,
            "trend_quality_score": None,
        }

    if float(ema50_t) >= float(ema200_t):
        return {
            "probability": 0.0,
            "lookback": LOOKBACK_CANDLE_COUNT,
            "atr": atr_t,
            "debug": _gate_debug(),
        }

    if abs(gap_t) > (2.0 * atr_t):
        return {
            "probability": 0.0,
            "lookback": LOOKBACK_CANDLE_COUNT,
            "atr": atr_t,
            "debug": _gate_debug(),
        }

    distance_score = 1 - clamp(_safe_divide(abs(gap_t), 0.5 * atr_t))
    velocity_score = clamp(_safe_divide(gap_t - gap_t1, 0.25 * atr_t))
    acceleration_score = clamp(_safe_divide((gap_t - gap_t1) - (gap_t1 - gap_t2), 0.2 * atr_t))

    lookback = min(LOOKBACK_CANDLE_COUNT, latest_index)
    recent_candles = ordered_candles[-lookback:]
    recent_ema50 = ema50[-lookback:]
    closes_above_short = sum(
        1
        for candle, ema_point in zip(recent_candles, recent_ema50)
        if ema_point is not None and float(candle["close"]) > float(ema_point)
    )
    support_score = _safe_divide(closes_above_short, lookback)

    long_slope_score = clamp(
        _safe_divide((float(ema200_t) - float(ema200_t1)) + (0.05 * atr_t), 2 * (0.05 * atr_t))
    )

    latest_close = float(ordered_candles[latest_index]["close"])
    lookback_close = float(ordered_candles[latest_index - lookback]["close"])
    path_movement = sum(
        abs(
            float(ordered_candles[index]["close"]) - float(ordered_candles[index - 1]["close"])
        )
        for index in range(latest_index - lookback + 1, latest_index + 1)
    )
    trend_efficiency = _safe_divide(abs(latest_close - lookback_close), path_movement)
    volatility_support = clamp(_safe_divide(_safe_divide(atr_t, latest_close), 0.02))
    trend_quality_score = trend_efficiency * volatility_support

    gc_probability = (
        0.55 * distance_score
        + 0.15 * velocity_score
        + 0.07 * acceleration_score
        + 0.05 * support_score
        + 0.08 * long_slope_score
        + 0.08 * trend_quality_score
    )

    # path efficiency: penalise if long EMA is flat or falling over last 5 candles
    if float(ema200_t) <= float(ema200_t5):
        gc_probability *= 0.3

    return {
        "probability": clamp(gc_probability * 100.0, 0.0, 100.0),
        "lookback": lookback,
        "atr": atr_t,
        "debug": {
            "gap_t": gap_t,
            "atr_t": atr_t,
            "ema200_t": float(ema200_t),
            "ema200_t5": float(ema200_t5),
            "distance_score": distance_score,
            "velocity_score": velocity_score,
            "long_slope_score": long_slope_score,
            "trend_quality_score": trend_quality_score,
        },
    }