import sqlite3
from pathlib import Path
from typing import Iterable

DB_PATH = Path(__file__).resolve().parent / "coindata.db"


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_database() -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS candles (
                symbol TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                PRIMARY KEY (symbol, timestamp)
            )
            """
        )


def candle_symbol(symbol: str, resolution: str) -> str:
    return f"{symbol.upper()}__{resolution.lower()}"


def _normalize_candle(candle: dict | list | tuple) -> tuple[int, float, float, float, float, float]:
    if isinstance(candle, dict):
        ts = int(candle.get("timestamp", candle.get("time")))
        op = float(candle["open"])
        hi = float(candle["high"])
        lo = float(candle["low"])
        cl = float(candle["close"])
        vol = float(candle["volume"])
        return ts, op, hi, lo, cl, vol

    ts = int(candle[0])
    op = float(candle[1])
    hi = float(candle[2])
    lo = float(candle[3])
    cl = float(candle[4])
    vol = float(candle[5])
    return ts, op, hi, lo, cl, vol


def insert_candles(symbol: str, candles_list: Iterable[dict | list | tuple]) -> int:
    init_database()

    rows = []
    for candle in candles_list:
        ts, op, hi, lo, cl, vol = _normalize_candle(candle)
        rows.append((symbol, ts, op, hi, lo, cl, vol))

    if not rows:
        return 0

    with _get_connection() as conn:
        conn.executemany(
            """
            INSERT INTO candles (symbol, timestamp, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, timestamp) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume
            """,
            rows,
        )
    return len(rows)


def get_candles(symbol: str) -> list[dict]:
    init_database()
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT timestamp, open, high, low, close, volume
            FROM candles
            WHERE symbol = ?
            ORDER BY timestamp ASC
            """,
            (symbol,),
        ).fetchall()

    return [
        {
            "time": int(row["timestamp"]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
        }
        for row in rows
    ]


def get_latest_timestamp(symbol: str) -> int | None:
    init_database()
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT MAX(timestamp) AS latest FROM candles WHERE symbol = ?",
            (symbol,),
        ).fetchone()

    latest = row["latest"] if row else None
    return int(latest) if latest is not None else None


def get_earliest_timestamp(symbol: str) -> int | None:
    init_database()
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT MIN(timestamp) AS earliest FROM candles WHERE symbol = ?",
            (symbol,),
        ).fetchone()

    earliest = row["earliest"] if row else None
    return int(earliest) if earliest is not None else None


def delete_older_than(symbol: str, cutoff_timestamp: int) -> int:
    init_database()
    with _get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM candles WHERE symbol = ? AND timestamp < ?",
            (symbol, int(cutoff_timestamp)),
        )
        return cursor.rowcount
