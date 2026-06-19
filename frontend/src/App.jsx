import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { CoinChart } from './components/CoinChart.jsx'
import whaleLogo from './assets/WhaleWatch_Logo.svg'

const VISIBLE_RANGES = ['1D', '3D', '1W', '1M', '3M', '6M', '1Y', '2Y', 'FULL']
const DEFAULT_VISIBLE_RANGE = '1D'

const UPDATE_INTERVAL_SECONDS = 150
const DEFAULT_EMPTY_DATA_POLL_SECONDS = 5
const DEFAULT_COIN_CROSS_KEEP_DAYS = 2
const INTERVAL_CACHE_DB_NAME = 'gc_probability_cache'
const INTERVAL_CACHE_STORE_NAME = 'interval_cache'
const INTERVAL_CACHE_DB_VERSION = 1
const PROD_API_BASE_URL = 'https://whalewatch-production-9e12.up.railway.app'

const RANGE_TO_DAYS = {
  '1D': 1,
  '3D': 3,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  '2Y': 730,
}

const RANGE_POLICY = {
  '1D': { resolution: '5m', aggregateSeconds: null, candleLabel: '5 minutes' },
  '3D': { resolution: '10m', aggregateSeconds: 10 * 60, candleLabel: '10 minutes' },
  '1W': { resolution: '30m', aggregateSeconds: null, candleLabel: '30 minutes' },
  '1M': { resolution: '1h', aggregateSeconds: 2 * 3600, candleLabel: '2 hours' },
  '3M': { resolution: '6h', aggregateSeconds: null, candleLabel: '6 hours' },
  '6M': { resolution: '12h', aggregateSeconds: null, candleLabel: '12 hours' },
  '1Y': { resolution: '1d', aggregateSeconds: null, candleLabel: '1 day' },
  '2Y': { resolution: '1d', aggregateSeconds: 2 * 86400, candleLabel: '2 days' },
  'FULL': { resolution: '1d', aggregateSeconds: 10 * 86400, candleLabel: '10 days' },
}

function getRangePolicy(visibleRange) {
  return RANGE_POLICY[visibleRange] ?? RANGE_POLICY['1Y']
}

function aggregateCandlesBySeconds(candles, bucketSeconds) {
  if (!candles?.length) return []
  if (!bucketSeconds || bucketSeconds <= 0) return candles

  const buckets = new Map()

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucketTime)

    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })
      continue
    }

    existing.high = Math.max(existing.high, candle.high)
    existing.low = Math.min(existing.low, candle.low)
    existing.close = candle.close
    existing.volume += candle.volume
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
}

function computeEmaSeriesFromCandles(candles, period) {
  if (!candles?.length) return []

  const alpha = 2 / (period + 1)
  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time))
  const ema = []

  let prev = Number(sorted[0].close)
  ema.push({ time: sorted[0].time, value: prev })

  for (let i = 1; i < sorted.length; i += 1) {
    const close = Number(sorted[i].close)
    const next = (alpha * close) + ((1 - alpha) * prev)
    ema.push({ time: sorted[i].time, value: next })
    prev = next
  }

  return ema
}

function getVisibleStartIndex(candles, visibleRange) {
  if (!candles?.length) return 0
  if (visibleRange === 'FULL') return 0

  const days = RANGE_TO_DAYS[visibleRange]
  if (!days) return 0

  const latestTs = candles[candles.length - 1].time
  const cutoffTs = latestTs - days * 86400
  const firstVisibleIdx = candles.findIndex((candle) => candle.time >= cutoffTs)
  return firstVisibleIdx === -1 ? candles.length : firstVisibleIdx
}

function normalizeGcProbability(value) {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.min(100, parsed))
}

let activeTransferTracker = null

function setActiveTransferTracker(tracker) {
  activeTransferTracker = tracker
}

function measureResponseBytes(response) {
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  // Avoid cloning/reading full response bodies for size estimation because
  // it can dramatically slow large payloads (especially with chunked/gzip responses).
  return 0
}

function apiFetch(input, init = {}) {
  const { trackTransfer = true, ...fetchInit } = init
  const headers = new Headers(init.headers ?? {})
  const isApiPath = typeof input === 'string' && input.startsWith('/api/')
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

  const requestCandidates = (() => {
    if (!isApiPath) return [input]
    if (isLocalhost) return [input]

    const direct = `${PROD_API_BASE_URL}${input.replace(/^\/api/, '')}`
    // Try both routes so production still works if either direct CORS/network
    // or Vercel rewrite configuration is temporarily failing.
    return [direct, input]
  })()
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    const isNgrokHost =
      host.endsWith('ngrok-free.dev') ||
      host.endsWith('ngrok-free.app') ||
      host.endsWith('ngrok.io')
    if (isNgrokHost) {
      // Bypass ngrok browser warning page so API endpoints return JSON.
      headers.set('ngrok-skip-browser-warning', 'true')
    }
  }
  const fetchWithTracking = (target) => fetch(target, { ...fetchInit, headers }).then((response) => {
    if (trackTransfer && activeTransferTracker) {
      const bytes = measureResponseBytes(response)
      activeTransferTracker(bytes)
    }
    return response
  })

  const tryRequest = async () => {
    let lastResponse = null
    let lastError = null

    for (const candidate of requestCandidates) {
      try {
        const response = await fetchWithTracking(candidate)
        if (response.ok) return response
        lastResponse = response
      } catch (error) {
        lastError = error
      }
    }

    if (lastResponse) return lastResponse
    throw lastError ?? new Error('Request failed')
  }

  return tryRequest()
}

function formatTransferredData(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB transferred'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 10) return `${megabytes.toFixed(0)} MB transferred`
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB transferred`
  const kilobytes = bytes / 1024
  return `${kilobytes.toFixed(0)} KB transferred`
}

class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent
    this.running = 0
    this.queue = []
  }

  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise((resolve) => this.queue.push(resolve))
    }
    this.running += 1
    try {
      return await fn()
    } finally {
      this.running -= 1
      const resolve = this.queue.shift()
      if (resolve) resolve()
    }
  }
}

function chunkArray(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

async function fetchIntervalsBatch(requests, limiter) {
  /**
   * Batch fetch intervals in chunks. Each chunk is sent as one API request.
   * Returns { coin: {...}, resolution: {...}, ...intervalData }
   */
  const chunks = chunkArray(requests, 30) // 30 coin/resolution pairs per request
  const allResults = []

  for (const chunk of chunks) {
    const result = await limiter.run(async () => {
      const response = await apiFetch('/api/intervals-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: chunk }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      return data.results || []
    })
    allResults.push(...result)
  }

  return allResults
}

function mergeFullCandles(existingFull, appendFull) {
  const base = Array.isArray(existingFull) ? existingFull : []
  const append = Array.isArray(appendFull) ? appendFull : []
  if (append.length === 0) return base
  if (base.length === 0) return append

  const lastBaseTime = Number(base[base.length - 1]?.time ?? -Infinity)
  const filteredAppend = append.filter((candle) => Number(candle?.time) > lastBaseTime)
  if (filteredAppend.length === 0) return base

  return [...base, ...filteredAppend]
}

function getLatestFullCandleTime(intervalData) {
  const full = intervalData?.intervals?.FULL
  if (!Array.isArray(full) || full.length === 0) return null
  const latestTime = Number(full[full.length - 1]?.time)
  return Number.isFinite(latestTime) ? latestTime : null
}

function openIntervalCacheDb() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(INTERVAL_CACHE_DB_NAME, INTERVAL_CACHE_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(INTERVAL_CACHE_STORE_NAME)) {
        db.createObjectStore(INTERVAL_CACHE_STORE_NAME, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadIntervalCacheMap() {
  const db = await openIntervalCacheDb()
  if (!db) return {}

  return new Promise((resolve, reject) => {
    const tx = db.transaction(INTERVAL_CACHE_STORE_NAME, 'readonly')
    const store = tx.objectStore(INTERVAL_CACHE_STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      const map = {}
      const rows = Array.isArray(request.result) ? request.result : []
      rows.forEach((row) => {
        const coin = row?.coin
        const resolution = row?.resolution
        const data = row?.data
        if (!coin || !resolution || !data) return
        if (!map[coin]) map[coin] = {}
        map[coin][resolution] = data
      })
      resolve(map)
    }

    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onabort = () => db.close()
  })
}

async function persistIntervalCacheEntry(coin, resolution, data) {
  const db = await openIntervalCacheDb()
  if (!db) return

  await new Promise((resolve, reject) => {
    const tx = db.transaction(INTERVAL_CACHE_STORE_NAME, 'readwrite')
    const store = tx.objectStore(INTERVAL_CACHE_STORE_NAME)

    store.put({
      key: `${coin}__${resolution}`,
      coin,
      resolution,
      data,
      updatedAt: Date.now(),
    })

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }).finally(() => {
    db.close()
  })
}

async function clearPersistentIntervalCache() {
  const db = await openIntervalCacheDb()
  if (!db) return

  await new Promise((resolve, reject) => {
    const tx = db.transaction(INTERVAL_CACHE_STORE_NAME, 'readwrite')
    const store = tx.objectStore(INTERVAL_CACHE_STORE_NAME)
    store.clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }).finally(() => {
    db.close()
  })
}

function LazyChartMount({ children, fallback }) {
  const mountRef = useRef(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    if (!mountRef.current || isVisible) return

    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries.some((entry) => entry.isIntersecting)
        if (isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      {
        root: null,
        rootMargin: '500px 0px',
        threshold: 0,
      },
    )

    observer.observe(mountRef.current)

    return () => observer.disconnect()
  }, [isVisible])

  return (
    <div ref={mountRef} style={{ width: '100%', height: '100%' }}>
      {isVisible ? children : fallback}
    </div>
  )
}

class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    console.error('[CHART] Render crash:', error)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="chart-overlay">
          <p className="error-message">Chart failed to render.</p>
        </div>
      )
    }

    return this.props.children
  }
}

export default function App() {
  const initialCoinLimitPreferenceRef = useRef(null)
  if (initialCoinLimitPreferenceRef.current === null) {
    try {
      const raw = localStorage.getItem('gc_probability_coin_limit')
      const parsed = Number(raw)
      if (parsed === 25 || parsed === 50) {
        initialCoinLimitPreferenceRef.current = parsed
      } else {
        initialCoinLimitPreferenceRef.current = 25
      }
    } catch {
      initialCoinLimitPreferenceRef.current = 25
    }
  }

  const [allCoins, setAllCoins] = useState([])
  const [activeCoinLimit, setActiveCoinLimit] = useState(25)
  const [requestedCoinLimit, setRequestedCoinLimit] = useState(initialCoinLimitPreferenceRef.current)
  const coins = useMemo(() => allCoins.slice(0, activeCoinLimit), [allCoins, activeCoinLimit])
  const [displayMode, setDisplayMode] = useState('gcp')
  const [pinnedCards, setPinnedCards] = useState([])
  const [showCrossedInGcpMode, setShowCrossedInGcpMode] = useState(true)
  const [compactMode, setCompactMode] = useState(true)
  const [selectedVisibleRangeByCoins, setSelectedVisibleRangeByCoins] = useState({})
  const [gcpSelectedRangeByCard, setGcpSelectedRangeByCard] = useState({})

  // Cache fetched interval data per coin and resolution: { 'BTC-USDT': { '1d': {...}, '1h': {...} } }
  const cache = useRef({})
  const [intervalDataByCoins, setIntervalDataByCoins] = useState({})
  const [atrSummaryByCoins, setAtrSummaryByCoins] = useState({})
  const [gcProbabilityByCoins, setGcProbabilityByCoins] = useState({})
  const [loadingCoinRanges, setLoadingCoinRanges] = useState(new Set())
  const [loadingStage, setLoadingStage] = useState(null) // 'coins' | 'intervals' | 'gc' | null
  const [loadingStageStartTime, setLoadingStageStartTime] = useState(null)
  const [errorsByCoins, setErrorsByCoins] = useState({})
  const [refreshTick, setRefreshTick] = useState(0)
  const [lastTransferBytes, setLastTransferBytes] = useState(0)
  const gcWorkerRef = useRef(null)
  const gcRequestSeqRef = useRef(0)
  const didEnforceDefaultCoinLimitRef = useRef(false)
  const lastProcessedRefreshTickRef = useRef(0)
  const currentTransferBytesRef = useRef(0)
  const isTransferTrackingActiveRef = useRef(false)
  const [emptyDataPollSeconds, setEmptyDataPollSeconds] = useState(DEFAULT_EMPTY_DATA_POLL_SECONDS)
  const [coinCrossKeepDays, setCoinCrossKeepDays] = useState(DEFAULT_COIN_CROSS_KEEP_DAYS)
  const [isPersistentCacheReady, setIsPersistentCacheReady] = useState(false)
  const isInitialMountRef = useRef(true)

  // Load pinned cards from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('gc_probability_pinned_cards')
      if (stored) {
        const parsed = JSON.parse(stored).map((card) => ({
          ...card,
          pinnedAt: Number(card?.pinnedAt) || Math.floor(Date.now() / 1000),
        }))
        setPinnedCards(parsed)
      }
    } catch (err) {
      console.warn('[STORAGE] Failed to load pinned cards from localStorage', err)
    }
  }, [])

  // Save pinned cards to localStorage whenever they change (skip initial mount to allow load to complete first)
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false
      return
    }
    try {
      localStorage.setItem('gc_probability_pinned_cards', JSON.stringify(pinnedCards))
    } catch (err) {
      console.warn('[STORAGE] Failed to save pinned cards to localStorage', err)
    }
  }, [pinnedCards])

  const startLoadingStage = (stage) => {
    setLoadingStage(stage)
    setLoadingStageStartTime(Date.now())
  }

  const beginTransferTracking = () => {
    currentTransferBytesRef.current = 0
    isTransferTrackingActiveRef.current = true
    setLastTransferBytes(0)
  }

  const finishTransferTracking = () => {
    isTransferTrackingActiveRef.current = false
    setLastTransferBytes(currentTransferBytesRef.current)
  }

  useEffect(() => {
    setActiveTransferTracker((bytes) => {
      if (!isTransferTrackingActiveRef.current) return
      currentTransferBytesRef.current += bytes
    })

    return () => setActiveTransferTracker(null)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('gc_probability_coin_limit', String(requestedCoinLimit))
    } catch {
      // Ignore localStorage failures (e.g. private mode restrictions)
    }
  }, [requestedCoinLimit])

  const loadCoins = async () => {
    console.log('[LOAD] Starting coins fetch')
    beginTransferTracking()
    startLoadingStage('coins')
    try {
      let response = await apiFetch('/api/coins')
      if (!response.ok) throw new Error(`Failed to fetch coins (HTTP ${response.status})`)
      let data = await response.json()

      setAllCoins(data.coins)
      setActiveCoinLimit(requestedCoinLimit)
      const initialRanges = {}
      data.coins.forEach((coin) => {
        initialRanges[coin] = selectedVisibleRangeByCoins[coin] ?? DEFAULT_VISIBLE_RANGE
      })
      setSelectedVisibleRangeByCoins(initialRanges)
      setErrorsByCoins({})
      console.log('[LOAD] Coins loaded, starting intervals stage')
      startLoadingStage('intervals')
    } catch (err) {
      setErrorsByCoins({ _global: err.message })
      setLoadingStage(null)
      setLoadingStageStartTime(null)
    }
  }

  // Fetch coin list on mount
  useEffect(() => {
    let cancelled = false

    loadIntervalCacheMap()
      .then((persistedCache) => {
        if (cancelled) return
        cache.current = persistedCache
        const entryCount = Object.values(persistedCache).reduce(
          (sum, coinMap) => sum + Object.keys(coinMap ?? {}).length,
          0,
        )
        console.log(`[CACHE] Hydrated ${entryCount} coin/resolution entries from IndexedDB`)
      })
      .catch((error) => {
        console.warn('[CACHE] Failed to hydrate IndexedDB cache', error)
      })
      .finally(() => {
        if (cancelled) return
        setIsPersistentCacheReady(true)
        loadCoins()
      })

    apiFetch('/api/health', { trackTransfer: false })
      .then((r) => r.json())
      .then((data) => {
        if (data.empty_data_poll_seconds !== undefined && data.empty_data_poll_seconds !== null) {
          setEmptyDataPollSeconds(data.empty_data_poll_seconds)
        }
        if (data.coin_cross_keep_days !== undefined && data.coin_cross_keep_days !== null) {
          setCoinCrossKeepDays(data.coin_cross_keep_days)
        }
      })
      .catch(() => {})

    const worker = new Worker(new URL('./WebWorkerCalc_GCprobability.js', import.meta.url), { type: 'module' })
    worker.onmessage = (event) => {
      const { type, requestId, results } = event.data || {}
      if (requestId !== gcRequestSeqRef.current) return

      if (type === 'gc_batch_result' && Array.isArray(results)) {
        setGcProbabilityByCoins((prev) => {
          const next = { ...prev }
          results.forEach((item) => {
            if (!next[item.coin]) next[item.coin] = {}
            next[item.coin][item.range] = {
              probability: item.probability,
              debug: item.debug ?? null,
              crossedAt: item.crossedAt ?? null,
              crossedProbability: item.crossedProbability ?? null,
            }
          })
          return next
        })

        setAtrSummaryByCoins((prev) => {
          const next = { ...prev }
          results.forEach((item) => {
            if (!next[item.coin]) next[item.coin] = {}
            next[item.coin][item.range] = {
              averageMove: item.averageMove ?? null,
              period: item.period ?? 14,
            }
          })
          return next
        })
        return
      }

      if (type === 'gc_batch_complete') {
        finishTransferTracking()
        setLoadingStage(null)
        setLoadingStageStartTime(null)
      }
    }
    gcWorkerRef.current = worker

    return () => {
      cancelled = true
      worker.terminate()
      gcWorkerRef.current = null
    }
  }, [])

  const handleResampleCoins = (limit) => {
    setRequestedCoinLimit(limit)
    setActiveCoinLimit(limit)
    setGcpSelectedRangeByCard({})
    setRefreshTick((tick) => tick + 1)
  }

  const setVisibleRangeForCoin = (coin, range) => {
    setSelectedVisibleRangeByCoins((prev) => ({
      ...prev,
      [coin]: range,
    }))
  }

  const getPinnedCardId = (card) => (
    card.sourceMode === 'gcp'
      ? `gcp__${card.coin}__${card.range}`
      : `coin__${card.coin}`
  )

  const pinnedCardIds = useMemo(
    () => new Set(pinnedCards.map((card) => getPinnedCardId(card))),
    [pinnedCards],
  )

  const togglePinnedCard = (card) => {
    const cardId = getPinnedCardId(card)
    setPinnedCards((prev) => {
      const exists = prev.some((item) => getPinnedCardId(item) === cardId)
      if (exists) {
        return prev.filter((item) => getPinnedCardId(item) !== cardId)
      }
      const pinTs = Number(card?.pinMarkerAt)
      return [...prev, { ...card, pinnedAt: Number.isFinite(pinTs) ? pinTs : Math.floor(Date.now() / 1000) }]
    })
  }

  const updatePinnedCardRange = (cardId, range) => {
    setPinnedCards((prev) => prev.map((card) => (
      getPinnedCardId(card) === cardId
        ? { ...card, selectedRange: range }
        : card
    )))
  }

  const isPinnedCardCrossed = (card) => {
    if (card.sourceMode === 'gcp') {
      const baseGcData = gcProbabilityByCoins[card.coin]?.[card.range]
      return card.crossedAt !== null && normalizeGcProbability(baseGcData?.probability) === 0
    }

    const selectedRange = card.selectedRange ?? DEFAULT_VISIBLE_RANGE
    const gcCoinData = gcProbabilityByCoins[card.coin]?.[selectedRange]
    return gcCoinData?.crossedAt !== null && normalizeGcProbability(gcCoinData?.probability) === 0
  }

  // Fetch interval data for all coins and all visible ranges using batch endpoint.
  // Reduces ~210 individual requests to ~7 batch requests with concurrency limiting.
  useEffect(() => {
    if (loadingStage !== 'intervals') return
    if (!isPersistentCacheReady) return
    if (coins.length === 0) return

    // Always fetch fresh data on first load so backend candle corrections are reflected.
    const shouldUseCache = false
    const isIncrementalRefresh = refreshTick > 0
    const newLoadingCoinRanges = new Set()

    // Build the initial loading set so the UI can show spinners immediately
    coins.forEach((coin) => {
      if (!cache.current[coin]) cache.current[coin] = {}
      VISIBLE_RANGES.forEach((range) => {
        const resolution = getRangePolicy(range).resolution
        if (!(shouldUseCache && cache.current[coin][resolution])) {
          newLoadingCoinRanges.add(`${coin}__${range}`)
        }
      })
    })
    setLoadingCoinRanges(newLoadingCoinRanges)

    // Collect all coin/resolution pairs that need fetching
    const toFetch = []
    const rangesByKey = {} // map of "coin__resolution" to array of ranges

    coins.forEach((coin) => {
      VISIBLE_RANGES.forEach((range) => {
        const resolution = getRangePolicy(range).resolution
        if (shouldUseCache && cache.current[coin][resolution]) {
          // Already cached — merge into state immediately
          const data = cache.current[coin][resolution]
          setIntervalDataByCoins((prev) => {
            const next = { ...prev, [coin]: { ...(prev[coin] ?? {}) } }
            next[coin][range] = data
            return next
          })
          setLoadingCoinRanges((prev) => {
            const next = new Set(prev)
            next.delete(`${coin}__${range}`)
            return next
          })
        } else {
          // Mark for batch fetch
          const existing = cache.current[coin][resolution]
          const sinceTime = isIncrementalRefresh ? getLatestFullCandleTime(existing) : null
          toFetch.push({
            coin,
            resolution,
            range,
            since_time: sinceTime,
          })
          const key = `${coin}__${resolution}`
          if (!rangesByKey[key]) rangesByKey[key] = []
          rangesByKey[key].push(range)
        }
      })
    })

    if (toFetch.length === 0) {
      startLoadingStage('gc')
      return
    }

    // Deduplicate: build one request per coin/resolution pair
    const batchRequests = Object.entries(rangesByKey).map(([key, ranges]) => {
      const [coin, resolution] = key.split('__')
      const existing = cache.current[coin]?.[resolution]
      const sinceTime = isIncrementalRefresh ? getLatestFullCandleTime(existing) : null
      return {
        coin,
        resolution,
        since_time: sinceTime,
      }
    })
    console.log(`[LOAD] Starting intervals batch fetch for ${batchRequests.length} coin/resolution pairs`)

    // Fetch with concurrency limiting (max 3 concurrent batch requests)
    const limiter = new ConcurrencyLimiter(3)
    fetchIntervalsBatch(batchRequests, limiter)
      .then((results) => {
        const nextIntervalData = {}
        const nextErrors = {}

        results.forEach((item) => {
          const { coin, resolution, error } = item
          const ranges = rangesByKey[`${coin}__${resolution}`] || []

          if (error) {
            ranges.forEach((range) => {
              nextErrors[`${coin}__${range}`] = error
            })
          } else {
            cache.current[coin] = cache.current[coin] || {}

            if (item.is_delta) {
              const existing = cache.current[coin][resolution]
              const existingFull = existing?.intervals?.FULL ?? []
              const mergedFull = mergeFullCandles(existingFull, item.append_full)

              const merged = existing
                ? {
                    ...existing,
                    generated_at_utc: item.generated_at_utc ?? existing.generated_at_utc,
                    total_candles: item.total_candles ?? mergedFull.length,
                    intervals: {
                      ...existing.intervals,
                      FULL: mergedFull,
                    },
                  }
                : {
                    coin,
                    resolution,
                    generated_at_utc: item.generated_at_utc ?? null,
                    total_candles: item.total_candles ?? mergedFull.length,
                    intervals: {
                      FULL: mergedFull,
                    },
                  }

              cache.current[coin][resolution] = merged
            } else {
              cache.current[coin][resolution] = item
            }

            const normalizedData = cache.current[coin][resolution]
            persistIntervalCacheEntry(coin, resolution, normalizedData).catch(() => {})
            ranges.forEach((range) => {
              if (!nextIntervalData[coin]) nextIntervalData[coin] = {}
              nextIntervalData[coin][range] = normalizedData
            })
          }
        })

        // Update state with all results at once
        if (Object.keys(nextIntervalData).length > 0) {
          setIntervalDataByCoins((prev) => {
            const next = { ...prev }
            Object.entries(nextIntervalData).forEach(([coin, ranges_data]) => {
              next[coin] = { ...next[coin], ...ranges_data }
            })
            return next
          })
        }

        if (Object.keys(nextErrors).length > 0) {
          setErrorsByCoins((prev) => ({ ...prev, ...nextErrors }))
        }
      })
      .catch((err) => {
        const allKeys = toFetch.map((item) => `${item.coin}__${item.range}`)
        const nextErrors = {}
        allKeys.forEach((key) => {
          nextErrors[key] = err.message
        })
        setErrorsByCoins((prev) => ({ ...prev, ...nextErrors }))
      })
      .finally(() => {
          console.log('[LOAD] Intervals batch fetch complete')
        const allKeys = toFetch.map((item) => `${item.coin}__${item.range}`)
        setLoadingCoinRanges((prev) => {
          const next = new Set(prev)
          allKeys.forEach((key) => next.delete(key))
          return next
        })
        startLoadingStage('gc')
      })
  }, [coins, refreshTick, loadingStage])

  // Poll coins that have no candle data yet, until their data arrives.
  useEffect(() => {
    const id = setInterval(() => {
      const emptyCoins = coins.filter((coin) => {
        const coinData = intervalDataByCoins[coin]
        if (!coinData) return true
        return VISIBLE_RANGES.every((range) => {
          const d = coinData[range]
          return !d || !d.intervals || Object.keys(d.intervals).length === 0
        })
      })
      if (emptyCoins.length === 0) return

      // Use batch fetching for retry attempts too
      const batchRequests = []
      emptyCoins.forEach((coin) => {
        VISIBLE_RANGES.forEach((range) => {
          const resolution = getRangePolicy(range).resolution
          batchRequests.push({ coin, resolution })
        })
      })

      const limiter = new ConcurrencyLimiter(2)
      fetchIntervalsBatch(batchRequests, limiter)
        .then((results) => {
          let hasNewIntervalData = false
          results.forEach((item) => {
            const { coin, resolution, intervals } = item
            if (!intervals || Object.keys(intervals).length === 0) return
            hasNewIntervalData = true
            cache.current[coin] = { ...(cache.current[coin] ?? {}), [resolution]: item }
            persistIntervalCacheEntry(coin, resolution, item).catch(() => {})
            VISIBLE_RANGES.filter((range) => getRangePolicy(range).resolution === resolution).forEach((range) => {
              setIntervalDataByCoins((prev) => {
                const next = { ...prev, [coin]: { ...(prev[coin] ?? {}) } }
                next[coin][range] = item
                return next
              })
            })
          })

          // Some coins can arrive after the initial GC pass; re-run GC when that happens.
          if (hasNewIntervalData) {
            startLoadingStage('gc')
          }
        })
        .catch(() => {})
    }, emptyDataPollSeconds * 1000)
    return () => clearInterval(id)
  }, [coins, intervalDataByCoins, emptyDataPollSeconds])

  // Create aggregated candles and EMA data for all coins
  const allCoinsData = useMemo(() => {
    const result = {}
    coins.forEach((coin) => {
      result[coin] = {}
      VISIBLE_RANGES.forEach((range) => {
        const rangePolicy = getRangePolicy(range)
        const aggregateSeconds = rangePolicy.aggregateSeconds

        const intervalData = intervalDataByCoins[coin]?.[range]
        const base = intervalData?.intervals?.FULL ?? null
        if (!base) {
          result[coin][range] = {
            baseAggregatedCandles: null,
            candles: null,
            visibleStartIndex: 0,
            ema50: [],
            ema200: [],
            rangePolicy,
          }
          return
        }

        const baseAggregatedCandles = aggregateCandlesBySeconds(base, aggregateSeconds)
        const startIndex = getVisibleStartIndex(baseAggregatedCandles, range)
        const candles = baseAggregatedCandles.slice(startIndex)

        const fullEma50 = computeEmaSeriesFromCandles(baseAggregatedCandles, 50)
        const fullEma200 = computeEmaSeriesFromCandles(baseAggregatedCandles, 200)
        const visibleStartTime = candles[0]?.time ?? Infinity
        const ema50 = fullEma50.filter((p) => Number(p.time) >= visibleStartTime)
        const ema200 = fullEma200.filter((p) => Number(p.time) >= visibleStartTime)

        result[coin][range] = {
          baseAggregatedCandles,
          candles,
          visibleStartIndex: startIndex,
          ema50,
          ema200,
          rangePolicy,
        }
      })
    })
    return result
  }, [coins, intervalDataByCoins])

  // Compute GC probability in a Web Worker from the full aggregated candle history.
  // The chart EMAs are computed from full history and only then sliced for display,
  // so GC must use the same source candles or it can disagree with the chart.
  // Debounced 300 ms: during a refresh coins arrive one by one, so allCoinsData updates
  // ~30 times. Without a debounce we would clear + recompute GC 30 times, causing
  // the GCP card list to flicker. Old GC values are intentionally kept visible until
  // the worker returns updated ones, so there is no blank flash on refresh.
  useEffect(() => {
    if (loadingStage !== 'gc') return
    if (coins.length === 0) {
      setGcProbabilityByCoins({})
      return
    }
    if (!gcWorkerRef.current) return

    const timeoutId = setTimeout(() => {
        console.log('[LOAD] GC debounce complete (300ms), about to post to worker')
      const requestId = ++gcRequestSeqRef.current

      const items = []
      coins.forEach((coin) => {
        VISIBLE_RANGES.forEach((range) => {
          const candles = allCoinsData[coin]?.[range]?.baseAggregatedCandles ?? []
          items.push({ coin, range, candles })
        })
      })

      console.log('[LOAD] Setting loadingStage to gc')
      gcWorkerRef.current?.postMessage({
        type: 'compute_gc_batch',
        requestId,
        items,
      })
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [coins, allCoinsData, loadingStage])

  // Trigger re-render every 100ms to show elapsed time during loading
  const [, setElapsedTimeCounter] = useState(0)
  useEffect(() => {
    if (!loadingStage) return
    const interval = setInterval(() => setElapsedTimeCounter((c) => c + 1), 100)
    return () => clearInterval(interval)
  }, [loadingStage])

  const [countdown, setCountdown] = useState(UPDATE_INTERVAL_SECONDS)

  useEffect(() => {
    setCountdown(UPDATE_INTERVAL_SECONDS)
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          setRefreshTick((tick) => tick + 1)
          return UPDATE_INTERVAL_SECONDS
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (refreshTick === 0) return
    if (refreshTick === lastProcessedRefreshTickRef.current) return
    if (coins.length === 0) return
    if (loadingStage !== null) return
    lastProcessedRefreshTickRef.current = refreshTick
    beginTransferTracking()
    startLoadingStage('intervals')
  }, [refreshTick, coins.length, loadingStage])

  const renderPinButton = (card) => {
    const cardId = getPinnedCardId(card)
    const isPinned = pinnedCardIds.has(cardId)

    return (
      <button
        type="button"
        className={`pin-chart-btn ${isPinned ? 'active' : ''}`}
        title={isPinned ? 'Unpin chart' : 'Pin chart'}
        onClick={() => togglePinnedCard(card)}
      >
        {isPinned ? 'pinned' : 'pin'}
      </button>
    )
  }

  const renderChartCard = (coin, range, displayRange = range, crossedAt = null, options = {}) => {
    const {
      reactKey = `${coin}__${range}`,
      onSelectRange,
      headerAction = null,
      pinMarkerTime = null,
    } = options
    const coinData = allCoinsData[coin]?.[displayRange]
    const atrSummary = atrSummaryByCoins[coin]?.[displayRange]
    const gcBaseData = gcProbabilityByCoins[coin]?.[range]
    const gcCoinData = gcProbabilityByCoins[coin]?.[displayRange]
    const gcProbabilityDisplay = normalizeGcProbability(gcCoinData?.probability)
    const gcDebug = gcCoinData?.debug ?? null
    const hasCrossed = crossedAt !== null && normalizeGcProbability(gcBaseData?.probability) === 0
    const crossedProbability = normalizeGcProbability(gcBaseData?.crossedProbability)
    const gcProbability = hasCrossed ? (crossedProbability ?? 0) : gcProbabilityDisplay
    const coinRangeKey = `${coin}__${displayRange}`
    const isLoading = loadingCoinRanges.has(coinRangeKey)
    const hasError = errorsByCoins[coinRangeKey]
    const candleLabel = coinData?.rangePolicy?.candleLabel ?? 'N/A'
    const averageMoveText = atrSummary?.averageMove === null || atrSummary?.averageMove === undefined
      ? 'N/A'
      : Number(atrSummary.averageMove).toFixed(4)
    const gcProbabilityText = gcProbability === null || gcProbability === undefined
      ? 'N/A'
      : `${Number(gcProbability).toFixed(1)}%`
    const crossedBadgeText = hasCrossed ? `Crossed at ${gcProbabilityText} probability` : null
    const openBadgeText = hasCrossed ? null : `GC probability: ${gcProbabilityText}`
    const intervalMoveInfo = (() => {
      const displayCandles = coinData?.candles ?? []
      if (!displayCandles.length) return null

      const lastClose = Number(displayCandles[displayCandles.length - 1]?.close)
      if (!Number.isFinite(lastClose)) return null

      let baseIndex = 0
      let crossVisibleInTimeframe = false

      if (hasCrossed && crossedAt !== null) {
        const firstCandleTime = Number(displayCandles[0]?.time)
        if (Number(crossedAt) >= firstCandleTime) {
          // Cross happened within the displayed range
          const crossIdx = displayCandles.findIndex((c) => Number(c.time) >= Number(crossedAt))
          if (crossIdx >= 0) {
            baseIndex = crossIdx
            crossVisibleInTimeframe = true
          }
        }
        // else: cross happened before the displayed range; baseIndex stays 0, crossVisibleInTimeframe stays false
      }

      const baseClose = Number(displayCandles[baseIndex]?.close)
      if (!Number.isFinite(baseClose) || baseClose === 0) return null

      const pct = ((lastClose - baseClose) / baseClose) * 100
      const prefix = crossVisibleInTimeframe ? 'Since crossed' : 'For current interval'
      const text = `${prefix} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%.`

      return { pct, text }
    })()
    // Keep backward-compatible name for crossed cards; open cards always use intervalMoveInfo
    const crossedMoveInfo = hasCrossed ? intervalMoveInfo : null
    const crossMarkerTime = displayRange === range ? crossedAt : null

    return (
      <div key={reactKey} className="coin-chart-section">
        <div className="coin-header">
          <div className="coin-main-info">
            <span className="coin-title">{coin} | <span className="gcp-fixed-range">{range}</span>{hasCrossed ? <><span className="gcp-crossed-badge">{crossedBadgeText}</span>{crossedMoveInfo && <span className={`gcp-cross-move ${crossedMoveInfo.pct >= 0 ? 'up' : 'down'}`}>{crossedMoveInfo.text}</span>}</> : <><span className="gcp-open-badge">{openBadgeText}</span>{intervalMoveInfo && <span className={`gcp-cross-move ${intervalMoveInfo.pct >= 0 ? 'up' : 'down'}`}>{intervalMoveInfo.text}</span>}</>}</span>
            {/* Removed candle and ATR info from header, now shown inside chart area */}
          </div>
          <div className="coin-header-actions">
            {headerAction}
            <div className="coin-range-selector">
              {VISIBLE_RANGES.map((tf) => (
                <button
                  key={`${coin}-${range}-${tf}`}
                  type="button"
                  className={`coin-range-btn ${tf === displayRange ? 'active' : ''} ${tf === range ? 'gcp-fixed-range-btn' : ''}`}
                  onClick={() => {
                    if (onSelectRange) {
                      onSelectRange(tf)
                      return
                    }

                    const cardKey = `${coin}__${range}`
                    setGcpSelectedRangeByCard((prev) => ({
                      ...prev,
                      [cardKey]: tf,
                    }))
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="chart-wrapper">
          {hasError ? (
            <div className="chart-overlay"><p className="error-message">Error: {hasError}</p></div>
          ) : coinData?.candles ? (
            <LazyChartMount fallback={<div className="chart-overlay"><p className="status-message">Chart will render when visible...</p></div>}>
              <ChartErrorBoundary>
                <CoinChart
                  candles={coinData.candles}
                  ema50={coinData.ema50}
                  ema200={coinData.ema200}
                  reloadToken={`${coin}|${displayRange}|${coinData.rangePolicy?.resolution}`}
                  coinSymbol={coin}
                  timeframe={displayRange}
                  candleLabel={candleLabel}
                  averageMove={atrSummary?.averageMove ?? null}
                  gcProbability={gcProbability}
                  gcDebug={gcDebug}
                  gcCrossedAt={crossMarkerTime}
                  pinMarkerAt={pinMarkerTime}
                  hasCrossed={hasCrossed}
                  crossedMovePct={intervalMoveInfo?.pct ?? null}
                  crossedMoveText={intervalMoveInfo?.text ?? null}
                />
              </ChartErrorBoundary>
            </LazyChartMount>
          ) : isLoading ? (
            <div className="chart-overlay"><p className="status-message">Loading {coin} {range}...</p></div>
          ) : (
            <div className="chart-overlay"><p className="status-message">No data for {coin} / {range}</p></div>
          )}
        </div>
      </div>
    )
  }

  const renderCoinModeCard = (coin, selectedRange, options = {}) => {
    const {
      reactKey = `coin-template-${coin}`,
      onSelectRange,
      headerAction = null,
      pinMarkerTime = null,
    } = options
    const coinData = allCoinsData[coin]?.[selectedRange]
    const atrSummary = atrSummaryByCoins[coin]?.[selectedRange]
    const gcCoinData = gcProbabilityByCoins[coin]?.[selectedRange]
    const gcProbability = normalizeGcProbability(gcCoinData?.probability)
    const gcDebug = gcCoinData?.debug ?? null
    const coinRangeKey = `${coin}__${selectedRange}`
    const isLoading = loadingCoinRanges.has(coinRangeKey)
    const hasError = errorsByCoins[coinRangeKey]
    const candleLabel = coinData?.rangePolicy?.candleLabel ?? 'N/A'
    const averageMoveText = atrSummary?.averageMove === null || atrSummary?.averageMove === undefined
      ? 'N/A'
      : Number(atrSummary.averageMove).toFixed(4)
    const gcProbabilityText = gcProbability === null || gcProbability === undefined
      ? 'N/A'
      : `${Number(gcProbability).toFixed(1)}%`
    const openBadgeText = `GC probability: ${gcProbabilityText}`
    const intervalMoveInfo = (() => {
      const displayCandles = coinData?.candles ?? []
      if (!displayCandles.length) return null

      const lastClose = Number(displayCandles[displayCandles.length - 1]?.close)
      if (!Number.isFinite(lastClose)) return null

      const baseClose = Number(displayCandles[0]?.close)
      if (!Number.isFinite(baseClose) || baseClose === 0) return null

      const pct = ((lastClose - baseClose) / baseClose) * 100
      const text = `For current interval ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%.`

      return { pct, text }
    })()

    return (
      <section key={reactKey} className="coin-chart-section">
        <div className="coin-header">
          <div className="coin-main-info">
            <span className="coin-title">{coin} | <span className="gcp-fixed-range">{selectedRange}</span><span className="gcp-open-badge">{openBadgeText}</span>{intervalMoveInfo && <span className={`gcp-cross-move ${intervalMoveInfo.pct >= 0 ? 'up' : 'down'}`}>{intervalMoveInfo.text}</span>}</span>
            <span className="coin-meta">
              candle: {candleLabel}
              {coinData?.candles ? ` | ${coinData.candles.length} candles` : ''}
              {` | Average move (ATR${atrSummary?.period ?? 14}): ${averageMoveText} per candle`}
            </span>
          </div>
          <div className="coin-header-actions">
            {headerAction}
            <div className="coin-range-selector">
              {VISIBLE_RANGES.map((range) => (
                <button
                  key={`${coin}-${range}`}
                  className={`coin-range-btn ${range === selectedRange ? 'active' : ''}`}
                  onClick={() => {
                    if (onSelectRange) {
                      onSelectRange(range)
                      return
                    }
                    setVisibleRangeForCoin(coin, range)
                  }}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="chart-wrapper">
          {hasError ? (
            <div className="chart-overlay"><p className="error-message">Error: {hasError}</p></div>
          ) : coinData?.candles ? (
            <LazyChartMount fallback={<div className="chart-overlay"><p className="status-message">Chart will render when visible...</p></div>}>
              <ChartErrorBoundary>
                <CoinChart
                  candles={coinData.candles}
                  ema50={coinData.ema50}
                  ema200={coinData.ema200}
                  reloadToken={`${coin}|${selectedRange}|${coinData.rangePolicy?.resolution}`}
                  coinSymbol={coin}
                  timeframe={selectedRange}
                  candleLabel={candleLabel}
                  averageMove={atrSummary?.averageMove ?? null}
                  gcProbability={gcProbability}
                  gcDebug={gcDebug}
                  gcCrossedAt={null}
                  hasCrossed={false}
                  crossedMovePct={intervalMoveInfo?.pct ?? null}
                  crossedMoveText={intervalMoveInfo?.text ?? null}
                  pinMarkerAt={pinMarkerTime}
                />
              </ChartErrorBoundary>
            </LazyChartMount>
          ) : isLoading ? (
            <div className="chart-overlay"><p className="status-message">Loading {coin} {selectedRange}...</p></div>
          ) : (
            <div className="chart-overlay"><p className="status-message">No data for {coin} / {selectedRange}</p></div>
          )}
        </div>
      </section>
    )
  }

  const getAllCoinRangePairsSortedByGc = () => {
    const pairs = []
    coins.forEach((coin) => {
      VISIBLE_RANGES.forEach((range) => {
        const gcCoinData = gcProbabilityByCoins[coin]?.[range]
        const normalizedGc = normalizeGcProbability(gcCoinData?.probability)
        const crossedAt = gcCoinData?.crossedAt ?? null
        const crossedProbability = normalizeGcProbability(gcCoinData?.crossedProbability)
        const isCrossed = crossedAt !== null && normalizedGc === 0
        const sortGc = isCrossed ? (crossedProbability ?? 0) : (normalizedGc ?? -1)
        pairs.push({ coin, range, gc: normalizedGc ?? -1, crossedAt, isCrossed, sortGc })
      })
    })

    pairs.sort((a, b) => b.sortGc - a.sortGc)

    return pairs.filter((pair) => {
      if (pair.gc >= 15) return true
      // Keep coins that crossed within the configured keep window so the
      // post-cross evolution is visible even though GC probability is now 0.
      if (pair.isCrossed && pair.crossedAt !== null) {
        const candles = allCoinsData[pair.coin]?.[pair.range]?.candles
        if (candles?.length) {
          const latestCandleTime = Number(candles[candles.length - 1].time)
          if (latestCandleTime - pair.crossedAt < coinCrossKeepDays * 86400) return true
        }
      }
      return false
    })
  }

  const gcpPairs = useMemo(
    () => getAllCoinRangePairsSortedByGc(),
    [coins, gcProbabilityByCoins, allCoinsData, coinCrossKeepDays],
  )

  const visibleGcpPairs = useMemo(
    () => (showCrossedInGcpMode ? gcpPairs : gcpPairs.filter((pair) => !pair.isCrossed)),
    [gcpPairs, showCrossedInGcpMode],
  )

  const visiblePinnedCards = useMemo(
    () => (showCrossedInGcpMode ? pinnedCards : pinnedCards.filter((card) => !isPinnedCardCrossed(card))),
    [pinnedCards, showCrossedInGcpMode, gcProbabilityByCoins],
  )


  const loadingStageElapsed = loadingStageStartTime
    ? ((Date.now() - loadingStageStartTime) / 1000).toFixed(1)
    : '0.0'

  const readyStatusLabel = `Ready! ${formatTransferredData(lastTransferBytes)}`;

  const loadingStageLabel = loadingStage === 'coins'
    ? 'Loading coins'
    : loadingStage === 'intervals'
    ? null
    : loadingStage === 'gc'
    ? 'Calculating GC probability'
    : null


  // Show loading steps incrementally as each stage is reached
  const intervalLoadingSteps = [
    '1. Frontend requests base-resolution candle data per selected range.',
    '2. Backend returns cached candle data for coin+resolution pairs.',
    '3. Frontend aggregates that data client-side for chart display.',
  ];

  let currentStep = -1;
  if (loadingStage === 'intervals') {
    currentStep = 0;
  } else if (loadingStage === 'gc') {
    currentStep = 1;
  } else if (!loadingStage && coins.length > 0) {
    currentStep = 2;
  }

  let headerStageStatusContent;
  if (currentStep === 2 && !loadingStage) {
    // After third step, show Ready status
    headerStageStatusContent = readyStatusLabel;
  } else if (currentStep !== -1) {
    headerStageStatusContent = (
      <div>
        {intervalLoadingSteps[currentStep]} ({loadingStageElapsed}s)
      </div>
    );
  } else if (loadingStageLabel) {
    headerStageStatusContent = `${loadingStageLabel}... (${loadingStageElapsed}s)`;
  } else {
    headerStageStatusContent = readyStatusLabel;
  }

  const modeCountLabel = displayMode === 'coin'
    ? `Coins: ${coins.length}`
    : displayMode === 'pinned'
    ? `Pinned charts: ${visiblePinnedCards.length}`
    : `GCP cards: ${visibleGcpPairs.length} | Coins: ${coins.length}`;

  return (
    <>
      <header className="app-header">
        <img src={whaleLogo} alt="WhaleWatch" className="app-logo" />
        <span className="update-countdown">Next update in {countdown}s</span>
        <span className="update-countdown">{modeCountLabel}</span>
        <button
          className={`display-mode-btn ${requestedCoinLimit === 25 ? 'active' : ''}`}
          onClick={() => handleResampleCoins(25)}
        >
          25 coins
        </button>
        <button
          className={`display-mode-btn ${requestedCoinLimit === 50 ? 'active' : ''}`}
          onClick={() => handleResampleCoins(50)}
        >
          50 coins
        </button>
        <div className="header-stage-status">
          {headerStageStatusContent}
        </div>
        <div className="display-mode-toggle">
          <button
            className={`display-mode-btn ${displayMode === 'coin' ? 'active' : ''}`}
            onClick={() => setDisplayMode('coin')}
          >
            coin mode
          </button>
          <button
            className={`display-mode-btn ${displayMode === 'gcp' ? 'active' : ''}`}
            onClick={() => setDisplayMode('gcp')}
          >
            GCP mode
          </button>
          <button
            className={`display-mode-btn ${displayMode === 'pinned' ? 'active' : ''}`}
            onClick={() => setDisplayMode('pinned')}
          >
            Pinned
          </button>
          <label className="gcp-crossed-filter-toggle" title="Show or hide crossed cards">
            <input
              type="checkbox"
              checked={showCrossedInGcpMode}
              onChange={(event) => setShowCrossedInGcpMode(event.target.checked)}
            />
            crossed
          </label>
          <label className="gcp-crossed-filter-toggle" title="Show cards in a 3-column compact layout">
            <input
              type="checkbox"
              checked={compactMode}
              onChange={(event) => setCompactMode(event.target.checked)}
            />
            compact mode
          </label>
        </div>
      </header>

      <main className="chart-area">
        {errorsByCoins._global && <p className="error-message">Error: {errorsByCoins._global}</p>}
        {displayMode === 'coin' ? (
          <section className={`mode-group ${compactMode ? 'compact-mode-grid' : ''}`}>
            {coins.map((coin) => {
              const selectedRange = selectedVisibleRangeByCoins[coin] ?? DEFAULT_VISIBLE_RANGE
              const selectedCandles = allCoinsData[coin]?.[selectedRange]?.candles ?? []
              const latestCandleTime = selectedCandles.length
                ? Number(selectedCandles[selectedCandles.length - 1]?.time)
                : null
              return renderCoinModeCard(coin, selectedRange, {
                reactKey: `coin-template-${coin}`,
                headerAction: renderPinButton({
                  sourceMode: 'coin',
                  coin,
                  selectedRange,
                  pinMarkerAt: Number.isFinite(latestCandleTime) ? latestCandleTime : null,
                }),
              })
            })}
          </section>
        ) : displayMode === 'gcp' ? (
          <section className={`mode-group ${compactMode ? 'compact-mode-grid' : ''}`}>
            {(() => {
              const pairs = visibleGcpPairs
              if (pairs.length === 0) {
                return (
                  <div className="chart-overlay">
                    <p className="status-message">
                      {loadingStage || coins.length === 0
                        ? 'Standby for Golden Cross probability charts.'
                        : showCrossedInGcpMode
                        ? 'No GCP cards matched current filter (GC >= 15% or recent cross).'
                        : 'No GCP cards matched current filter after hiding crossed cards.'}
                    </p>
                  </div>
                )
              }

              return pairs.map(({ coin, range, crossedAt }) => {
                const cardKey = `${coin}__${range}`
                const displayRange = gcpSelectedRangeByCard[cardKey] ?? range
                const displayCandles = allCoinsData[coin]?.[displayRange]?.candles ?? []
                const latestCandleTime = displayCandles.length
                  ? Number(displayCandles[displayCandles.length - 1]?.time)
                  : null
                return renderChartCard(coin, range, displayRange, crossedAt, {
                  reactKey: cardKey,
                  headerAction: renderPinButton({
                    sourceMode: 'gcp',
                    coin,
                    range,
                    crossedAt,
                    selectedRange: displayRange,
                    pinMarkerAt: Number.isFinite(latestCandleTime) ? latestCandleTime : null,
                  }),
                })
              })
            })()}
          </section>
        ) : (
          <section className={`mode-group ${compactMode ? 'compact-mode-grid' : ''}`}>
            {(() => {
              if (visiblePinnedCards.length === 0) {
                return (
                  <div className="chart-overlay">
                    <p className="status-message">
                      {pinnedCards.length === 0
                        ? 'No pinned charts yet. Pin charts from coin mode or GCP mode to keep them here.'
                        : 'No pinned charts matched current filter after hiding crossed cards.'}
                    </p>
                  </div>
                )
              }

              return visiblePinnedCards.map((card) => {
                const cardId = getPinnedCardId(card)

                if (card.sourceMode === 'coin') {
                  return renderCoinModeCard(card.coin, card.selectedRange ?? DEFAULT_VISIBLE_RANGE, {
                    reactKey: `pinned-${cardId}`,
                    onSelectRange: (range) => updatePinnedCardRange(cardId, range),
                    headerAction: renderPinButton(card),
                    pinMarkerTime: card.pinnedAt ?? null,
                  })
                }

                return renderChartCard(
                  card.coin,
                  card.range,
                  card.selectedRange ?? card.range,
                  card.crossedAt ?? null,
                  {
                    reactKey: `pinned-${cardId}`,
                    onSelectRange: (range) => updatePinnedCardRange(cardId, range),
                    headerAction: renderPinButton(card),
                    pinMarkerTime: card.pinnedAt ?? null,
                  },
                )
              })
            })()}
          </section>
        )}
      </main>
    </>
  )
}
