from pathlib import Path

from coin_list import COIN_LIST

# How often (seconds) the background loop updates coin history
UPDATE_INTERVAL_SECONDS = 150

# How often (seconds) the frontend polls for coins that returned empty data
EMPTY_DATA_POLL_SECONDS = 5

# In GCP mode, keep crossed coins visible for this many days after cross time.
COIN_CROSS_KEEP_DAYS = 2

# KuCoin REST API base URL
KUCOIN_BASE_URL = "https://api.kucoin.com"

# Candle endpoint
KUCOIN_CANDLES_ENDPOINT = "/api/v1/market/candles"

BACKEND_DIR = Path(__file__).resolve().parent
DB_PATH = BACKEND_DIR / "coindata.db"
OUTPUT_DIR = BACKEND_DIR / "data"

# Resolution-specific configuration
RESOLUTIONS = {
    "5m": {
        "kucoin_type": "5min",
        "candle_seconds": 300,
        "max_candles_per_request": 1500,
    },
    "10m": {
        "kucoin_type": "5min",
        "candle_seconds": 600,
        "max_candles_per_request": 1500,
    },
    "30m": {
        "kucoin_type": "30min",
        "candle_seconds": 1800,
        "max_candles_per_request": 1500,
    },
    "6h": {
        "kucoin_type": "6hour",
        "candle_seconds": 21600,
        "max_candles_per_request": 1500,
    },
    "12h": {
        "kucoin_type": "12hour",
        "candle_seconds": 43200,
        "max_candles_per_request": 1500,
    },
    "1d": {
        "kucoin_type": "1day",
        "candle_seconds": 86400,
        "max_candles_per_request": 1500,
    },
    "1h": {
        "kucoin_type": "1hour",
        "candle_seconds": 3600,
        "max_candles_per_request": 1500,
    },
}

# Interval lengths in days. None means use full daily dataset.
INTERVALS_IN_DAYS = {
    "1D": 1,
    "3D": 3,
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "6M": 180,
    "1Y": 365,
    "2Y": 730,
    "FULL": None,
}

# When True, write output JSON to OUTPUT_DIR
SAVE_DEBUG_JSON = False

# Output file name pattern
OUTPUT_FILE_TEMPLATE = "{symbol}_{resolution}_intervals.json"

