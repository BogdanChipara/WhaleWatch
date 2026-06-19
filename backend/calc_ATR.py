from typing import Dict, List


def compute_true_range(candles: List[Dict[str, float | int]]) -> List[float]:
    """
    Compute True Range (TR) for each candle.

    Candle schema requires: high, low, close.
    First candle uses TR = high - low.
    """
    if not candles:
        return []

    tr_values: List[float] = []

    for index, candle in enumerate(candles):
        high = float(candle["high"])
        low = float(candle["low"])

        if index == 0:
            tr_values.append(high - low)
            continue

        previous_close = float(candles[index - 1]["close"])

        range_high_low = high - low
        range_high_prev_close = abs(high - previous_close)
        range_low_prev_close = abs(low - previous_close)

        tr = max(range_high_low, range_high_prev_close, range_low_prev_close)
        tr_values.append(tr)

    return tr_values


def compute_atr_series(candles: List[Dict[str, float | int]], period: int = 14) -> List[float]:
    """
    Compute ATR series aligned to candles using EMA-style smoothing:
    ATR = alpha * TR + (1 - alpha) * previous_ATR
    where alpha = 2 / (period + 1).

    ATR is initialized with first TR value.
    Output length always equals input length.
    """
    tr_values = compute_true_range(candles)
    if not tr_values:
        return []

    alpha = 2 / (period + 1)

    atr_values: List[float] = []
    previous_atr = tr_values[0]
    atr_values.append(previous_atr)

    for tr in tr_values[1:]:
        atr = alpha * tr + (1 - alpha) * previous_atr
        atr_values.append(atr)
        previous_atr = atr

    return atr_values
