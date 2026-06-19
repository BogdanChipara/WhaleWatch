const LOOKBACK_CANDLE_COUNT = 10
const ATR_PERIOD = 14

function clamp(value, minimum = 0.0, maximum = 1.0) {
  return Math.max(minimum, Math.min(maximum, value))
}

function safeDivide(numerator, denominator) {
  if (denominator <= 0) return 0.0
  return numerator / denominator
}

function computeTrueRange(candles) {
  if (!candles?.length) return []

  const trValues = []
  for (let i = 0; i < candles.length; i += 1) {
    const high = Number(candles[i].high)
    const low = Number(candles[i].low)

    if (i === 0) {
      trValues.push(high - low)
      continue
    }

    const previousClose = Number(candles[i - 1].close)
    const rangeHighLow = high - low
    const rangeHighPrevClose = Math.abs(high - previousClose)
    const rangeLowPrevClose = Math.abs(low - previousClose)

    trValues.push(Math.max(rangeHighLow, rangeHighPrevClose, rangeLowPrevClose))
  }

  return trValues
}

function computeAtrSeries(candles, period = 14) {
  const trValues = computeTrueRange(candles)
  if (!trValues.length) return []

  const alpha = 2 / (period + 1)
  const atrValues = []
  let previousAtr = trValues[0]
  atrValues.push(previousAtr)

  for (let i = 1; i < trValues.length; i += 1) {
    const atr = (alpha * trValues[i]) + ((1 - alpha) * previousAtr)
    atrValues.push(atr)
    previousAtr = atr
  }

  return atrValues
}

function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function computePeriodEma(closes, output, period) {
  if (closes.length < period) return

  const multiplier = 2 / (period + 1)
  let ema = average(closes.slice(0, period))

  output[period - 1] = ema

  for (let i = period; i < closes.length; i += 1) {
    ema = (closes[i] * multiplier) + (ema * (1 - multiplier))
    output[i] = ema
  }
}

function computeEmaSeries(candles) {
  const total = candles.length
  const ema50 = Array(total).fill(null)
  const ema200 = Array(total).fill(null)

  if (!total) return { ema50, ema200 }

  const closes = candles.map((candle) => Number(candle.close))
  computePeriodEma(closes, ema50, 50)
  computePeriodEma(closes, ema200, 200)

  return { ema50, ema200 }
}

function findLatestGoldenCross(ema50, ema200, orderedCandles) {
  // Returns { time, index } for the most recent candle where EMA50 crossed above EMA200.
  // Searches backwards so it finds the latest cross first.
  for (let i = ema50.length - 1; i >= 1; i -= 1) {
    const e50Curr = ema50[i]
    const e50Prev = ema50[i - 1]
    const e200Curr = ema200[i]
    const e200Prev = ema200[i - 1]
    if (e50Curr === null || e50Prev === null || e200Curr === null || e200Prev === null) continue
    if (e50Prev < e200Prev && e50Curr >= e200Curr) {
      return { time: Number(orderedCandles[i].time), index: i }
    }
  }
  return null
}

function computeGcProbabilityForIndex(orderedCandles, ema50, ema200, atrValues, targetIndex) {
  if (!Number.isInteger(targetIndex) || targetIndex < 5 || targetIndex >= orderedCandles.length) return null

  const ema50T = ema50[targetIndex]
  const ema50T1 = ema50[targetIndex - 1]
  const ema50T2 = ema50[targetIndex - 2]
  const ema200T = ema200[targetIndex]
  const ema200T1 = ema200[targetIndex - 1]
  const ema200T2 = ema200[targetIndex - 2]
  const ema200T5 = ema200[targetIndex - 5]
  const atrT = atrValues.length ? atrValues[targetIndex] : null

  if ([ema50T, ema50T1, ema50T2, ema200T, ema200T1, ema200T2, ema200T5].some((v) => v === null || v === undefined) || atrT === null || atrT === undefined) {
    return null
  }

  const gapT = Number(ema50T) - Number(ema200T)
  const gapT1 = Number(ema50T1) - Number(ema200T1)
  const gapT2 = Number(ema50T2) - Number(ema200T2)

  if (Number(ema50T) >= Number(ema200T)) return 0.0
  if (Math.abs(gapT) > (2.0 * atrT)) return 0.0

  const distanceScore = 1 - clamp(safeDivide(Math.abs(gapT), 0.5 * atrT))
  const velocityScore = clamp(safeDivide(gapT - gapT1, 0.25 * atrT))
  const accelerationScore = clamp(safeDivide((gapT - gapT1) - (gapT1 - gapT2), 0.2 * atrT))

  const lookback = Math.min(LOOKBACK_CANDLE_COUNT, targetIndex)
  const recentCandles = orderedCandles.slice(targetIndex - lookback + 1, targetIndex + 1)
  const recentEma50 = ema50.slice(targetIndex - lookback + 1, targetIndex + 1)
  const closesAboveShort = recentCandles.reduce((count, candle, idx) => {
    const emaPoint = recentEma50[idx]
    if (emaPoint !== null && emaPoint !== undefined && Number(candle.close) > Number(emaPoint)) {
      return count + 1
    }
    return count
  }, 0)
  const supportScore = safeDivide(closesAboveShort, lookback)

  const longSlopeScore = clamp(
    safeDivide((Number(ema200T) - Number(ema200T1)) + (0.05 * atrT), 2 * (0.05 * atrT)),
  )

  const latestClose = Number(orderedCandles[targetIndex].close)
  const lookbackClose = Number(orderedCandles[targetIndex - lookback].close)

  let pathMovement = 0
  for (let i = targetIndex - lookback + 1; i <= targetIndex; i += 1) {
    pathMovement += Math.abs(Number(orderedCandles[i].close) - Number(orderedCandles[i - 1].close))
  }

  const trendEfficiency = safeDivide(Math.abs(latestClose - lookbackClose), pathMovement)
  const volatilitySupport = clamp(safeDivide(safeDivide(atrT, latestClose), 0.02))
  const trendQualityScore = trendEfficiency * volatilitySupport

  let gcProbability = (
    0.55 * distanceScore
    + 0.15 * velocityScore
    + 0.07 * accelerationScore
    + 0.05 * supportScore
    + 0.08 * longSlopeScore
    + 0.08 * trendQualityScore
  )

  if (Number(ema200T) <= Number(ema200T5)) {
    gcProbability *= 0.3
  }

  return clamp(gcProbability * 100.0, 0.0, 100.0)
}

function computeGcProbability(candles) {
  if (!candles || candles.length < Math.max(LOOKBACK_CANDLE_COUNT + 1, 200, 3)) {
    return {
      probability: null,
      lookback: LOOKBACK_CANDLE_COUNT,
      atr: null,
      averageMove: null,
      period: ATR_PERIOD,
      crossedAt: null,
      crossedProbability: null,
    }
  }

  const orderedCandles = [...candles].sort((a, b) => Number(a.time) - Number(b.time))
  const emaValues = computeEmaSeries(orderedCandles)
  const atrValues = computeAtrSeries(orderedCandles, ATR_PERIOD)
  const averageMove = atrValues.length ? average(atrValues) : null

  const ema50 = emaValues.ema50
  const ema200 = emaValues.ema200
  const latestIndex = orderedCandles.length - 1
  const latestCross = findLatestGoldenCross(ema50, ema200, orderedCandles)
  const crossedAt = latestCross?.time ?? null
  const crossedProbability = latestCross && latestCross.index > 0
    ? computeGcProbabilityForIndex(orderedCandles, ema50, ema200, atrValues, latestCross.index - 1)
    : null

  if (latestIndex < 5) {
    return {
      probability: null,
      lookback: LOOKBACK_CANDLE_COUNT,
      atr: null,
      averageMove,
      period: ATR_PERIOD,
      crossedAt,
      crossedProbability,
    }
  }

  const ema50T = ema50[latestIndex]
  const ema50T1 = ema50[latestIndex - 1]
  const ema50T2 = ema50[latestIndex - 2]
  const ema200T = ema200[latestIndex]
  const ema200T1 = ema200[latestIndex - 1]
  const ema200T2 = ema200[latestIndex - 2]
  const ema200T5 = ema200[latestIndex - 5]
  const atrT = atrValues.length ? atrValues[latestIndex] : null

  if ([ema50T, ema50T1, ema50T2, ema200T, ema200T1, ema200T2, ema200T5].some((v) => v === null || v === undefined) || atrT === null || atrT === undefined) {
    return {
      probability: null,
      lookback: LOOKBACK_CANDLE_COUNT,
      atr: atrT,
      averageMove,
      period: ATR_PERIOD,
      crossedAt,
      crossedProbability,
    }
  }

  const gapT = Number(ema50T) - Number(ema200T)
  const gapT1 = Number(ema50T1) - Number(ema200T1)
  const gapT2 = Number(ema50T2) - Number(ema200T2)

  const gateDebug = {
    gap_t: gapT,
    atr_t: atrT,
    ema200_t: Number(ema200T),
    ema200_t5: Number(ema200T5),
    distance_score: null,
    velocity_score: null,
    long_slope_score: null,
    trend_quality_score: null,
  }

  if (Number(ema50T) >= Number(ema200T)) {
    // Already crossed — return the cross time so GCP mode can keep the card for 2 days.
    return {
      probability: 0.0,
      lookback: LOOKBACK_CANDLE_COUNT,
      atr: atrT,
      averageMove,
      period: ATR_PERIOD,
      debug: gateDebug,
      crossedAt,
      crossedProbability,
    }
  }

  if (Math.abs(gapT) > (2.0 * atrT)) {
    // EMA50 is too far below — not a recent cross situation.
    return {
      probability: 0.0,
      lookback: LOOKBACK_CANDLE_COUNT,
      atr: atrT,
      averageMove,
      period: ATR_PERIOD,
      debug: gateDebug,
      crossedAt: null,
      crossedProbability: null,
    }
  }

  const distanceScore = 1 - clamp(safeDivide(Math.abs(gapT), 0.5 * atrT))
  const velocityScore = clamp(safeDivide(gapT - gapT1, 0.25 * atrT))
  const accelerationScore = clamp(safeDivide((gapT - gapT1) - (gapT1 - gapT2), 0.2 * atrT))

  const lookback = Math.min(LOOKBACK_CANDLE_COUNT, latestIndex)
  const recentCandles = orderedCandles.slice(-lookback)
  const recentEma50 = ema50.slice(-lookback)
  const closesAboveShort = recentCandles.reduce((count, candle, idx) => {
    const emaPoint = recentEma50[idx]
    if (emaPoint !== null && emaPoint !== undefined && Number(candle.close) > Number(emaPoint)) {
      return count + 1
    }
    return count
  }, 0)
  const supportScore = safeDivide(closesAboveShort, lookback)

  const longSlopeScore = clamp(
    safeDivide((Number(ema200T) - Number(ema200T1)) + (0.05 * atrT), 2 * (0.05 * atrT)),
  )

  const latestClose = Number(orderedCandles[latestIndex].close)
  const lookbackClose = Number(orderedCandles[latestIndex - lookback].close)

  let pathMovement = 0
  for (let i = latestIndex - lookback + 1; i <= latestIndex; i += 1) {
    pathMovement += Math.abs(Number(orderedCandles[i].close) - Number(orderedCandles[i - 1].close))
  }

  const trendEfficiency = safeDivide(Math.abs(latestClose - lookbackClose), pathMovement)
  const volatilitySupport = clamp(safeDivide(safeDivide(atrT, latestClose), 0.02))
  const trendQualityScore = trendEfficiency * volatilitySupport

  let gcProbability = (
    0.55 * distanceScore
    + 0.15 * velocityScore
    + 0.07 * accelerationScore
    + 0.05 * supportScore
    + 0.08 * longSlopeScore
    + 0.08 * trendQualityScore
  )

  if (Number(ema200T) <= Number(ema200T5)) {
    gcProbability *= 0.3
  }

  return {
    probability: clamp(gcProbability * 100.0, 0.0, 100.0),
    lookback,
    atr: atrT,
    averageMove,
    period: ATR_PERIOD,
    crossedAt,
    crossedProbability,
    debug: {
      gap_t: gapT,
      atr_t: atrT,
      ema200_t: Number(ema200T),
      ema200_t5: Number(ema200T5),
      distance_score: distanceScore,
      velocity_score: velocityScore,
      long_slope_score: longSlopeScore,
      trend_quality_score: trendQualityScore,
    },
  }
}

self.onmessage = (event) => {
  const { type, requestId, items } = event.data || {}
  if (type !== 'compute_gc_batch' || !Array.isArray(items)) return

  const chunk = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const result = computeGcProbability(item.candles || [])
    chunk.push({
      coin: item.coin,
      range: item.range,
      probability: result.probability,
      averageMove: result.averageMove ?? null,
      period: result.period ?? ATR_PERIOD,
      debug: result.debug ?? null,
      crossedAt: result.crossedAt ?? null,
      crossedProbability: result.crossedProbability ?? null,
    })

    if (chunk.length >= 24) {
      self.postMessage({ type: 'gc_batch_result', requestId, results: [...chunk] })
      chunk.length = 0
    }
  }

  if (chunk.length > 0) {
    self.postMessage({ type: 'gc_batch_result', requestId, results: chunk })
  }

  self.postMessage({ type: 'gc_batch_complete', requestId })
  self.postMessage({ type: 'gc_batch_done', requestId })
}
