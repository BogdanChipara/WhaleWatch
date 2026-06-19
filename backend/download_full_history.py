"""
download_full_history.py
Compatibility entrypoint for full-history downloads, stored in SQLite.
"""

from download_1candleper10minutes import download_symbol as download_10m
from download_1candleper12hours import download_symbol as download_12h
from download_1candleper30minutes import download_symbol as download_30m
from download_1candleper5minutes import download_symbol as download_5m
from download_1candleper6hours import download_symbol as download_6h
from download_1candleperday import download_symbol as download_1d
from download_1candleperhour import download_symbol as download_1h


def download_symbol(symbol: str, resolution: str) -> str | None:
    if resolution == "5m":
        return download_5m(symbol)
    if resolution == "10m":
        return download_10m(symbol)
    if resolution == "30m":
        return download_30m(symbol)
    if resolution == "6h":
        return download_6h(symbol)
    if resolution == "12h":
        return download_12h(symbol)
    if resolution == "1h":
        return download_1h(symbol)
    if resolution == "1d":
        return download_1d(symbol)
    raise ValueError(f"Unsupported resolution: {resolution}")
