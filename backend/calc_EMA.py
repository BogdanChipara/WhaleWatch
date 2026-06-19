from typing import Dict, List, Optional


def _average(values: List[float]) -> float:
    return sum(values) / len(values)


def _compute_period_ema(
    closes: List[float],
    output: List[Optional[float]],
    window_start: int,
    period: int,
) -> None:
    """Compute EMA for one period over the provided full candle sequence."""
    if len(closes) < period:
        return

    multiplier = 2 / (period + 1)
    ema = _average(closes[:period])

    first_index = window_start + period - 1
    output[first_index] = ema

    for idx in range(period, len(closes)):
        ema = (closes[idx] * multiplier) + (ema * (1 - multiplier))
        output[window_start + idx] = ema


def compute_ema_series(candles: List[Dict[str, float | int]]) -> Dict[str, List[Optional[float]]]:
    """
    Compute EMA50 and EMA200 series from the provided candle list.

    Input candles are ordered oldest -> newest and each candle must include `close`.
    Output arrays always match input length. Values outside computable region are None.
    """
    total = len(candles)
    ema50: List[Optional[float]] = [None] * total
    ema200: List[Optional[float]] = [None] * total

    if total == 0:
        return {"ema50": ema50, "ema200": ema200}

    closes = [float(candle["close"]) for candle in candles]

    _compute_period_ema(closes, ema50, 0, period=50)
    _compute_period_ema(closes, ema200, 0, period=200)

    return {"ema50": ema50, "ema200": ema200}
