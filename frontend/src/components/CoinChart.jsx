import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  LineElement,
  PointElement,
} from 'chart.js'
import { Chart } from 'react-chartjs-2'
import {
  CandlestickController,
  CandlestickElement,
} from 'chartjs-chart-financial'
import zoomPlugin from 'chartjs-plugin-zoom'
import 'chartjs-adapter-date-fns'
import watermarkLogoUrl from '../assets/WhaleWatch_Logo2.svg'

ChartJS.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  LineElement,
  PointElement,
  CandlestickController,
  CandlestickElement,
  zoomPlugin,
)

function formatNum(v) {
  if (v === null || v === undefined) return '—'
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatTime(tsMs) {
  if (!tsMs) return '—'
  const d = new Date(tsMs)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function computeAtrSeriesFromCandles(inputCandles, period = 14) {
  if (!inputCandles?.length) return []

  const trValues = []
  for (let i = 0; i < inputCandles.length; i += 1) {
    const current = inputCandles[i]
    const high = Number(current.high)
    const low = Number(current.low)
    if (i === 0) {
      trValues.push(high - low)
      continue
    }

    const prevClose = Number(inputCandles[i - 1].close)
    trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }

  const alpha = 2 / (period + 1)
  const atrValues = [trValues[0]]
  for (let i = 1; i < trValues.length; i += 1) {
    atrValues.push((alpha * trValues[i]) + ((1 - alpha) * atrValues[i - 1]))
  }

  return atrValues
}

let watermarkImagePromise = null

function loadImageAsset(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

function getWatermarkImage() {
  if (!watermarkImagePromise) {
    watermarkImagePromise = loadImageAsset(watermarkLogoUrl).catch(() => null)
  }
  return watermarkImagePromise
}

// Custom plugin to fill area between EMA50 and EMA200, handling multiple crossings
const fillBetweenEMAsPlugin = {
  id: 'fillBetweenEMAs',
  afterDatasetsDraw(chart, args, pluginOptions) {
    const ctx = chart.ctx;
    const datasets = chart.data.datasets;
    if (!datasets) return;
    // Find EMA50 and EMA200 datasets by label
    const ema50 = datasets.find(ds => ds.label === 'EMA 50');
    const ema200 = datasets.find(ds => ds.label === 'EMA 200');
    if (!ema50 || !ema200) return;
    const ema50Meta = chart.getDatasetMeta(datasets.indexOf(ema50));
    const ema200Meta = chart.getDatasetMeta(datasets.indexOf(ema200));
    if (!ema50Meta || !ema200Meta) return;
    const ema50Points = ema50Meta.data;
    const ema200Points = ema200Meta.data;
    if (!ema50Points.length || !ema200Points.length) return;
    // Assume both arrays are the same length and aligned by x (time)
    ctx.save();
    ctx.globalAlpha = 0.06; // set to 0.06 as requested
    ctx.fillStyle = 'rgba(109, 212, 255, 1)';
    // Find all crossing segments
    let inArea = false;
    let areaStart = 0;
    for (let i = 0; i < ema50Points.length - 1; ++i) {
      const p1_50 = ema50Points[i];
      const p2_50 = ema50Points[i + 1];
      const p1_200 = ema200Points[i];
      const p2_200 = ema200Points[i + 1];
      if (!p1_50 || !p2_50 || !p1_200 || !p2_200) continue;
      // Check if lines cross between i and i+1
      const above1 = p1_50.y < p1_200.y;
      const above2 = p2_50.y < p2_200.y;
      if (i === 0) inArea = above1;
      if (above1 !== above2) {
        // Crossing detected, draw area up to here
        drawArea(areaStart, i + 1, inArea);
        areaStart = i + 1;
        inArea = above2;
      }
    }
    // Draw last area
    drawArea(areaStart, ema50Points.length, inArea);
    ctx.restore();

    function drawArea(startIdx, endIdx, fillAbove) {
      if (endIdx - startIdx < 2) return;
      ctx.beginPath();
      // Trace EMA50
      for (let i = startIdx; i < endIdx; ++i) {
        const pt = ema50Points[i];
        if (i === startIdx) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      // Trace EMA200 backwards
      for (let i = endIdx - 1; i >= startIdx; --i) {
        const pt = ema200Points[i];
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
};

export function CoinChart({ candles, ema50, ema200, reloadToken, onSelection, coinSymbol, timeframe, candleLabel, averageMove, gcProbability, gcDebug, gcCrossedAt, pinMarkerAt, hasCrossed, crossedMovePct, crossedMoveText }) {
  const wrapperRef = useRef(null)
  const chartRef = useRef(null)
  const [selection, setSelection] = useState(null)
  const [hoverInfo, setHoverInfo] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)

  const getRelativePosition = (event) => {
    if (!wrapperRef.current) return null
    const rect = wrapperRef.current.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }

  const handleMouseDown = (event) => {
    if (event.button !== 0) return

    // Any new click starts a new interaction, so clear previous persisted selection first.
    setSelection(null)

    const pos = getRelativePosition(event)
    if (!pos) return

    setSelection({
      startX: pos.x,
      startY: pos.y,
      endX: pos.x,
      endY: pos.y,
      isSelecting: true,
    })
  }

  const handleMouseMove = (event) => {
    if (selection?.isSelecting) {
      const pos = getRelativePosition(event)
      if (pos) {
        setSelection((prev) => {
          if (!prev) return prev
          return { ...prev, endX: pos.x, endY: pos.y }
        })
      }
    }

    // Update hover info bar
    if (chartRef.current && wrapperRef.current) {
      const chart = chartRef.current
      const xScale = chart.scales?.x
      if (xScale) {
        const rect = wrapperRef.current.getBoundingClientRect()
        const cursorX = event.clientX - rect.left
        const ts = xScale.getValueForPixel(cursorX)
        const candleData = chart.data.datasets[0]?.data
        if (candleData?.length > 0) {
          let nearest = candleData[0]
          let minDist = Math.abs(nearest.x - ts)
          for (const c of candleData) {
            const dist = Math.abs(c.x - ts)
            if (dist < minDist) { minDist = dist; nearest = c }
          }
          const ema50Data = chart.data.datasets[1]?.data ?? []
          const ema200Data = chart.data.datasets[2]?.data ?? []
          const ema50Point = ema50Data.find((p) => p.x === nearest.x)
          const ema200Point = ema200Data.find((p) => p.x === nearest.x)
          setHoverInfo({
            time: nearest.x,
            open: nearest.o,
            high: nearest.h,
            low: nearest.l,
            close: nearest.c,
            ema50: ema50Point?.y ?? null,
            ema200: ema200Point?.y ?? null,
          })
        }
      }
    }
  }

  const handleMouseUp = () => {
    if (!selection?.isSelecting) return

    const finalized = { ...selection, isSelecting: false }
    const width = Math.abs(finalized.endX - finalized.startX)
    const height = Math.abs(finalized.endY - finalized.startY)

    // Treat tiny drag as a click: keep selection cleared.
    if (width < 3 || height < 3) {
      setSelection(null)
      return
    }

    // Keep selection visible after mouse release.
    setSelection(finalized)

    if (!onSelection || !chartRef.current) return

    const chart = chartRef.current
    const xScale = chart.scales?.x
    const yScale = chart.scales?.y
    if (!xScale || !yScale) return

    const left = Math.min(finalized.startX, finalized.endX)
    const right = Math.max(finalized.startX, finalized.endX)
    const top = Math.min(finalized.startY, finalized.endY)
    const bottom = Math.max(finalized.startY, finalized.endY)

    onSelection({
      pixels: { left, right, top, bottom },
      values: {
        xMin: xScale.getValueForPixel(left),
        xMax: xScale.getValueForPixel(right),
        yMin: yScale.getValueForPixel(bottom),
        yMax: yScale.getValueForPixel(top),
      },
    })
  }

  const handleMouseLeave = () => {
    handleMouseUp()
    setHoverInfo(null)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const buildExportCanvas = async () => {
    const canvas = chartRef.current?.canvas
    if (!canvas) return null

    const exportScale = 2
    const gcProbabilityText = gcProbability !== null && gcProbability !== undefined
      ? `${Number(gcProbability).toFixed(1)}%`
      : 'N/A'
    const crossedBadgeText = hasCrossed ? `Crossed at ${gcProbabilityText} probability` : null
    const openBadgeText = hasCrossed ? null : `GC probability: ${gcProbabilityText}`
    const avgMoveStr = averageMove !== null && averageMove !== undefined
      ? Number(averageMove).toFixed(4)
      : 'N/A'
    const moveText = crossedMoveText ?? ((crossedMovePct !== null && crossedMovePct !== undefined)
      ? `${crossedMovePct >= 0 ? '+' : ''}${Number(crossedMovePct).toFixed(1)}%`
      : null)
    const line2Prefix = `candle: ${candleLabel ?? 'N/A'} | ${(candles ?? []).length} candles | Average move (ATR14): ${avgMoveStr} per candle`

    const exportCanvas = document.createElement('canvas')
    const headerHeight = 62
    exportCanvas.width = canvas.width * exportScale
    exportCanvas.height = (canvas.height + headerHeight) * exportScale
    const ctx = exportCanvas.getContext('2d')
    if (!ctx) return null

    ctx.scale(exportScale, exportScale)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.fillStyle = '#0d0d1a'
    ctx.fillRect(0, 0, canvas.width, canvas.height + headerHeight)

    // Line 1: coin symbol in #7b8ef7, separator, range in #6DD4FF
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#7b8ef7'
    ctx.fillText(coinSymbol ?? 'N/A', 12, 24)
    const coinW = ctx.measureText(coinSymbol ?? 'N/A').width
    const sep = ' | '
    ctx.fillStyle = '#9094b0'
    ctx.fillText(sep, 12 + coinW, 24)
    const sepW = ctx.measureText(sep).width
    ctx.fillStyle = '#6DD4FF'
    ctx.fillText(timeframe ?? 'N/A', 12 + coinW + sepW, 24)
    const rangeW = ctx.measureText(timeframe ?? 'N/A').width

    // Status badge (yellow for crossed, light blue for not crossed)
    {
      const badgeText = hasCrossed ? (crossedBadgeText ?? 'Crossed') : (openBadgeText ?? 'GC probability: N/A')
      ctx.font = 'bold 14px sans-serif'
      const btw = ctx.measureText(badgeText).width
      const bx = 12 + coinW + sepW + rangeW + 8
      const badgeTextY = 24
      const by = 7
      const bw = btw + 12
      const bh = 18
      ctx.fillStyle = hasCrossed ? 'rgba(208, 182, 47, 0.1)' : 'rgba(109, 212, 255, 0.1)'
      ctx.strokeStyle = hasCrossed ? 'rgba(208, 182, 47, 0.35)' : 'rgba(109, 212, 255, 0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, 3)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = hasCrossed ? '#D0B62F' : '#6DD4FF'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(badgeText, bx + 6, badgeTextY)

      if (moveText && crossedMovePct !== null && crossedMovePct !== undefined) {
        ctx.font = 'bold 13px sans-serif'
        ctx.fillStyle = crossedMovePct >= 0 ? '#26a69a' : '#ef5350'
        ctx.fillText(moveText, bx + bw + 8, badgeTextY)
      }

      ctx.textBaseline = 'alphabetic'
    }

    // Line 2: meta prefix in #6668a0, gcStatusText in #6DD4FF bold
    ctx.fillStyle = '#6668a0'
    ctx.font = '600 13px sans-serif'
    ctx.fillText(line2Prefix, 12, 48)

    ctx.strokeStyle = '#2a2a50'
    ctx.beginPath()
    ctx.moveTo(0, headerHeight - 1)
    ctx.lineTo(canvas.width, headerHeight - 1)
    ctx.stroke()

    ctx.drawImage(canvas, 0, headerHeight)

    if (selectionRect) {
      ctx.save()
      ctx.fillStyle = 'rgba(244, 211, 94, 0.15)'
      ctx.fillRect(selectionRect.left, selectionRect.top + headerHeight, selectionRect.width, selectionRect.height)
      ctx.strokeStyle = '#f4d35e'
      ctx.lineWidth = 1
      ctx.strokeRect(selectionRect.left, selectionRect.top + headerHeight, selectionRect.width, selectionRect.height)
      if (selectionRect.pctChange !== null) {
        const pctText = `${selectionRect.pctChange >= 0 ? '+' : ''}${selectionRect.pctChange.toFixed(2)}%`
        ctx.font = 'bold 13px sans-serif'
        ctx.fillStyle = selectionRect.pctChange >= 0 ? '#26a69a' : '#ef5350'
        ctx.textAlign = 'center'
        ctx.shadowColor = '#000'
        ctx.shadowBlur = 4
        ctx.fillText(pctText, selectionRect.left + selectionRect.width / 2, selectionRect.top + headerHeight + 18)
      }
      ctx.restore()
    }

    const watermarkImage = await getWatermarkImage()
    if (watermarkImage) {
      const watermarkHeight = 44
      const watermarkWidth = (watermarkImage.width / watermarkImage.height) * watermarkHeight
      const watermarkX = canvas.width - watermarkWidth - 76
      const watermarkY = canvas.height + headerHeight - watermarkHeight - 44

      ctx.save()
      ctx.globalAlpha = 0.8
      ctx.drawImage(watermarkImage, watermarkX, watermarkY, watermarkWidth, watermarkHeight)
      ctx.restore()
    }

    return exportCanvas
  }

  const handleCopyImage = async () => {
    const exportCanvas = await buildExportCanvas()
    if (!exportCanvas) return

    exportCanvas.toBlob((blob) => {
      if (!blob) return
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
    setContextMenu(null)
  }

  const handleSaveImageToDrive = async () => {
    const exportCanvas = await buildExportCanvas()
    if (!exportCanvas) return

    exportCanvas.toBlob((blob) => {
      if (!blob) return
      const safeCoin = String(coinSymbol ?? 'coin').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeTimeframe = String(timeframe ?? 'range').replace(/[^a-zA-Z0-9_-]/g, '_')
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
      const fileName = `${safeCoin}_${safeTimeframe}_${timestamp}.png`

      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }, 'image/png')

    setContextMenu(null)
  }

  const handleCopyDebug = () => {
    if (!gcDebug) return
    const lines = [
      `Coin: ${coinSymbol ?? 'N/A'}`,
      `Timeframe: ${timeframe ?? 'N/A'}`,
      `Average Move: ${averageMove !== null && averageMove !== undefined ? `${Number(averageMove).toFixed(4)} per candle` : 'N/A'}`,
      `GC Probability: ${gcProbability !== null && gcProbability !== undefined ? `${Number(gcProbability).toFixed(1)}%` : 'N/A'}`,
      ...Object.entries(gcDebug).map(([k, v]) => `${k}: ${v !== null && v !== undefined ? Number(v).toFixed(6) : 'N/A'}`),
    ]
    const text = lines.join('\n')
    navigator.clipboard.writeText(text)
    setContextMenu(null)
  }

  const handleCopyAggregatedDebugCandles = () => {
    const sortedCandles = [...(candles ?? [])].sort((a, b) => Number(a.time) - Number(b.time))
    if (sortedCandles.length === 0) return

    const atrSeries = computeAtrSeriesFromCandles(sortedCandles, 14)
    const ema50ByTime = new Map((ema50 ?? []).map((point) => [Number(point.time), point.value]))
    const ema200ByTime = new Map((ema200 ?? []).map((point) => [Number(point.time), point.value]))

    const lastCandles = sortedCandles.slice(-20)
    const lines = [
      `Coin: ${coinSymbol ?? 'N/A'}`,
      `Timeframe: ${timeframe ?? 'N/A'}`,
      'Last 20 aggregated candles (OHLC + EMA50 + EMA200 + ATR14)',
      '',
    ]

    for (const candle of lastCandles) {
      const fullIndex = sortedCandles.findIndex((c) => Number(c.time) === Number(candle.time))
      const tsMs = Number(candle.time) * 1000
      const atrValue = fullIndex >= 0 ? atrSeries[fullIndex] : null
      const e50 = ema50ByTime.get(Number(candle.time))
      const e200 = ema200ByTime.get(Number(candle.time))

      lines.push([
        formatTime(tsMs),
        `O: ${Number(candle.open).toFixed(6)}`,
        `H: ${Number(candle.high).toFixed(6)}`,
        `L: ${Number(candle.low).toFixed(6)}`,
        `C: ${Number(candle.close).toFixed(6)}`,
        `EMA50: ${e50 !== null && e50 !== undefined ? Number(e50).toFixed(6) : 'N/A'}`,
        `EMA200: ${e200 !== null && e200 !== undefined ? Number(e200).toFixed(6) : 'N/A'}`,
        `ATR14: ${atrValue !== null && atrValue !== undefined ? Number(atrValue).toFixed(6) : 'N/A'}`,
      ].join(' | '))
    }

    navigator.clipboard.writeText(lines.join('\n'))
    setContextMenu(null)
  }

  const selectionRect = useMemo(() => {
    if (!selection) return null

    const chartArea = chartRef.current?.chartArea
    const xScale = chartRef.current?.scales?.x
    const candleData = chartRef.current?.data?.datasets[0]?.data ?? []

    const rawLeft = Math.min(selection.startX, selection.endX)
    const rawTop = Math.min(selection.startY, selection.endY)
    const rawRight = Math.max(selection.startX, selection.endX)
    const rawBottom = Math.max(selection.startY, selection.endY)

    const left = chartArea ? Math.max(rawLeft, chartArea.left) : rawLeft
    const top = chartArea ? Math.max(rawTop, chartArea.top) : rawTop
    const right = chartArea ? Math.min(rawRight, chartArea.right) : rawRight
    const bottom = chartArea ? Math.min(rawBottom, chartArea.bottom) : rawBottom

    const width = right - left
    const height = bottom - top

    if (width < 2 || height < 2) return null

    let pctChange = null
    if (xScale && candleData.length > 0) {
      const tsLeft = xScale.getValueForPixel(left)
      const tsRight = xScale.getValueForPixel(right)

      let nearestLeft = candleData[0]
      let minDistLeft = Math.abs(nearestLeft.x - tsLeft)
      for (const c of candleData) {
        const dist = Math.abs(c.x - tsLeft)
        if (dist < minDistLeft) { minDistLeft = dist; nearestLeft = c }
      }

      let nearestRight = candleData[0]
      let minDistRight = Math.abs(nearestRight.x - tsRight)
      for (const c of candleData) {
        const dist = Math.abs(c.x - tsRight)
        if (dist < minDistRight) { minDistRight = dist; nearestRight = c }
      }

      if (nearestLeft !== nearestRight && nearestLeft.c && nearestRight.c) {
        pctChange = ((nearestRight.c - nearestLeft.c) / nearestLeft.c) * 100
      }
    }

    return { left, top, width, height, pctChange }
  }, [selection])

  useEffect(() => {
    setSelection(null)
  }, [timeframe])

  const chartData = useMemo(() => {
    const sortedCandles = (candles ?? [])
      .map((c) => ({
        x: Number(c.time) * 1000,
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
      }))
      .sort((a, b) => a.x - b.x)

    const ema50Series = (ema50 ?? [])
      .map((point) => ({
        x: Number(point.time) * 1000,
        y: point.value === null || point.value === undefined ? null : Number(point.value),
      }))
      .sort((a, b) => a.x - b.x)

    const ema200Series = (ema200 ?? [])
      .map((point) => ({
        x: Number(point.time) * 1000,
        y: point.value === null || point.value === undefined ? null : Number(point.value),
      }))
      .sort((a, b) => a.x - b.x)

    // Cross marker dot: only show if the cross falls within the visible time range.
    let crossDotPoints = []
    if (gcCrossedAt && sortedCandles.length >= 2) {
      const crossXms = gcCrossedAt * 1000
      const firstCandleXms = sortedCandles[0].x
      const lastCandleXms = sortedCandles[sortedCandles.length - 1].x
      if (crossXms >= firstCandleXms && crossXms <= lastCandleXms) {
        let nearest = null
        for (const p of ema50Series) {
          if (p.y === null) continue
          const dist = Math.abs(p.x - crossXms)
          if (nearest === null || dist < nearest.dist) nearest = { p, dist }
        }
        if (nearest) crossDotPoints = [{ x: crossXms, y: nearest.p.y }]
      }
    }

    // Pin marker line: thin vertical line at the pin timestamp when visible in current range.
    let pinMarkerLinePoints = []
    if (pinMarkerAt && sortedCandles.length >= 2) {
      const pinXms = Number(pinMarkerAt) * 1000
      const firstCandleXms = sortedCandles[0].x
      const lastCandleXms = sortedCandles[sortedCandles.length - 1].x
      if (pinXms >= firstCandleXms && pinXms <= lastCandleXms) {
        let minY = Number.POSITIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY
        for (const candle of sortedCandles) {
          if (Number.isFinite(candle.l)) minY = Math.min(minY, candle.l)
          if (Number.isFinite(candle.h)) maxY = Math.max(maxY, candle.h)
        }
        if (Number.isFinite(minY) && Number.isFinite(maxY) && minY < maxY) {
          pinMarkerLinePoints = [{ x: pinXms, y: minY }, { x: pinXms, y: maxY }]
        }
      }
    }

    return {
      datasets: [
        {
          type: 'candlestick',
          label: 'Candles',
          data: sortedCandles,
          backgroundColors: {
            up: '#26a69a',
            down: '#ef5350',
            unchanged: '#9094b0',
          },
          borderColors: {
            up: '#26a69a',
            down: '#ef5350',
            unchanged: '#9094b0',
          },
          borderWidth: 1,
        },
        {
          type: 'line',
          label: 'EMA 200',
          data: ema200Series,
          parsing: false,
          borderColor: '#0099D8',
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
          tension: 0,
        },
        {
          type: 'line',
          label: 'EMA 50',
          data: ema50Series,
          parsing: false,
          borderColor: '#6DD4FF',
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
          tension: 0,
          fill: { target: '-1', above: 'rgba(109, 212, 255, 0.10)' },
        },
        {
          type: 'scatter',
          label: 'GC Cross',
          data: crossDotPoints,
          parsing: false,
          backgroundColor: '#FFD700',
          borderColor: '#fff',
          pointRadius: 8,
          pointHoverRadius: 10,
          borderWidth: 2,
        },
        {
          type: 'line',
          label: 'Pinned At',
          data: pinMarkerLinePoints,
          parsing: false,
          borderColor: '#FFD700',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4, 2],
          order: 99,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: false,
          tension: 0,
        },
      ],
    }
  }, [candles, ema50, ema200, reloadToken, gcCrossedAt, pinMarkerAt])

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
        },
        zoom: {
          pan: {
            enabled: false,
            mode: 'x',
          },
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: false },
            drag: {
              enabled: false,
              backgroundColor: 'rgba(244, 211, 94, 0.15)',
              borderColor: '#f4d35e',
              borderWidth: 1,
            },
            mode: 'x',
          },
        },
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          type: 'time',
          grid: { color: '#1a1a35' },
          ticks: { color: '#9094b0' },
          border: { color: '#2a2a50' },
          time: {
            tooltipFormat: 'dd MMM yyyy HH:mm',
          },
        },
        y: {
          position: 'right',
          grid: { color: '#1a1a35' },
          ticks: { color: '#9094b0' },
          border: { color: '#2a2a50' },
        },
      },
    }),
    [],
  )

  const changeColor = hoverInfo
    ? hoverInfo.close >= hoverInfo.open ? '#26a69a' : '#ef5350'
    : '#9094b0'

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        ref={wrapperRef}
        style={{ width: '100%', flex: 1, minHeight: 0, background: '#0d0d1a', position: 'relative', cursor: 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <Chart ref={chartRef} type="candlestick" data={chartData} options={options} />
        {selectionRect && (
          <div
            style={{
              position: 'absolute',
              left: `${selectionRect.left}px`,
              top: `${selectionRect.top}px`,
              width: `${selectionRect.width}px`,
              height: `${selectionRect.height}px`,
              border: '1px solid #f4d35e',
              background: 'rgba(244, 211, 94, 0.15)',
              pointerEvents: 'none',
            }}
          >
            {selectionRect.pctChange !== null && (
              <div
                style={{
                  position: 'absolute',
                  top: '4px',
                  left: 0,
                  width: '100%',
                  textAlign: 'center',
                  color: selectionRect.pctChange >= 0 ? '#26a69a' : '#ef5350',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  textShadow: '0 1px 3px #000, 0 0 6px #000',
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                {selectionRect.pctChange >= 0 ? '+' : ''}{selectionRect.pctChange.toFixed(2)}%
              </div>
            )}
          </div>
        )}
        {contextMenu && (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 999 }}
              onClick={() => setContextMenu(null)}
            />
            <div
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: `${contextMenu.x}px`,
                top: `${contextMenu.y}px`,
                zIndex: 1000,
                background: '#1a1a35',
                border: '1px solid #2a2a50',
                borderRadius: '4px',
                padding: '4px 0',
                minWidth: '200px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              <button
                onClick={handleCopyImage}
                style={{ display: 'block', width: '100%', padding: '8px 16px', background: 'none', border: 'none', color: '#c0c0d0', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#2a2a50' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
              >
                Copy image to clipboard
              </button>
              <button
                onClick={handleSaveImageToDrive}
                style={{ display: 'block', width: '100%', padding: '8px 16px', background: 'none', border: 'none', color: '#c0c0d0', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#2a2a50' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
              >
                Save image to drive
              </button>
              <button
                onClick={handleCopyDebug}
                disabled={!gcDebug}
                style={{ display: 'block', width: '100%', padding: '8px 16px', background: 'none', border: 'none', color: gcDebug ? '#c0c0d0' : '#555570', cursor: gcDebug ? 'pointer' : 'not-allowed', textAlign: 'left', fontSize: '13px' }}
                onMouseEnter={(e) => { if (gcDebug) e.currentTarget.style.background = '#2a2a50' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
              >
                Copy debug values
              </button>
              <button
                onClick={handleCopyAggregatedDebugCandles}
                disabled={!candles || candles.length === 0}
                style={{ display: 'block', width: '100%', padding: '8px 16px', background: 'none', border: 'none', color: candles && candles.length > 0 ? '#c0c0d0' : '#555570', cursor: candles && candles.length > 0 ? 'pointer' : 'not-allowed', textAlign: 'left', fontSize: '13px' }}
                onMouseEnter={(e) => { if (candles && candles.length > 0) e.currentTarget.style.background = '#2a2a50' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
              >
                Copy aggregated debug candles
              </button>
            </div>
          </>
        )}
      </div>
      <div className="chart-info-bar">
        {hoverInfo ? (
          <div className="chart-info-rows">
            <div className="chart-info-row">
              <span className="info-time">{formatTime(hoverInfo.time)}</span>
              <span className="info-item">O: <span style={{ color: changeColor }}>{formatNum(hoverInfo.open)}</span></span>
              <span className="info-item">H: <span style={{ color: changeColor }}>{formatNum(hoverInfo.high)}</span></span>
              <span className="info-item">L: <span style={{ color: changeColor }}>{formatNum(hoverInfo.low)}</span></span>
              <span className="info-item">C: <span style={{ color: changeColor }}>{formatNum(hoverInfo.close)}</span></span>
            </div>
            <div className="chart-info-row chart-info-row-ema">
              <span className="info-item">EMA50: <span style={{ color: '#6DD4FF' }}>{formatNum(hoverInfo.ema50)}</span></span>
              <span className="info-item">EMA200: <span style={{ color: '#0099D8' }}>{formatNum(hoverInfo.ema200)}</span></span>
            </div>
          </div>
        ) : (
          <span className="info-placeholder">
            candle: {candleLabel ?? 'N/A'}
            {candles?.length ? ` | ${candles.length} candles` : ''}
            {` | Average move (ATR14): ${averageMove !== null && averageMove !== undefined ? Number(averageMove).toFixed(4) : 'N/A'} per candle`}
          </span>
        )}
      </div>
    </div>
  )
}
