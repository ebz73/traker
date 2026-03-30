import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import './App.css'
import AnimatedProfileAvatar from './AnimatedProfileAvatar'
import LoginPage from './LoginPage'
import ToastNotification from './ToastNotification'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const STORAGE_KEY = 'price_tracker_products_v3'
const DEFAULT_FREQUENCY = '24h'
const DEFAULT_CURRENCY_CODE = 'USD'
const DAY_IN_MS = 24 * 60 * 60 * 1000
const SCRAPE_STATUS_POLL_INTERVAL_MS = 2000
const SCRAPE_STATUS_MAX_ATTEMPTS = 15
const EXT_PING_INTERVAL_MS = 300
const EXT_PING_MAX_ATTEMPTS = 7
const PICK_ACK_TIMEOUT_MS = 4000
const PICK_START_TIMEOUT_MS = 90000
const PICK_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000

const FREQUENCIES = [
  { value: '6h', label: 'Every 6 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: '24h', label: 'Daily' },
  { value: '7d', label: 'Weekly' },
  { value: '30d', label: 'Monthly' },
]

const HISTORY_WINDOWS = [30, 60, 90, 120]
const FREQUENCY_VALUES = new Set(FREQUENCIES.map((f) => f.value))
const EMPTY_HISTORY = []
const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  JPY: '¥',
  INR: '₹',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  NZD: 'NZ$',
  CHF: 'CHF',
  CNY: 'CN¥',
  HKD: 'HK$',
  SGD: 'S$',
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function getFocusableElements(container) {
  if (!container) return []

  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    if (!(element instanceof HTMLElement)) return false
    if (element.hidden) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    return true
  })
}

function trapFocusWithin(event, container) {
  if (event.key !== 'Tab') return

  const focusableElements = getFocusableElements(container)
  if (focusableElements.length === 0) {
    event.preventDefault()
    if (container instanceof HTMLElement) container.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  const activeElement = document.activeElement

  if (event.shiftKey) {
    if (activeElement === firstElement || !container?.contains(activeElement)) {
      event.preventDefault()
      lastElement.focus()
    }
    return
  }

  if (activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}

function normalizeFrequency(value) {
  return FREQUENCY_VALUES.has(value) ? value : DEFAULT_FREQUENCY
}

function normalizeCurrencyCode(value) {
  if (!value) return DEFAULT_CURRENCY_CODE
  const normalized = String(value).trim().toUpperCase()
  if (CURRENCY_SYMBOLS[normalized]) return normalized
  return DEFAULT_CURRENCY_CODE
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getCurrencySymbol(currencyCode) {
  const code = normalizeCurrencyCode(currencyCode)
  return CURRENCY_SYMBOLS[code] || '$'
}

function formatPrice(value, currencyCode) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '--'
  const code = normalizeCurrencyCode(currencyCode)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    const symbol = getCurrencySymbol(code)
    return symbol.match(/^[A-Z]+$/) ? `${symbol} ${amount.toFixed(2)}` : `${symbol}${amount.toFixed(2)}`
  }
}

function getWebsiteNameFallback(url) {
  try {
    let hostname = new URL(url).hostname
    hostname = hostname.replace(/^(www\d*|m|shop|store)\./, '')
    const name = hostname.split('.')[0]
    if (name && /^[a-z]/.test(name)) {
      return name.charAt(0).toUpperCase() + name.slice(1)
    }
    return name || hostname
  } catch {
    return ''
  }
}

function getPriceTrend(history) {
  if (!Array.isArray(history) || history.length < 2) return null
  const sorted = history
    .filter((h) => h.price != null && Number.isFinite(Number(h.price)))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  if (sorted.length < 2) return null
  const latest = Number(sorted[0].price)
  const previous = sorted.find((h) => Number(h.price) !== latest)
  if (!previous) return null
  const prevPrice = Number(previous.price)
  if (latest < prevPrice) return 'down'
  if (latest > prevPrice) return 'up'
  return null
}

function getExtensionPickedSelector(pickData) {
  // If the extension promoted an original selector to the main selector slot, it usually comes across as 'selector'
  if (pickData?.selector) return pickData.selector
  if (pickData?.custom_selector) return pickData.custom_selector

  // Failsafe in case it wasn't promoted properly
  if (pickData?.original_selector) return pickData.original_selector
  if (pickData?.original_price_selector) return pickData.original_price_selector

  return ''
}

function getExtensionPickedPrice(pickData) {
  if (pickData?.price != null) return Number(pickData.price)
  if (pickData?.validated_price != null) return Number(pickData.validated_price)
  return null
}

function getOriginalSelector(payload, fallback = '') {
  return payload?.original_selector || payload?.original_price_selector || fallback || ''
}

function formatChartDay(timestamp, includeTime = false) {
  const options = includeTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(undefined, options).format(new Date(timestamp))
}

function niceNum(range, shouldRound) {
  if (!Number.isFinite(range) || range <= 0) return 1

  const exponent = Math.floor(Math.log10(range))
  const fraction = range / 10 ** exponent
  let niceFraction = 1

  if (shouldRound) {
    if (fraction < 1.5) niceFraction = 1
    else if (fraction < 3) niceFraction = 2
    else if (fraction < 7) niceFraction = 5
    else niceFraction = 10
  } else {
    if (fraction <= 1) niceFraction = 1
    else if (fraction <= 2) niceFraction = 2
    else if (fraction <= 5) niceFraction = 5
    else niceFraction = 10
  }

  return niceFraction * 10 ** exponent
}

function niceScale(minVal, maxVal, maxTicks = 5) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    return { niceMin: 0, niceMax: 1, tickSpacing: 1 }
  }

  let adjustedMin = minVal
  let adjustedMax = maxVal

  if (adjustedMin === adjustedMax) {
    const flatPadding = Math.max(2, Math.abs(adjustedMin) * 0.05)
    adjustedMin = Math.max(0, adjustedMin - flatPadding)
    adjustedMax += flatPadding
  }

  // Also handle near-flat: range is tiny relative to the values
  const midpoint = (adjustedMin + adjustedMax) / 2
  if (midpoint > 0) {
    const relativeRange = (adjustedMax - adjustedMin) / midpoint
    if (relativeRange < 0.05) {
      const nearFlatPadding = Math.max(2, midpoint * 0.05)
      adjustedMin = Math.max(0, midpoint - nearFlatPadding)
      adjustedMax = midpoint + nearFlatPadding
    }
  }

  const niceRange = niceNum(adjustedMax - adjustedMin, false)
  const tickSpacing = niceNum(niceRange / Math.max(1, maxTicks - 1), true)
  const niceMin = Math.floor(adjustedMin / tickSpacing) * tickSpacing
  const niceMax = Math.ceil(adjustedMax / tickSpacing) * tickSpacing

  return {
    niceMin: Number(niceMin.toFixed(12)),
    niceMax: Number(niceMax.toFixed(12)),
    tickSpacing: Number(tickSpacing.toFixed(12)),
  }
}

function formatAxisTick(value, currencyCode, tickSpacing) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '--'
  const spacing = Number(tickSpacing)
  const decimals =
    Number.isFinite(spacing) && spacing > 0 && spacing < 1
      ? Math.min(4, Math.max(1, Math.ceil(-Math.log10(spacing))))
      : Math.abs(amount) >= 100
        ? 0
        : 2
  const symbol = getCurrencySymbol(currencyCode)
  return symbol.match(/^[A-Z]+$/) ? `${symbol} ${amount.toFixed(decimals)}` : `${symbol}${amount.toFixed(decimals)}`
}

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getPlatform() {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'chrome-desktop'
  return 'other-desktop'
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function scrapeWithPolling(apiBaseUrl, payload, options = {}) {
  const { onPending, headers = {} } = options
  const scrapeRes = await fetch(`${apiBaseUrl}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  const scrapeData = await scrapeRes.json().catch(() => ({}))

  if (scrapeData?.status === 'pending' && scrapeData?.job_id != null) {
    if (typeof onPending === 'function') onPending(scrapeData)
    const jobId = scrapeData.job_id

    for (let attempt = 0; attempt < SCRAPE_STATUS_MAX_ATTEMPTS; attempt += 1) {
      await wait(SCRAPE_STATUS_POLL_INTERVAL_MS)
      const statusRes = await fetch(`${apiBaseUrl}/scrape/status/${encodeURIComponent(jobId)}`, { headers })
      const statusData = await statusRes.json().catch(() => ({ status: 'failed', job_id: jobId }))

      if (statusData?.status === 'pending') continue
      if (statusData?.status === 'done') {
        return { status: statusRes.status, data: statusData }
      }

      // Extension job failed — fall through to retry without extension (Tier 4 CDP)
      console.warn('[Traker] extension job %d failed, retrying with skip_extension=true', jobId)
      break
    }

    // Extension job timed out or failed — retry without extension so backend
    // falls through to Tier 4 CDP instead of returning an error to the user
    if (!payload.skip_extension) {
      try {
        const retryRes = await fetch(`${apiBaseUrl}/scrape`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ ...payload, skip_extension: true }),
        })
        const retryData = await retryRes.json().catch(() => ({}))
        return { status: retryRes.status, data: retryData }
      } catch (retryErr) {
        console.warn('[Traker] CDP fallback retry failed:', retryErr)
        return { status: 408, data: { status: 'failed', job_id: jobId } }
      }
    }

    return { status: 408, data: { status: 'failed', job_id: jobId } }
  }

  return { status: scrapeRes.status, data: scrapeData }
}

async function checkDuplicateUrl(apiBaseUrl, url, headers = {}) {
  try {
    const res = await fetch(
      `${apiBaseUrl}/tracked-products/check-url?url=${encodeURIComponent(url)}`,
      { headers },
    )
    if (!res.ok) return null
    const data = await res.json()
    return data?.exists ? data : null
  } catch {
    return null
  }
}

function findLocalDuplicate(products, url) {
  const trimmed = url.trim().toLowerCase().replace(/\/+$/, '')
  return products.find((p) => {
    const existing = (p.url || '').trim().toLowerCase().replace(/\/+$/, '')
    return existing === trimmed
  })
}

function buildSmoothPath(points) {
  if (points.length === 0) return ''
  if (points.length === 1) return ''
  let d = `M ${points[0].x} ${points[0].y}`

  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${points[i].x} ${points[i].y}`
  }

  return d
}

function PriceHistoryChart({ history, fallbackCurrencyCode, days, referenceTimestamp, threshold }) {
  const [hoverInfo, setHoverInfo] = useState(null)
  const chartId = useId().replace(/:/g, '')
  const clipPathId = `${chartId}-price-chart-clip`
  const gradientId = `${chartId}-price-chart-fill`

  const chartData = useMemo(() => {
    const referenceTimestampMs = new Date(referenceTimestamp || '').getTime()
    const latestHistoryTimestamp = history.reduce((latest, item) => {
      const timestampMs = new Date(item.timestamp).getTime()
      if (!Number.isFinite(timestampMs)) return latest
      return Math.max(latest, timestampMs)
    }, 0)
    const anchorTimestamp =
      Number.isFinite(referenceTimestampMs) && referenceTimestampMs > 0
        ? referenceTimestampMs
        : latestHistoryTimestamp
    const cutoff = anchorTimestamp > 0 ? anchorTimestamp - days * DAY_IN_MS : -Infinity

    const filteredHistory = history
      .map((item) => {
        const timestampMs = new Date(item.timestamp).getTime()
        const price = Number(item.price)
        if (!Number.isFinite(timestampMs) || !Number.isFinite(price)) return null
        if (price <= 0) return null
        if (timestampMs < cutoff) return null

        return {
          id: item.id,
          timestampMs,
          price,
          currencyCode: normalizeCurrencyCode(item.currency_code || fallbackCurrencyCode),
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.timestampMs - b.timestampMs)

    if (filteredHistory.length < 3) return filteredHistory

    const sortedPrices = filteredHistory.map((point) => point.price).sort((a, b) => a - b)
    const middleIndex = Math.floor(sortedPrices.length / 2)
    const medianPrice =
      sortedPrices.length % 2 === 0
        ? (sortedPrices[middleIndex - 1] + sortedPrices[middleIndex]) / 2
        : sortedPrices[middleIndex]

    if (!Number.isFinite(medianPrice) || medianPrice <= 0) return filteredHistory

    const minAllowedPrice = medianPrice * 0.1
    return filteredHistory.filter((point) => point.price >= minAllowedPrice)
  }, [days, fallbackCurrencyCode, history, referenceTimestamp])

  if (chartData.length === 0) {
    return (
      <div className="historyEmpty">
        No price data for this time window. Try selecting a wider range or run a manual price check.
      </div>
    )
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 600
  const chartWidth = 980
  const chartHeight = isMobile ? 450 : 300
  const minTimestamp = chartData[0].timestampMs
  const maxTimestamp = chartData[chartData.length - 1].timestampMs
  const timestampRange = Math.max(0, maxTimestamp - minTimestamp)
  const chartCurrencyCode = chartData[chartData.length - 1]?.currencyCode || normalizeCurrencyCode(fallbackCurrencyCode)

  const minPriceRaw = Math.min(...chartData.map((point) => point.price))
  const maxPriceRaw = Math.max(...chartData.map((point) => point.price))
  const priceRangePadding = Math.max(1, (maxPriceRaw - minPriceRaw) * 0.05)
  const { niceMin: minPrice, niceMax: maxPrice, tickSpacing } = niceScale(
    minPriceRaw - priceRangePadding,
    maxPriceRaw + priceRangePadding,
    5,
  )
  const priceRange = Math.max(Number.EPSILON, maxPrice - minPrice)
  const yTickCount = Math.min(20, Math.max(2, Math.round((maxPrice - minPrice) / tickSpacing) + 1))
  const yTickValues = Array.from({ length: yTickCount }, (_, index) => Number((minPrice + index * tickSpacing).toFixed(12))).reverse()
  const estimatedMaxLabelWidth = yTickValues.reduce((maxLabelWidth, value) => {
    const label = formatAxisTick(value, chartCurrencyCode, tickSpacing)
    return Math.max(maxLabelWidth, label.length * 6.5)
  }, 0)
  const margin = {
    top: 14,
    right: isMobile ? 12 : 16,
    bottom: isMobile ? 50 : 40,
    left: Math.max(56, estimatedMaxLabelWidth + 16),
  }
  const plotWidth = chartWidth - margin.left - margin.right
  const plotHeight = chartHeight - margin.top - margin.bottom

  const toX = (timestampMs) => {
    if (timestampRange === 0) return margin.left + plotWidth / 2
    return margin.left + ((timestampMs - minTimestamp) / timestampRange) * plotWidth
  }

  const toY = (price) => margin.top + ((maxPrice - price) / priceRange) * plotHeight

  const points = chartData.map((point) => ({
    x: toX(point.timestampMs),
    y: toY(point.price),
    ...point,
  }))

  const linePoints =
    points.length === 1
      ? [
          { x: margin.left, y: points[0].y },
          { x: margin.left + plotWidth, y: points[0].y },
        ]
      : points

  const linePath = buildSmoothPath(linePoints)
  const fillPath = linePath
    ? `${linePath} L ${linePoints[linePoints.length - 1].x} ${margin.top + plotHeight} L ${linePoints[0].x} ${margin.top + plotHeight} Z`
    : ''

  const yTicks = yTickValues.map((value) => {
    const label = formatAxisTick(value, chartCurrencyCode, tickSpacing)
    return {
      value,
      label,
      y: toY(value),
    }
  })

  const includeTimeInTicks = !isMobile && timestampRange < 3 * DAY_IN_MS
  const includeTimeInTooltip = timestampRange < 3 * DAY_IN_MS
  const rawXTicks =
    timestampRange === 0
      ? [
          {
            x: margin.left + plotWidth / 2,
            label: formatChartDay(points[0].timestampMs, includeTimeInTicks),
          },
        ]
      : Array.from({ length: 6 }, (_, index) => {
          const ratio = index / 5
          const timestamp = minTimestamp + ratio * timestampRange
          return {
            x: margin.left + ratio * plotWidth,
            label: formatChartDay(timestamp, includeTimeInTicks),
          }
        })
  const xTicks = rawXTicks.filter((tick, index) => index === 0 || tick.label !== rawXTicks[index - 1].label)
  const normalizedThreshold = threshold === '' || threshold == null ? null : Number(threshold)
  const showThresholdLine =
    Number.isFinite(normalizedThreshold) && normalizedThreshold >= minPrice && normalizedThreshold <= maxPrice
  const thresholdY = showThresholdLine ? toY(normalizedThreshold) : 0

  const updateHoverFromClientX = (clientX, rect) => {
    if (!rect?.width) return
    const pointerRatio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const pointerX = margin.left + pointerRatio * plotWidth

    if (points.length === 1 || timestampRange === 0) {
      setHoverInfo({
        x: pointerX,
        timestamp: points[0].timestampMs,
        price: points[0].price,
        currencyCode: points[0].currencyCode,
      })
      return
    }

    const hoveredTimestamp = minTimestamp + pointerRatio * timestampRange

    if (hoveredTimestamp <= points[0].timestampMs) {
      setHoverInfo({
        x: pointerX,
        timestamp: points[0].timestampMs,
        price: points[0].price,
        currencyCode: points[0].currencyCode,
      })
      return
    }

    const lastPoint = points[points.length - 1]
    if (hoveredTimestamp >= lastPoint.timestampMs) {
      setHoverInfo({
        x: pointerX,
        timestamp: lastPoint.timestampMs,
        price: lastPoint.price,
        currencyCode: lastPoint.currencyCode,
      })
      return
    }

    let leftPoint = points[0]
    let rightPoint = lastPoint

    for (let i = 1; i < points.length; i += 1) {
      if (points[i].timestampMs >= hoveredTimestamp) {
        leftPoint = points[i - 1]
        rightPoint = points[i]
        break
      }
    }

    const segmentDuration = rightPoint.timestampMs - leftPoint.timestampMs
    const interpolationRatio =
      segmentDuration > 0 ? (hoveredTimestamp - leftPoint.timestampMs) / segmentDuration : 0
    const interpolatedPrice = leftPoint.price + (rightPoint.price - leftPoint.price) * interpolationRatio

    setHoverInfo({
      x: pointerX,
      timestamp: hoveredTimestamp,
      price: interpolatedPrice,
      currencyCode: leftPoint.currencyCode || rightPoint.currencyCode || chartCurrencyCode,
    })
  }

  const handleMouseMove = (event) => {
    updateHoverFromClientX(event.clientX, event.currentTarget.getBoundingClientRect())
  }

  const handleTouchMove = (event) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    updateHoverFromClientX(touch.clientX, event.currentTarget.getBoundingClientRect())
  }

  const tooltipWidth = isMobile ? 160 : (includeTimeInTicks ? 230 : 170)
  const tooltipHeight = isMobile ? 72 : 88
  let tooltipX = 0
  let tooltipY = 0
  let hoverY = 0

  if (hoverInfo) {
    hoverY = toY(hoverInfo.price)
    tooltipX = hoverInfo.x + 12
    tooltipY = hoverY - tooltipHeight - 12

    const maxTooltipX = chartWidth - margin.right - tooltipWidth
    if (tooltipX > maxTooltipX) tooltipX = hoverInfo.x - tooltipWidth - 12
    if (tooltipX < margin.left) tooltipX = margin.left
    if (tooltipY < margin.top) tooltipY = hoverY + 12
  }

  const distinctPriceCount = new Set(chartData.map((point) => point.price.toFixed(4))).size
  const showExtremaAnnotations = distinctPriceCount >= 2
  const minPoint = showExtremaAnnotations
    ? points.reduce((lowestPoint, point) => (point.price < lowestPoint.price ? point : lowestPoint), points[0])
    : null
  const maxPoint = showExtremaAnnotations
    ? points.reduce((highestPoint, point) => (point.price > highestPoint.price ? point : highestPoint), points[0])
    : null
  const showMinAnnotation =
    Boolean(minPoint && maxPoint) && Math.abs(maxPoint.x - minPoint.x) >= 60
  const plotMidX = margin.left + plotWidth / 2
  const maxAnchor = maxPoint ? (maxPoint.x < plotMidX ? 'start' : 'end') : 'start'
  const maxLabelX = maxPoint ? (maxPoint.x < plotMidX ? maxPoint.x + 8 : maxPoint.x - 8) : 0
  const minAnchor = minPoint ? (minPoint.x < plotMidX ? 'start' : 'end') : 'start'
  const minLabelX = minPoint ? (minPoint.x < plotMidX ? minPoint.x + 8 : minPoint.x - 8) : 0

  return (
    <div className="priceChartWrap">
      <svg
        className="priceChartSvg"
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        role="img"
        aria-label="Price history chart"
      >
        <desc>
          Price history from {formatChartDay(chartData[0].timestampMs)} to {formatChartDay(chartData[chartData.length - 1].timestampMs)}.
          {' '}Price range: {formatPrice(minPriceRaw, chartCurrencyCode)} to {formatPrice(maxPriceRaw, chartCurrencyCode)}.
          {' '}Latest price: {formatPrice(chartData[chartData.length - 1].price, chartCurrencyCode)}.
        </desc>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--chart-line)', stopOpacity: 0.15 }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-line)', stopOpacity: 0 }} />
          </linearGradient>
          <clipPath id={clipPathId}>
            <rect
              x={margin.left}
              y={margin.top}
              width={plotWidth}
              height={plotHeight}
              rx="10"
              ry="10"
            />
          </clipPath>
        </defs>

        <rect
          x={margin.left}
          y={margin.top}
          width={plotWidth}
          height={plotHeight}
          fill="var(--bg-chart)"
          rx="10"
          ry="10"
        />

        {yTicks.map((tick) => (
          <g key={`ytick-${tick.y}`}>
            <line
              x1={margin.left}
              y1={tick.y}
              x2={margin.left + plotWidth}
              y2={tick.y}
              className="priceChartGridLine"
            />
            <text x={margin.left - 12} y={tick.y + 4} className="priceChartAxisLabel" textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}

        {xTicks.map((tick, index) => (
          <g key={`xtick-${index}`}>
            <line
              x1={tick.x}
              y1={margin.top}
              x2={tick.x}
              y2={margin.top + plotHeight}
              className="priceChartGridLine vertical"
            />
            <text
              x={tick.x}
              y={chartHeight - 12}
              className="priceChartAxisLabel"
              textAnchor={
                xTicks.length === 1
                  ? 'middle'
                  : index === 0
                    ? 'start'
                    : index === xTicks.length - 1
                      ? 'end'
                      : 'middle'
              }
            >
              {tick.label}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipPathId})`}>
          <g className="chartRevealGroup">
            {fillPath && <path d={fillPath} className="priceChartFill" fill={`url(#${gradientId})`} />}
            {linePath && <path d={linePath} className="priceChartLine" />}
          </g>
        </g>

        {points.length > 0 && (
          <circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r="4"
            fill="var(--chart-dot)"
            stroke="var(--bg-card)"
            strokeWidth="2"
            className="lastPriceDot"
          />
        )}

        {showThresholdLine && (
          <>
            <line
              x1={margin.left}
              y1={thresholdY}
              x2={margin.left + plotWidth}
              y2={thresholdY}
              stroke="var(--chart-threshold)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.6"
            />
            <text
              x={margin.left + plotWidth - 6}
              y={Math.max(margin.top + 11, thresholdY - 6)}
              fill="var(--chart-threshold)"
              fontSize="11"
              fontWeight="600"
              textAnchor="end"
            >
              Target
            </text>
          </>
        )}

        {!isMobile && maxPoint && (
          <text
            x={maxLabelX}
            y={Math.max(margin.top + 12, maxPoint.y - 10)}
            fill="var(--muted)"
            fontSize="10"
            fontWeight="600"
            textAnchor={maxAnchor}
          >
            {formatPrice(maxPoint.price, maxPoint.currencyCode)}
          </text>
        )}

        {!isMobile && showMinAnnotation && minPoint && (
          <text
            x={minLabelX}
            y={Math.min(margin.top + plotHeight - 4, minPoint.y + 16)}
            fill="var(--muted)"
            fontSize="10"
            fontWeight="600"
            textAnchor={minAnchor}
          >
            {formatPrice(minPoint.price, minPoint.currencyCode)}
          </text>
        )}

        {hoverInfo && (
          <>
            <circle
              cx={hoverInfo.x}
              cy={hoverY}
              r={isMobile ? 18 : 12}
              fill="var(--chart-dot)"
              opacity="0.15"
            />
            <circle
              cx={hoverInfo.x}
              cy={hoverY}
              r={isMobile ? 8 : 5}
              fill="var(--chart-dot)"
              stroke="var(--bg-card)"
              strokeWidth="2"
            />
            <g transform={`translate(${tooltipX}, ${tooltipY})`}>
              <rect width={tooltipWidth} height={tooltipHeight} rx="14" ry="14" className="priceChartTooltip" />
              <text
                x="18"
                y={isMobile ? 28 : 34}
                className="priceChartTooltipDate"
                fontSize={isMobile ? 16 : undefined}
              >
                {formatChartDay(hoverInfo.timestamp, includeTimeInTooltip)}
              </text>
              <text
                x="18"
                y={isMobile ? 52 : 64}
                className="priceChartTooltipPrice"
                fontSize={isMobile ? 14 : undefined}
              >
                Price: {formatPrice(hoverInfo.price, hoverInfo.currencyCode)}
              </text>
            </g>
          </>
        )}

        <rect
          x={margin.left}
          y={margin.top}
          width={plotWidth}
          height={plotHeight}
          className="priceChartHitbox"
          onTouchStart={(e) => e.preventDefault()}
          onMouseMove={handleMouseMove}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => setHoverInfo(null)}
          onMouseLeave={() => setHoverInfo(null)}
        />
      </svg>
    </div>
  )
}

function PriceHistoryChartSkeleton() {
  const chartWidth = 980
  const chartHeight = 300
  const margin = { top: 14, right: 16, bottom: 40, left: 72 }
  const plotWidth = chartWidth - margin.left - margin.right
  const plotHeight = chartHeight - margin.top - margin.bottom
  const horizontalLines = Array.from({ length: 4 }, (_, index) => margin.top + ((index + 1) / 5) * plotHeight)

  return (
    <div className="priceChartWrap">
      <svg
        className="priceChartSvg"
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        aria-hidden="true"
        focusable="false"
      >
        <g className="chartSkeleton">
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            rx="10"
            ry="10"
            fill="var(--chart-skeleton-bg)"
          />
          {horizontalLines.map((y) => (
            <line
              key={`skeleton-line-${y}`}
              x1={margin.left + 12}
              y1={y}
              x2={margin.left + plotWidth - 12}
              y2={y}
              stroke="var(--chart-skeleton-grid)"
              strokeWidth="1"
              strokeDasharray="5 5"
            />
          ))}
          <path
            d={`M ${margin.left + 10} ${margin.top + plotHeight - 48} L ${margin.left + 180} ${margin.top + plotHeight - 88} L ${margin.left + 360} ${margin.top + plotHeight - 78} L ${margin.left + 560} ${margin.top + plotHeight - 126} L ${margin.left + 760} ${margin.top + plotHeight - 98} L ${margin.left + plotWidth - 10} ${margin.top + plotHeight - 146}`}
            fill="none"
            stroke="var(--chart-skeleton-line)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>
  )
}

class ChartErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Chart render error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="historyEmpty">
          Unable to render price chart. Try a different time window or run a manual price check.
        </div>
      )
    }

    return this.props.children
  }
}

function ProductCard({
  product,
  loadingId,
  scrapingUrls,
  expandedHistory,
  historyByUrl,
  historyLoadingByUrl,
  onCheck,
  onRedoPick,
  onRemove,
  onUpdate,
  onToggleHistory,
}) {
  const history = historyByUrl[product.url] || EMPTY_HISTORY
  const isHistoryLoading = historyLoadingByUrl[product.url]
  const shouldShowHistoryLoading = isHistoryLoading && history.length === 0
  const isExpanded = expandedHistory[product.id]
  const isLoading = loadingId === product.id
  const isScraping = scrapingUrls.has(product.url)
  const trend = getPriceTrend(history)
  const frequency = normalizeFrequency(product.frequency)
  const thresholdInputId = `threshold-${product.id}`
  const frequencyInputId = `frequency-${product.id}`
  const isBelowThreshold =
    product.lastPrice != null &&
    product.threshold != null &&
    product.threshold !== '' &&
    Number(product.threshold) > 0 &&
    Number(product.lastPrice) <= Number(product.threshold)
  const [historyWindowDays, setHistoryWindowDays] = useState(30)
  const historyDataCount = useMemo(() => {
    if (history.length === 0) return 0
    const now = product.lastChecked
      ? new Date(product.lastChecked).getTime()
      : history.reduce((latestTimestamp, item) => {
          const ts = new Date(item.timestamp).getTime()
          return Number.isFinite(ts) ? Math.max(latestTimestamp, ts) : latestTimestamp
        }, 0)
    const cutoff = now - historyWindowDays * 24 * 60 * 60 * 1000
    return history.filter((item) => {
      const ts = new Date(item.timestamp).getTime()
      const price = Number(item.price)
      return Number.isFinite(ts) && Number.isFinite(price) && price > 0 && ts >= cutoff
    }).length
  }, [history, historyWindowDays, product.lastChecked])

  return (
    <article
      className={`card productCard${isBelowThreshold ? ' belowThreshold' : ''}`}
      aria-label={product.name || 'Tracked Product'}
    >
      {isBelowThreshold && (
        <span className="srOnly">Price is below your threshold</span>
      )}
      {product.ui_changed && product.scraper_available !== false && (
        <div className="uiChangedBanner">
          <div>
            <strong className="uiChangedTitle">Website Layout Changed</strong>
            <span className="uiChangedSub">UI layout changed. Redo price capture for efficient tracking.</span>
          </div>
          <button className="uiChangedBtn" onClick={() => onRedoPick(product)} disabled={isLoading}>
            {isLoading ? 'Opening...' : 'Redo'}
          </button>
        </div>
      )}

      <div className="productHead">
        <div>
          <h3>{product.name || 'Tracked Product'}</h3>
          {(product.siteName || product.url) && (
            <span className="productSiteName">{product.siteName || getWebsiteNameFallback(product.url)}</span>
          )}
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`View ${product.name || 'tracked product'} on the source website`}
          >
            View Product
          </a>
          <div className="metaLine">
            Last checked: {product.lastChecked ? new Date(product.lastChecked).toLocaleString() : 'Never'}
          </div>
        </div>
        <div className="productHeadActions">
          {isScraping && (
            <div className="scrapeSpinner" title="Checking price...">
              <svg width="20" height="20" viewBox="0 0 20 20" className="scrapeSpinnerSvg">
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="var(--purple)"
                  strokeWidth="2.5"
                  strokeDasharray="36 14"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          )}
          <button
            className="iconBtn"
            onClick={() => {
              if (window.confirm(`Remove "${product.name || 'this product'}" from your droplist?`)) {
                onRemove(product.id)
              }
            }}
            aria-label={`Delete ${product.name || 'product'}`}
            type="button"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="productGrid">
        <div className="miniBox">
          <span>Latest Price</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
            <strong style={{ color: product.originalPrice != null ? 'var(--error)' : 'inherit' }}>
              {product.displayPrice || '--'}
            </strong>
            {trend === 'down' && (
              <span
                style={{ color: 'var(--price-down)', fontWeight: '700', fontSize: '0.9em' }}
                title="Price dropped"
                aria-label="Price dropped"
              >
                ↓
              </span>
            )}
            {trend === 'up' && (
              <span
                style={{ color: 'var(--price-up)', fontWeight: '700', fontSize: '0.9em' }}
                title="Price increased"
                aria-label="Price increased"
              >
                ↑
              </span>
            )}
            {product.displayOriginalPrice && (
              <>
                <span
                  style={{
                    textDecoration: 'line-through',
                    color: 'var(--strikethrough)',
                    fontSize: '0.85em',
                    fontWeight: '500',
                  }}
                >
                  {product.displayOriginalPrice}
                </span>
                {product.originalPrice != null && product.lastPrice != null && product.originalPrice > product.lastPrice && (
                  <span style={{
                    display: 'inline-block',
                    background: 'var(--success-bg)',
                    color: 'var(--price-down)',
                    fontSize: '0.75em',
                    fontWeight: '700',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    marginLeft: '4px',
                    verticalAlign: 'middle',
                  }}>
                    -{Math.round((1 - product.lastPrice / product.originalPrice) * 100)}%
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="miniBox">
          <label htmlFor={thresholdInputId}>Your Threshold</label>
          <input
            id={thresholdInputId}
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={product.threshold}
            onChange={(e) => onUpdate(product.id, { threshold: e.target.value === '' ? '' : Number(e.target.value) })}
          />
        </div>
        <div className="miniBox">
          <label htmlFor={frequencyInputId}>Check Frequency</label>
          <select
            id={frequencyInputId}
            className="input"
            value={frequency}
            onChange={(e) => onUpdate(product.id, { frequency: e.target.value })}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        className="primaryBtn narrow manualScrapeBtn"
        onClick={() => onCheck(product)}
        disabled={isScraping || isLoading}
        aria-busy={isScraping}
      >
        {isScraping ? 'Checking...' : 'Manual Price Check'}
      </button>

      <button className="historyToggle" onClick={() => onToggleHistory(product.id)}>
        {isExpanded ? 'Hide Recent History' : 'Show Recent History'}
      </button>

      {isExpanded && (
        <div className="inlineHistory chartHistory">
          <div className="priceHistoryHead">
            <h4>Price History</h4>
            <div className="historyWindowSwitch">
              {HISTORY_WINDOWS.map((days) => (
                <button
                  key={days}
                  className={`historyWindowBtn${historyWindowDays === days ? ' active' : ''}`}
                  onClick={() => setHistoryWindowDays(days)}
                  type="button"
                >
                  {days} days
                </button>
              ))}
            </div>
            <select
              className="historyWindowSelect"
              value={historyWindowDays}
              onChange={(e) => setHistoryWindowDays(Number(e.target.value))}
              aria-label="Price history window"
            >
              {HISTORY_WINDOWS.map((days) => (
                <option key={days} value={days}>{days} days</option>
              ))}
            </select>
          </div>

          {shouldShowHistoryLoading ? (
            <PriceHistoryChartSkeleton />
          ) : (
            <ChartErrorBoundary>
              <PriceHistoryChart
                key={`history-${historyDataCount}`}
                history={history}
                fallbackCurrencyCode={product.currencyCode}
                days={historyWindowDays}
                referenceTimestamp={product.lastChecked}
                threshold={product.threshold}
              />
            </ChartErrorBoundary>
          )}
        </div>
      )}
    </article>
  )
}

function ExtensionPromptModal({
  show,
  dontShowAgain,
  onChangeDontShowAgain,
  onGetExtension,
  onSkip,
  onDismiss,
}) {
  const modalRef = useRef(null)

  useEffect(() => {
    if (!show) return undefined

    const previousActiveElement = document.activeElement
    const focusableElements = getFocusableElements(modalRef.current)
    const nextFocusTarget = focusableElements[0] || modalRef.current
    if (nextFocusTarget instanceof HTMLElement) nextFocusTarget.focus()

    return () => {
      if (previousActiveElement instanceof HTMLElement) previousActiveElement.focus()
    }
  }, [show])

  if (!show) return null

  return (
    <div
      className="extPromptOverlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="extPromptModal card"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-prompt-title"
        aria-describedby="ext-prompt-description"
        tabIndex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDismiss()
            return
          }
          trapFocusWithin(e, modalRef.current)
        }}
      >
        <h3 id="ext-prompt-title">Use Traker Extension?</h3>
        <p id="ext-prompt-description">Install our Chrome extension for more accurate price tracking with a visual picker.</p>

        <label className="extPromptCheck">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => onChangeDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>

        <div className="extPromptActions">
          <button className="primaryBtn" type="button" onClick={onGetExtension}>
            Get Extension
          </button>
          <button className="secondaryBtn" type="button" onClick={onSkip}>
            Skip, use automatic detection
          </button>
        </div>
      </div>
    </div>
  )
}

const CHARACTER_AVATARS = {
  purple: {
    bg: '#6c3ff5',
    eyeWhite: '#FFFFFF',
    pupil: '#252525',
    shape: 'rect',
    hasMouth: false,
  },
  black: {
    bg: '#2d2d2d',
    eyeWhite: '#FFFFFF',
    pupil: '#1D1D1D',
    shape: 'rect',
    hasMouth: false,
  },
  orange: {
    bg: '#ff9b6b',
    eyeWhite: null,
    pupil: '#3A2B24',
    shape: 'dome',
    hasMouth: true,
  },
  yellow: {
    bg: '#e8d754',
    eyeWhite: null,
    pupil: '#3A3420',
    shape: 'dome',
    hasMouth: true,
  },
}

const PROFILE_AVATAR_NAMES = ['purple', 'black', 'orange', 'yellow']

function MiniCharacter({ name, size = 40 }) {
  const char = CHARACTER_AVATARS[name] || CHARACTER_AVATARS.purple
  const clipId = `${useId()}-${name}-${size}`.replace(/:/g, '')
  const backdrop = name === 'black' ? '#efeef5' : '#f7f4ff'

  const body =
    char.shape === 'rect' ? (
      <path
        d="M7 40V15c0-4.4 3.6-8 8-8h10c4.4 0 8 3.6 8 8v25H7z"
        fill={char.bg}
      />
    ) : name === 'yellow' ? (
      <path
        d="M8 40V24c0-7.6 5.4-12.5 12-12.5S32 16.4 32 24v16H8z"
        fill={char.bg}
      />
    ) : (
      <path
        d="M3 40V28c0-9.5 7.6-17.2 17-17.2S37 18.5 37 28v12H3z"
        fill={char.bg}
      />
    )

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="40" height="40" fill={backdrop} />
        {body}

        {char.eyeWhite ? (
          <>
            <circle cx="14" cy="20" r="4.6" fill={char.eyeWhite} />
            <circle cx="14" cy="20" r="1.9" fill={char.pupil} />
            <circle cx="26" cy="20" r="4.6" fill={char.eyeWhite} />
            <circle cx="26" cy="20" r="1.9" fill={char.pupil} />
          </>
        ) : (
          <>
            <circle cx="14.2" cy="20.4" r="2.25" fill={char.pupil} />
            <circle cx="25.8" cy="20.4" r="2.25" fill={char.pupil} />
          </>
        )}

        {char.hasMouth && (
          <rect x="15" y="27.2" width="10" height="1.7" rx="0.85" fill="#2d2d2d" />
        )}
      </g>
    </svg>
  )
}

function App() {
  const [tab, setTab] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const tabParam = (params.get('tab') || '').toLowerCase()
      if (tabParam === 'droplist') return 'droplist'
      if (tabParam === 'home') return 'home'
      if ((window.location.hash || '').toLowerCase() === '#droplist') return 'droplist'
    } catch {
      // Ignore URL parsing issues and default to home
    }
    return 'home'
  })
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem('traker_theme')
    if (stored === 'dark' || stored === 'light') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  const [url, setUrl] = useState('')
  const [threshold, setThreshold] = useState('')
  const [frequency, setFrequency] = useState(DEFAULT_FREQUENCY)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const [navHidden, setNavHidden] = useState(false)
  const [sortBy, setSortBy] = useState('default')
  const [profileOpen, setProfileOpen] = useState(false)
  const [avatarChar, setAvatarChar] = useState(() => localStorage.getItem('pt_avatar_char') || 'purple')
  const droplistRef = useRef(null)
  const profileRef = useRef(null)
  const lastScrollY = useRef(0)

  const [products, setProducts] = useState([])
  const [loadingId, setLoadingId] = useState('')
  const [scrapingUrls, setScrapingUrls] = useState(new Set())
  const [toast, setToast] = useState(null)
  const toastIdRef = useRef(0)

  const [expandedHistory, setExpandedHistory] = useState({})
  const [historyByUrl, setHistoryByUrl] = useState({})
  const [historyLoadingByUrl, setHistoryLoadingByUrl] = useState({})
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('pt_auth_token') || '')
  const authTokenRef = useRef(authToken)
  const [authEmail, setAuthEmail] = useState(() => localStorage.getItem('pt_auth_email') || '')
  const [authView, setAuthView] = useState('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [authSuccess, setAuthSuccess] = useState(false)
  const [loginExiting, setLoginExiting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [platform] = useState(() => getPlatform())
  const [extensionInstalled, setExtensionInstalled] = useState(false)
  const [dismissedExtPrompt, setDismissedExtPrompt] = useState(
    () => localStorage.getItem('pt_dismiss_ext_prompt') === 'true',
  )
  const [showExtPrompt, setShowExtPrompt] = useState(false)
  const [pendingProduct, setPendingProduct] = useState(null)
  const [dontShowExtPromptAgain, setDontShowExtPromptAgain] = useState(false)
  const [emailSettings, setEmailSettings] = useState({ enabled: false, recipients: [], primaryEmail: '' })
  const [emailSettingsLoading, setEmailSettingsLoading] = useState(false)
  const [pendingAlertCount, setPendingAlertCount] = useState(0)
  const [newRecipientEmail, setNewRecipientEmail] = useState('')
  const [homeFormErrors, setHomeFormErrors] = useState({ url: false, threshold: false })
  const [recipientEmailInvalid, setRecipientEmailInvalid] = useState(false)

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  const navClass = (t) => `navBtn${tab === t ? ' active' : ''}`
  const isLoggedIn = Boolean(authToken)
  const handleProfileWrapKeyDown = (event) => {
    if (event.key === 'Escape' && profileOpen) {
      event.preventDefault()
      setProfileOpen(false)
      profileRef.current?.querySelector('.profileBtn')?.focus()
      return
    }

    if (profileOpen) {
      trapFocusWithin(event, profileRef.current)
    }
  }

  const saveAuth = (token, email) => {
    authTokenRef.current = token
    setAuthToken(token)
    setAuthEmail(email)
    localStorage.setItem('pt_auth_token', token)
    localStorage.setItem('pt_auth_email', email)
  }

  const clearAuth = useCallback(() => {
    authTokenRef.current = ''
    setAuthToken('')
    setAuthEmail('')
    setEmailSettings({ enabled: false, recipients: [], primaryEmail: '' })
    setEmailSettingsLoading(false)
    setPendingAlertCount(0)
    setNewRecipientEmail('')
    localStorage.removeItem('pt_auth_token')
    localStorage.removeItem('pt_auth_email')
  }, [])

  const showToast = useCallback((message, type = 'neutral') => {
    toastIdRef.current += 1
    setToast({ message, type, id: toastIdRef.current })
  }, [])

  const dismissToast = useCallback(() => {
    setToast(null)
  }, [])

  useEffect(() => {
    authTokenRef.current = authToken
  }, [authToken])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('traker_theme', theme)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#0f1117' : '#6c3ff5')
    }
  }, [theme])

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  const authHeaders = useCallback(
    (extraHeaders = {}) => ({
      ...extraHeaders,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  )

  const authFetch = useCallback(
    async (requestUrl, options = {}) => {
      const tokenAtRequest = authTokenRef.current
      const headers = authHeaders(options.headers || {})
      const res = await fetch(requestUrl, { ...options, headers })
      if (res.status === 401) {
        // Ignore stale 401s from requests started before a newer session was established.
        if (authTokenRef.current === tokenAtRequest) {
          clearAuth()
          showToast('Session expired. Please log in again.', 'error')
        }
      }
      return res
    },
    [authHeaders, clearAuth, showToast],
  )

  const deleteAccount = useCallback(async () => {
    const confirmed = window.confirm(
      'Are you sure you want to permanently delete your account? This will remove all your tracked products, price history, and settings. This action cannot be undone.'
    )
    if (!confirmed) return

    const doubleConfirmed = window.confirm(
      'This is permanent. All your data will be deleted immediately. Continue?'
    )
    if (!doubleConfirmed) return

    try {
      const res = await authFetch(`${API}/auth/account`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail || 'Failed to delete account')
      }
      clearAuth()
      setProducts([])
      setHistoryByUrl({})
      setProfileOpen(false)
      showToast('Your account has been permanently deleted.', 'success')
    } catch (err) {
      console.error('[Traker] account deletion failed:', err)
      showToast(err?.message || 'Failed to delete account. Please try again.', 'error')
    }
  }, [authFetch, clearAuth, showToast])

  const fetchEmailSettings = useCallback(async () => {
    if (!authTokenRef.current) return
    try {
      const res = await authFetch(`${API}/email-settings`)
      if (res.ok) {
        const data = await res.json()
        setEmailSettings({
          enabled: data.enabled,
          recipients: data.recipients || [],
          primaryEmail: data.primary_email || '',
        })
      }
    } catch {/* Ignore errors and keep existing settings */}
  }, [authFetch])

  const fetchPendingAlertCount = useCallback(async () => {
    if (!authTokenRef.current) return
    try {
      const res = await authFetch(`${API}/email-alerts/pending`)
      if (res.ok) {
        const data = await res.json()
        setPendingAlertCount(data.pending_count || 0)
      }
    } catch {/* Ignore errors and keep existing count */}
  }, [authFetch])

  const updateEmailSettings = async (updates) => {
    setEmailSettingsLoading(true)
    try {
      const res = await authFetch(`${API}/email-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: updates.enabled ?? emailSettings.enabled,
          recipients: updates.recipients ?? emailSettings.recipients,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setEmailSettings((prev) => ({
          ...prev,
          enabled: data.enabled,
          recipients: data.recipients || prev.recipients,
        }))
        showToast('Email settings saved.', 'success')
      } else {
        showToast('Failed to save email settings.', 'error')
      }
    } catch {
      showToast('Failed to save email settings.', 'error')
    } finally {
      setEmailSettingsLoading(false)
    }
  }

  const addRecipient = () => {
    const email = normalizeEmail(newRecipientEmail)
    if (!email || !email.includes('@') || !email.includes('.')) {
      setRecipientEmailInvalid(true)
      showToast('Please enter a valid email address.', 'error')
      return
    }
    setRecipientEmailInvalid(false)
    if (email === normalizeEmail(emailSettings.primaryEmail)) {
      showToast('This is already your primary email.', 'error')
      return
    }
    if (emailSettings.recipients.includes(email)) {
      showToast('This email is already added.', 'error')
      return
    }
    const nextRecipients = [...emailSettings.recipients, email]
    setNewRecipientEmail('')
    updateEmailSettings({ recipients: nextRecipients })
  }

  const removeRecipient = (email) => {
    const nextRecipients = emailSettings.recipients.filter((r) => r !== email)
    updateEmailSettings({ recipients: nextRecipients })
  }

  const sendDigestNow = async () => {
    try {
      const res = await authFetch(`${API}/email-alerts/send-digest`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (data.ok && data.sent > 0) {
        showToast(`Digest sent! ${data.sent} alert(s) emailed.`, 'success')
        setPendingAlertCount(0)
      } else if (data.ok && data.sent === 0) {
        showToast('No pending alerts to send.', 'neutral')
        setPendingAlertCount(0)
      } else {
        showToast(data.reason || 'Failed to send digest.', 'error')
      }
    } catch {
      showToast('Failed to send digest.', 'error')
    }
  }

  useEffect(() => {
    let isUnmounted = false
    let isDetected = false
    let pingAttempts = 0
    let pingTimerId = null

    const sendExtensionPing = () => {
      if (isUnmounted || isDetected || pingAttempts >= EXT_PING_MAX_ATTEMPTS) {
        if (pingTimerId) clearInterval(pingTimerId)
        return
      }
      pingAttempts += 1
      window.postMessage(
        { source: 'price-tracker-web', type: 'PT_PING_EXT' },
        window.location.origin,
      )
    }

    const handler = (event) => {
      if (event.source !== window) return
      if (event.origin !== window.location.origin) return
      if (
        event.data?.source === 'price-tracker-extension' &&
        event.data?.type === 'PT_EXT_READY'
      ) {
        isDetected = true
        if (pingTimerId) clearInterval(pingTimerId)
        setExtensionInstalled(true)
      }
    }
    window.addEventListener('message', handler)

    sendExtensionPing()
    pingTimerId = setInterval(sendExtensionPing, EXT_PING_INTERVAL_MS)

    return () => {
      isUnmounted = true
      window.removeEventListener('message', handler)
      if (pingTimerId) clearInterval(pingTimerId)
    }
  }, [])

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === 'pt_dismiss_ext_prompt') {
        setDismissedExtPrompt(event.newValue === 'true')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    console.log('[Traker] Platform detected:', platform)
  }, [platform])

  useEffect(() => {
    const SCROLL_THRESHOLD = 10
    const handleScroll = () => {
      const currentY = window.scrollY
      if (Math.abs(currentY - lastScrollY.current) < SCROLL_THRESHOLD) return
      setNavHidden(currentY > lastScrollY.current && currentY > 60)
      lastScrollY.current = currentY
    }

    lastScrollY.current = window.scrollY
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    console.log('[Traker] Extension installed:', extensionInstalled, '| dismissedExtPrompt:', dismissedExtPrompt)
  }, [extensionInstalled, dismissedExtPrompt])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (tab !== 'droplist' || !droplistRef.current) {
      setShowBackToTop(false)
      return
    }

    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 400)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => window.removeEventListener('scroll', handleScroll)
  }, [tab])

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const changeAvatar = (charName) => {
    setAvatarChar(charName)
    localStorage.setItem('pt_avatar_char', charName)
  }

  const handleLogin = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthError(data?.detail || 'Login failed.')
        return
      }
      setAuthSuccess(true)

      const isMobile = window.innerWidth <= 1024
      const celebrationDuration = isMobile ? 0 : 1600
      const exitDuration = isMobile ? 300 : 400

      setTimeout(() => {
        setLoginExiting(true)
        setTimeout(() => {
          saveAuth(data.access_token, loginEmail)
          dismissToast()
          setAuthSuccess(false)
          setLoginExiting(false)
        }, exitDuration)
      }, celebrationDuration)
      setLoginPassword('')
      setAuthError('')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleRegister = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthError(data?.detail || 'Registration failed.')
        return
      }
      setAuthView('login')
      await handleLogin()
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }

  const extractUiChangedError = (payload) => {
    if (!payload) return false
    if (payload?.error_code === 'UI_CHANGED') return true
    if (payload?.detail?.error_code === 'UI_CHANGED') return true
    if (typeof payload?.error === 'string' && payload.error.includes('UI_CHANGED')) return true
    if (typeof payload?.detail?.error === 'string' && payload.detail.error.includes('UI_CHANGED')) return true
    return false
  }

  const fetchTrackedProducts = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/tracked-products`)
      if (!res.ok) return
      const backendProducts = await res.json()

      setProducts((prevProducts) => {
        const localByUrl = {}
        for (const p of prevProducts) localByUrl[p.url] = p
        const backendUrlSet = new Set(backendProducts.map((bp) => bp.url))

        const merged = backendProducts.map((bp) => {
          const local = localByUrl[bp.url]
          const currencyCode = normalizeCurrencyCode(bp.currency_code || local?.currencyCode)
          return {
            id: local?.id || createId(),
            url: bp.url,
            name: bp.product_name || local?.name || 'Tracked Product',
            siteName: bp.site_name || local?.siteName || '',
            threshold: bp.threshold ?? local?.threshold ?? '',
            frequency: normalizeFrequency(bp.frequency || local?.frequency),
            lastPrice: bp.current_price ?? local?.lastPrice ?? null,
            displayPrice:
              bp.display_price ||
              (bp.current_price != null ? formatPrice(bp.current_price, currencyCode) : local?.displayPrice || ''),
            originalPrice: bp.original_price ?? local?.originalPrice ?? null,
            displayOriginalPrice:
              bp.original_price != null
                ? formatPrice(bp.original_price, currencyCode)
                : local?.displayOriginalPrice || '',
            currencyCode,
            lastChecked: bp.last_checked || local?.lastChecked || '',
            custom_selector: bp.custom_selector || local?.custom_selector || '',
            originalSelector: bp.original_price_selector ?? local?.originalSelector ?? '',
            ui_changed: bp.ui_changed || false,
            scraper_available: bp.scraper_available !== false,
            backendId: bp.id,
            pendingSync: false,
          }
        })

        // Register only unsynced local products with backend.
        // Synced entries missing from backend are treated as remotely deleted.
        for (const p of prevProducts) {
          if (!backendUrlSet.has(p.url) && p.pendingSync) {
            merged.push(p)
            authFetch(`${API}/tracked-products`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: p.url,
                product_name: p.name || 'Unknown Product',
                site_name: p.siteName || null,
                custom_selector: p.custom_selector,
                current_price: p.lastPrice,
                original_price: p.originalPrice,
                original_price_selector: p.originalSelector || null,
                currency_code: p.currencyCode || DEFAULT_CURRENCY_CODE,
                threshold: p.threshold !== '' ? Number(p.threshold) : null,
                frequency: normalizeFrequency(p.frequency),
              }),
            })
              .then((r) => r.json())
              .then((data) => {
                if (data?.id) {
                  setProducts((current) =>
                    current.map((item) =>
                      item.id === p.id ? { ...item, backendId: data.id, pendingSync: false } : item,
                    ),
                  )
                }
              })
              .catch(() => {})
          }
        }

        return merged
      })
      fetchPendingAlertCount()
    } catch (err) {
      console.warn('Failed to sync with backend:', err)
    }
  }, [authFetch, fetchPendingAlertCount])

  useEffect(() => {
    if (!isLoggedIn) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setProducts(
            parsed.map((p) => {
              const currencyCode = normalizeCurrencyCode(p.currencyCode)
              return {
                ...p,
                siteName: p.siteName || '',
                frequency: normalizeFrequency(p.frequency),
                originalPrice: p.originalPrice != null ? Number(p.originalPrice) : null,
                originalSelector: p.originalSelector || '',
                currencyCode,
                displayPrice:
                  p.displayPrice ||
                  (p.lastPrice != null ? formatPrice(Number(p.lastPrice), currencyCode) : ''),
                displayOriginalPrice:
                  p.displayOriginalPrice ||
                  (p.originalPrice != null ? formatPrice(Number(p.originalPrice), currencyCode) : ''),
              }
            }),
          )
        }
      }
    } catch {
      setProducts([])
    }
    fetchTrackedProducts()
    fetchEmailSettings()
    fetchPendingAlertCount()
  }, [authToken, isLoggedIn, fetchTrackedProducts, fetchEmailSettings, fetchPendingAlertCount])

  useEffect(() => {
    if (!isLoggedIn) return
    const syncOnFocus = () => fetchTrackedProducts()
    const intervalId = setInterval(syncOnFocus, 10000)
    window.addEventListener('focus', syncOnFocus)
    return () => {
      clearInterval(intervalId)
      window.removeEventListener('focus', syncOnFocus)
    }
  }, [authToken, isLoggedIn, fetchTrackedProducts])

  useEffect(() => {
    if (!isLoggedIn) return

    const onMessage = (event) => {
      if (event.source !== window) return
      if (event.origin !== window.location.origin) return

      const msg = event.data
      if (
        msg?.source !== 'price-tracker-extension' ||
        msg?.type !== 'PT_TRACKED_PRODUCTS_SYNCED'
      ) {
        return
      }

      const extensionEmail = normalizeEmail(msg.payload?.extensionEmail)
      const pageEmail = normalizeEmail(authEmail)
      if (extensionEmail && pageEmail && extensionEmail !== pageEmail) {
        showToast(
          `Extension is logged in as ${extensionEmail}, but this page is logged in as ${pageEmail}. Log into the same account in the extension to sync products here.`,
          'error',
        )
        return
      }

      fetchTrackedProducts()
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [authEmail, fetchTrackedProducts, isLoggedIn, showToast])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(products))
  }, [products])

  const trackedCount = products.length
  const belowThresholdCount = useMemo(
    () =>
      products.filter(
        (p) => p.lastPrice != null && p.threshold !== '' && Number(p.lastPrice) <= Number(p.threshold),
      ).length,
    [products],
  )
  const sortedProducts = useMemo(() => {
    if (sortBy === 'default') return products

    const sorted = [...products]

    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'name-asc': {
          const nameA = (a.name || '').toLowerCase()
          const nameB = (b.name || '').toLowerCase()
          return nameA.localeCompare(nameB)
        }
        case 'name-desc': {
          const nameA = (a.name || '').toLowerCase()
          const nameB = (b.name || '').toLowerCase()
          return nameB.localeCompare(nameA)
        }
        case 'site-asc': {
          const siteA = (a.siteName || getWebsiteNameFallback(a.url)).toLowerCase()
          const siteB = (b.siteName || getWebsiteNameFallback(b.url)).toLowerCase()
          return siteA.localeCompare(siteB)
        }
        case 'site-desc': {
          const siteA = (a.siteName || getWebsiteNameFallback(a.url)).toLowerCase()
          const siteB = (b.siteName || getWebsiteNameFallback(b.url)).toLowerCase()
          return siteB.localeCompare(siteA)
        }
        case 'price-asc': {
          const priceA = a.lastPrice ?? Infinity
          const priceB = b.lastPrice ?? Infinity
          return priceA - priceB
        }
        case 'price-desc': {
          const priceA = a.lastPrice ?? -Infinity
          const priceB = b.lastPrice ?? -Infinity
          return priceB - priceA
        }
        default:
          return 0
      }
    })

    return sorted
  }, [products, sortBy])

  const requestExtensionVisualPick = (targetUrl, pickThreshold, pickFrequency) =>
    new Promise((resolve, reject) => {
      const requestId = createId()
      let accepted = false
      let started = false
      let ackTimeoutId = null
      let startupTimeoutId = null
      let completionTimeoutId = null

      const cleanup = () => {
        window.removeEventListener('message', onMessage)
        if (ackTimeoutId) clearTimeout(ackTimeoutId)
        if (startupTimeoutId) clearTimeout(startupTimeoutId)
        if (completionTimeoutId) clearTimeout(completionTimeoutId)
      }

      const fail = (nextMessage) => {
        cleanup()
        reject(new Error(nextMessage))
      }

      const armStartupTimeout = () => {
        if (startupTimeoutId) clearTimeout(startupTimeoutId)
        startupTimeoutId = setTimeout(() => {
          if (started) return
          fail('Extension accepted the picker request, but startup is taking too long. The product page may be slow or blocked; please try again.')
        }, PICK_START_TIMEOUT_MS)
      }

      const armCompletionTimeout = () => {
        if (completionTimeoutId) clearTimeout(completionTimeoutId)
        completionTimeoutId = setTimeout(() => {
          fail('Timed out waiting for price selection.')
        }, PICK_COMPLETION_TIMEOUT_MS)
      }

      const onMessage = (event) => {
        if (event.source !== window) return
        if (event.origin !== window.location.origin) return
        const msg = event.data
        if (!msg || msg.source !== 'price-tracker-extension' || msg.requestId !== requestId) return

        if (msg.type === 'PT_PICK_ACCEPTED') {
          accepted = true
          if (ackTimeoutId) clearTimeout(ackTimeoutId)
          showToast(
            msg.alreadyInFlight
              ? 'Picker request already in progress. Waiting for product page...'
              : 'Extension accepted request. Opening product page...',
            'neutral',
          )
          armStartupTimeout()
          return
        }

        if (msg.type === 'PT_PICK_STARTED') {
          accepted = true
          started = true
          if (ackTimeoutId) clearTimeout(ackTimeoutId)
          if (startupTimeoutId) clearTimeout(startupTimeoutId)
          showToast('Extension picker opened. Click the price element on the product page, then press Save.', 'neutral')
          armCompletionTimeout()
          return
        }

        if (msg.type === 'PT_PICK_RESULT') {
          cleanup()
          resolve(msg.payload || {})
          return
        }

        if (msg.type === 'PT_PICK_ERROR') {
          fail(msg.error || 'Extension picker failed.')
        }
      }

      ackTimeoutId = setTimeout(() => {
        if (accepted) return
        fail('Extension bridge not reachable. Set extension Site access to "On all sites", then reload extension and refresh this page.')
      }, PICK_ACK_TIMEOUT_MS)

      window.addEventListener('message', onMessage)
      window.postMessage(
        {
          source: 'price-tracker-web',
          type: 'PT_START_PICK',
          requestId,
          payload: {
            url: targetUrl,
            threshold: pickThreshold,
            frequency: pickFrequency,
          },
        },
        window.location.origin,
      )
    })

  const dismissExtensionPrompt = () => {
    if (dontShowExtPromptAgain) {
      localStorage.setItem('pt_dismiss_ext_prompt', 'true')
      setDismissedExtPrompt(true)
    }
    setShowExtPrompt(false)
    setPendingProduct(null)
  }

  const addProductViaExtension = async (trimmedUrl, parsedThreshold) => {
    if (!isLoggedIn) {
      showToast('Please log in to use the extension visual picker.', 'error')
      return
    }

    setLoadingId('adding')
    showToast('Starting extension picker...', 'neutral')

    try {
      const pickData = await requestExtensionVisualPick(trimmedUrl, parsedThreshold, frequency)
      const pickedSelector = getExtensionPickedSelector(pickData)
      const pickedPrice = getExtensionPickedPrice(pickData)
      const pickedOriginalSelector = getOriginalSelector(pickData)
      const pickedOriginalPrice = pickData?.original_price != null ? Number(pickData.original_price) : null
      if (!pickedSelector) {
        showToast('Please complete the extension price selection before adding to droplist.', 'error')
        setLoadingId('')
        return
      }

      const finalThreshold = pickData.threshold != null ? pickData.threshold : parsedThreshold
      const finalFrequency = normalizeFrequency(pickData.frequency || frequency)
      const finalUrl = pickData.url || trimmedUrl
      const currencyCode = normalizeCurrencyCode(pickData.currency_code || DEFAULT_CURRENCY_CODE)

      const priceHint =
        pickedPrice != null ? ` Found: ${formatPrice(pickedPrice, currencyCode)}` : ''
      showToast(`Selector captured!${priceHint} Adding to list...`, 'success')

      const newProduct = {
        id: createId(),
        url: finalUrl,
        name: pickData.name || '',
        siteName: pickData.site_name || '',
        threshold: finalThreshold,
        frequency: finalFrequency,
        lastPrice: pickedPrice,
        displayPrice: pickedPrice != null ? formatPrice(pickedPrice, currencyCode) : '',
        originalPrice: pickedOriginalPrice,
        displayOriginalPrice:
          pickedOriginalPrice != null ? formatPrice(pickedOriginalPrice, currencyCode) : '',
        currencyCode,
        lastChecked: pickedPrice != null || pickedOriginalPrice != null ? new Date().toISOString() : '',
        custom_selector: pickedSelector,
        originalSelector: pickedOriginalSelector,
        ui_changed: false,
        pendingSync: true,
      }

      setProducts((prev) => [newProduct, ...prev])
      authFetch(`${API}/tracked-products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: finalUrl,
          product_name: newProduct.name || 'Unknown Product',
          site_name: newProduct.siteName || null,
          custom_selector: pickedSelector,
          current_price: newProduct.lastPrice,
          original_price: pickedOriginalPrice,
          original_price_selector: pickedOriginalSelector || null,
          currency_code: currencyCode,
          threshold: finalThreshold !== '' && finalThreshold != null ? Number(finalThreshold) : null,
          frequency: finalFrequency,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.id) {
            setProducts((prev) =>
              prev.map((p) => (p.id === newProduct.id ? { ...p, backendId: data.id, pendingSync: false } : p)),
            )
          }
        })
        .catch(() => {})

      setUrl('')
      setThreshold('')
      setFrequency(DEFAULT_FREQUENCY)
      setTab('droplist')
      setLoadingId('')
      showToast('Product added from extension picker.', 'success')
    } catch (err) {
      console.error(err)
      showToast(err?.message || 'Failed to start extension picker.', 'error')
      setLoadingId('')
    }
  }

  const addProductViaBackend = async (trimmedUrl, parsedThreshold, selectedFrequency) => {
    const normalizedFrequency = normalizeFrequency(selectedFrequency)
    const localProductId = createId()

    setLoadingId('adding')
    showToast('Adding product and starting automatic price detection...', 'neutral')

    try {
      const trackedRes = await authFetch(`${API}/tracked-products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: trimmedUrl,
          threshold: parsedThreshold !== '' ? Number(parsedThreshold) : null,
          frequency: normalizedFrequency,
        }),
      })
      const trackedData = await trackedRes.json().catch(() => ({}))
      if (!trackedRes.ok) {
        throw new Error(trackedData?.detail || trackedData?.error || 'Failed to add product to droplist.')
      }

      const newProduct = {
        id: localProductId,
        url: trimmedUrl,
        name: 'Tracked Product',
        siteName: '',
        threshold: parsedThreshold,
        frequency: normalizedFrequency,
        lastPrice: null,
        displayPrice: '',
        originalPrice: null,
        displayOriginalPrice: '',
        currencyCode: DEFAULT_CURRENCY_CODE,
        lastChecked: '',
        custom_selector: '',
        originalSelector: '',
        ui_changed: false,
        backendId: trackedData?.id,
        pendingSync: false,
      }
      setProducts((prev) => [newProduct, ...prev])
      setTab('droplist')

      const { status, data } = await scrapeWithPolling(
        API,
        { url: trimmedUrl },
        {
          onPending: () => {
            showToast('Checking price... This may take a few seconds.', 'neutral')
          },
          headers: authHeaders(),
        },
      )

      if (status === 409 && extractUiChangedError(data)) {
        setProducts((prev) =>
          prev.map((p) => (p.id === localProductId ? { ...p, ui_changed: true } : p)),
        )
        showToast(data?.detail?.error || data?.error || 'Website layout changed. Try again later.', 'error')
      } else if (data?.price != null) {
        const nextCurrencyCode = normalizeCurrencyCode(data.currency_code || DEFAULT_CURRENCY_CODE)
        setProducts((prev) =>
          prev.map((p) =>
            p.id === localProductId
              ? {
                  ...p,
                  originalPrice: data.original_price != null ? Number(data.original_price) : p.originalPrice ?? null,
                  displayOriginalPrice:
                    data.original_price != null
                      ? formatPrice(Number(data.original_price), nextCurrencyCode)
                      : p.displayOriginalPrice || '',
                  originalSelector: getOriginalSelector(data, p.originalSelector),
                  name: data.name || p.name || 'Tracked Product',
                  siteName: data.site_name || p.siteName || '',
                  lastPrice: Number(data.price),
                  displayPrice: data.display_price || formatPrice(Number(data.price), nextCurrencyCode),
                  currencyCode: nextCurrencyCode,
                  lastChecked: new Date().toISOString(),
                  custom_selector: data.custom_selector || p.custom_selector,
                  ui_changed: false,
                }
              : p,
            ),
        )
        showToast('Product added. Latest price fetched via automatic detection.', 'success')
      } else {
        showToast(data?.error || 'Product added. Price check is still in progress.', 'neutral')
      }

      setUrl('')
      setThreshold('')
      setFrequency(DEFAULT_FREQUENCY)
    } catch (err) {
      console.error(err)
      showToast(err?.message || 'Failed to add product via automatic detection.', 'error')
    } finally {
      setLoadingId('')
    }
  }

  const handleSkipExtensionPrompt = async () => {
    const pending = pendingProduct
    dismissExtensionPrompt()
    if (!pending?.url) return
    await addProductViaBackend(pending.url, pending.threshold, pending.frequency)
  }

  const handleGetExtension = () => {
    window.open('https://chrome.google.com/webstore/detail/traker/YOUR_ID', '_blank', 'noopener,noreferrer')
    dismissExtensionPrompt()
  }

  const addProduct = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setHomeFormErrors((prev) => ({ ...prev, url: true }))
      showToast('Please enter a product URL.', 'error')
      return
    }
    setHomeFormErrors((prev) => ({ ...prev, url: false }))

    const parsedThreshold = threshold === '' ? '' : Number(threshold)
    if (parsedThreshold !== '' && Number.isNaN(parsedThreshold)) {
      setHomeFormErrors((prev) => ({ ...prev, threshold: true }))
      showToast('Threshold must be a valid number.', 'error')
      return
    }
    setHomeFormErrors((prev) => ({ ...prev, threshold: false }))

    // Check for duplicate - local first (instant), then backend (canonical match)
    const localDupe = findLocalDuplicate(products, trimmedUrl)
    if (localDupe) {
      showToast(
        `You're already tracking "${localDupe.name || 'this product'}". Check your Droplist.`,
        'error',
      )
      setTab('droplist')
      return
    }

    if (isLoggedIn) {
      const backendDupe = await checkDuplicateUrl(API, trimmedUrl, authHeaders())
      if (backendDupe) {
        const dupeName = backendDupe.product_name || 'this product'
        const dupePrice = backendDupe.display_price ? ` (${backendDupe.display_price})` : ''
        showToast(
          `You're already tracking "${dupeName}"${dupePrice}. Check your Droplist.`,
          'error',
        )
        setTab('droplist')
        return
      }
    }

    const detectedPlatform = getPlatform()

    if (detectedPlatform === 'chrome-desktop' && extensionInstalled) {
      await addProductViaExtension(trimmedUrl, parsedThreshold)
      return
    }

    if (detectedPlatform === 'chrome-desktop' && !extensionInstalled && !dismissedExtPrompt) {
      setDontShowExtPromptAgain(false)
      setPendingProduct({ url: trimmedUrl, threshold: parsedThreshold, frequency })
      setShowExtPrompt(true)
      return
    }

    await addProductViaBackend(trimmedUrl, parsedThreshold, frequency)
  }

  const redoVisualPick = async (product) => {
    setLoadingId(product.id)
    showToast('Opening browser! Please click the new price location...', 'neutral')

    try {
      const pickData = await requestExtensionVisualPick(product.url, product.threshold, product.frequency)
      const pickedSelector = getExtensionPickedSelector(pickData)
      const pickedPrice = getExtensionPickedPrice(pickData)
      const nextOriginalSelector = getOriginalSelector(pickData, product.originalSelector)
      const nextOriginalPrice =
        pickData?.original_price != null ? Number(pickData.original_price) : product.originalPrice ?? null
      if (pickedSelector) {
        const patch = {
          custom_selector: pickedSelector,
          originalSelector: nextOriginalSelector,
          originalPrice: nextOriginalPrice,
          siteName: pickData.site_name || product.siteName || '',
          displayOriginalPrice:
            nextOriginalPrice != null
              ? formatPrice(nextOriginalPrice, product.currencyCode)
              : product.displayOriginalPrice || '',
          threshold: pickData.threshold != null ? pickData.threshold : product.threshold,
          frequency: normalizeFrequency(pickData.frequency || product.frequency),
          ui_changed: false,
        }
        if (pickData.currency_code) {
          patch.currencyCode = normalizeCurrencyCode(pickData.currency_code)
          if (nextOriginalPrice != null) {
            patch.displayOriginalPrice = formatPrice(nextOriginalPrice, patch.currencyCode)
          }
        }
        if (pickedPrice != null) {
          patch.lastPrice = pickedPrice
          patch.displayPrice = formatPrice(pickedPrice, patch.currencyCode || product.currencyCode)
          patch.lastChecked = new Date().toISOString()
        }
        updateProduct(product.id, patch)

        // Persist selector changes from the web app side too.
        // The extension already does this, but this avoids stale ui_changed flags if that request fails.
        const syncPayload = {
          url: product.url,
          product_name: pickData.name || product.name || 'Unknown Product',
          site_name: pickData.site_name || product.siteName || null,
          custom_selector: pickedSelector,
          original_price_selector: nextOriginalSelector || null,
          threshold: patch.threshold !== '' && patch.threshold != null ? Number(patch.threshold) : null,
          frequency: normalizeFrequency(patch.frequency || product.frequency),
          currency_code: normalizeCurrencyCode(patch.currencyCode || product.currencyCode),
        }
        if (pickedPrice != null) syncPayload.current_price = pickedPrice
        if (nextOriginalPrice != null) syncPayload.original_price = nextOriginalPrice
        authFetch(`${API}/tracked-products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(syncPayload),
        }).catch(() => {})

        const priceHint =
          pickedPrice != null
            ? ` Found: ${formatPrice(pickedPrice, patch.currencyCode || product.currencyCode)}`
            : ''
        showToast(`New selector saved!${priceHint} Use Manual Price Check when you want to verify now.`, 'success')
      } else {
        showToast('Visual pick failed or was closed.', 'error')
      }
    } catch (err) {
      console.error(err)
      showToast(err?.message || 'Failed to start extension picker.', 'error')
    } finally {
      setLoadingId('')
    }
  }

  const removeProduct = (id) => {
    const product = products.find((p) => p.id === id)
    setProducts((prev) => prev.filter((p) => p.id !== id))
    showToast('Product removed.', 'neutral')
    if (product) {
      if (product.backendId) {
        authFetch(`${API}/tracked-products/${product.backendId}`, { method: 'DELETE' }).catch(() => {})
      } else {
        authFetch(`${API}/tracked-products/by-url/delete?url=${encodeURIComponent(product.url)}`, {
          method: 'DELETE',
        }).catch(() => {})
      }
    }
  }

  const updateProduct = (id, patch) => {
    setProducts((prev) => {
      const updated = prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
      const product = updated.find((p) => p.id === id)
      if (product && (patch.threshold !== undefined || patch.frequency !== undefined)) {
        authFetch(`${API}/tracked-products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: product.url,
            threshold: product.threshold !== '' ? Number(product.threshold) : null,
            frequency: normalizeFrequency(product.frequency),
          }),
        }).catch(() => {})
      }
      return updated
    })
  }

  const checkProductNow = async (product) => {
    if (scrapingUrls.has(product.url)) {
      showToast('Price is still being checked', 'info')
      return
    }

    setScrapingUrls((prev) => new Set(prev).add(product.url))
    showToast('Checking price...', 'neutral')
    let shouldClearScrapingUrl = true

    try {
      const { status, data } = await scrapeWithPolling(
        API,
        {
          url: product.url,
          custom_selector: product.custom_selector,
          original_price_selector: product.originalSelector || null,
        },
        {
          onPending: () => {
            showToast('Extension job queued. Waiting for extension result...', 'neutral')
          },
          headers: authHeaders(),
        },
      )

      if (data?.status === 'pending') {
        shouldClearScrapingUrl = false
        setTimeout(() => {
          setScrapingUrls((prev) => {
            const next = new Set(prev)
            next.delete(product.url)
            return next
          })
        }, 60000)
      }

      if (status === 409 && extractUiChangedError(data)) {
        updateProduct(product.id, { ui_changed: true })
        showToast(data?.detail?.error || data?.error || 'UI layout changed. Please redo price capture.', 'error')
        return
      }

      if (data?.price != null) {
        const nextCurrencyCode = normalizeCurrencyCode(data.currency_code || product.currencyCode)
        setProducts((prev) =>
          prev.map((p) =>
            p.id === product.id
              ? {
                  ...p,
                  originalPrice: data.original_price != null ? Number(data.original_price) : p.originalPrice ?? null,
                  displayOriginalPrice:
                    data.original_price != null
                      ? formatPrice(Number(data.original_price), nextCurrencyCode)
                      : p.displayOriginalPrice || '',
                  originalSelector: getOriginalSelector(data, p.originalSelector),
                  name: data.name || p.name,
                  siteName: data.site_name || p.siteName || '',
                  lastPrice: Number(data.price),
                  displayPrice: data.display_price || formatPrice(Number(data.price), nextCurrencyCode),
                  currencyCode: nextCurrencyCode,
                  lastChecked: new Date().toISOString(),
                  custom_selector: data.custom_selector || p.custom_selector,
                  ui_changed: false,
                }
              : p,
          ),
        )
        authFetch(`${API}/tracked-products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: product.url,
            product_name: data.name || product.name,
            site_name: data.site_name || product.siteName || null,
            current_price: Number(data.price),
            original_price: data.original_price != null ? Number(data.original_price) : product.originalPrice ?? null,
            currency_code: nextCurrencyCode,
            custom_selector: data.custom_selector || product.custom_selector,
            original_price_selector: getOriginalSelector(data, product.originalSelector) || null,
          }),
        }).catch(() => {})
        fetchProductHistory(product.url, true)
        fetchPendingAlertCount()
        showToast('Price updated.', 'success')
      } else {
        showToast(data?.error || 'Could not fetch price.', 'error')
      }
    } catch {
      showToast('Backend connection failed.', 'error')
    } finally {
      if (shouldClearScrapingUrl) {
        setScrapingUrls((prev) => {
          const next = new Set(prev)
          next.delete(product.url)
          return next
        })
      }
    }
  }

  const toggleHistory = (id) => {
    const product = products.find((p) => p.id === id)
    if (!product) return

    setExpandedHistory((prev) => {
      const nextOpen = !prev[id]
      if (nextOpen) {
        fetchProductHistory(product.url, true)
      }
      return { ...prev, [id]: nextOpen }
    })
  }

  const fetchProductHistory = async (productUrl, force = false) => {
    if (!force && historyByUrl[productUrl]) return
    setHistoryLoadingByUrl((prev) => ({ ...prev, [productUrl]: true }))
    try {
      const res = await authFetch(
        `${API}/history/by-url?url=${encodeURIComponent(productUrl)}&limit=5000&days=120`,
      )
      const data = await res.json()
      setHistoryByUrl((prev) => ({ ...prev, [productUrl]: Array.isArray(data) ? data : [] }))
    } catch {
      setHistoryByUrl((prev) => ({ ...prev, [productUrl]: [] }))
    } finally {
      setHistoryLoadingByUrl((prev) => ({ ...prev, [productUrl]: false }))
    }
  }

  if (!isLoggedIn) {
    return (
      <LoginPage
        authView={authView}
        setAuthView={setAuthView}
        loginEmail={loginEmail}
        setLoginEmail={setLoginEmail}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        authError={authError}
        setAuthError={setAuthError}
        authLoading={authLoading}
        authSuccess={authSuccess}
        loginExiting={loginExiting}
        handleLogin={handleLogin}
        handleRegister={handleRegister}
      />
    )
  }

  return (
    <div className="pageBg">
      <a href="#main-content" className="skipLink">Skip to main content</a>
      <header className="topbar">
        <div className="brandWrap">
          <div className="lp-logoBox homeLogoBox">T</div>
          <h1>TRAKER</h1>
        </div>

        <div className="topbarRight">
          <nav className={`navTabs${navHidden ? ' navHidden' : ''}`} role="navigation" aria-label="Main navigation">
            <button
              className={navClass('home')}
              onClick={() => setTab('home')}
              aria-current={tab === 'home' ? 'page' : undefined}
              type="button"
            >
              Home
            </button>
            <button
              className={navClass('droplist')}
              onClick={() => setTab('droplist')}
              aria-current={tab === 'droplist' ? 'page' : undefined}
              type="button"
            >
              <span>Droplist <span className="badge">{trackedCount}</span></span>
            </button>
            <button
              className={navClass('emailSettings')}
              onClick={() => setTab('emailSettings')}
              aria-current={tab === 'emailSettings' ? 'page' : undefined}
              type="button"
            >
              <span>Email {pendingAlertCount > 0 && <span className="badge">{pendingAlertCount}</span>}</span>
            </button>
          </nav>

          {isLoggedIn && (
            <div className="profileWrap" ref={profileRef} onKeyDown={handleProfileWrapKeyDown}>
              <button
                className="profileBtn"
                onClick={() => setProfileOpen((prev) => !prev)}
                aria-label="Profile menu"
                aria-expanded={profileOpen}
                type="button"
              >
                <AnimatedProfileAvatar name={avatarChar} size={38} />
              </button>

              {profileOpen && (
                <div className="profileDropdown">
                  <div className="profileDropdownEmail">{authEmail}</div>

                  <div className="profileDropdownDivider" />

                  <div className="profileDropdownLabel">Choose Avatar</div>
                  <div className="avatarPicker">
                    {PROFILE_AVATAR_NAMES.map((charName) => (
                      <button
                        key={charName}
                        className={`avatarOption${avatarChar === charName ? ' avatarOptionActive' : ''}`}
                        onClick={() => changeAvatar(charName)}
                        aria-label={`Select ${charName} avatar`}
                        type="button"
                      >
                        <AnimatedProfileAvatar name={charName} size={36} />
                      </button>
                    ))}
                  </div>

                  <div className="profileDropdownDivider" />

                  <button
                    className="themeToggleBtn"
                    onClick={toggleTheme}
                    type="button"
                  >
                    {theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode'}
                  </button>

                  <div className="profileDropdownDivider" />

                  <button
                    className="profileDropdownDelete"
                    onClick={() => {
                      deleteAccount()
                    }}
                    type="button"
                  >
                    Delete Account
                  </button>

                  <button
                    className="profileDropdownLogout"
                    onClick={() => {
                      clearAuth()
                      setProfileOpen(false)
                    }}
                    type="button"
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="shell" id="main-content">
        <>
          {tab === 'home' && (
            <>
              <section className="statsGrid" aria-label="Tracking overview">
                <div className="card">
                  <h2 className="statsHeading">Tracking</h2>
                  <p>{trackedCount} products</p>
                </div>
                <div className="card">
                  <h2 className="statsHeading">Below Threshold</h2>
                  <p>{belowThresholdCount} products</p>
                </div>
                <div
                  className="card"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setTab('emailSettings')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setTab('emailSettings')
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <h2 className="statsHeading">Email Alerts</h2>
                  <p>{emailSettings.enabled ? `On · ${pendingAlertCount} pending` : 'Off'}</p>
                </div>
              </section>

              <section className="card addCard" aria-label="Add product form">
                <h2>Add Product by URL</h2>
                <div className="formRow">
                  <label htmlFor="product-url">Product URL</label>
                  <input
                    id="product-url"
                    className="input"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value)
                      setHomeFormErrors((prev) => ({ ...prev, url: false }))
                    }}
                    onFocus={(e) => e.target.select()}
                    placeholder="https://www.walmart.com/..."
                    aria-required="true"
                    aria-invalid={homeFormErrors.url || undefined}
                  />
                </div>

                <div className="formSplit">
                  <div className="formRow">
                    <label htmlFor="alert-threshold">Alert Threshold</label>
                    <input
                      id="alert-threshold"
                      className="input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={threshold}
                      onChange={(e) => {
                        setThreshold(e.target.value)
                        setHomeFormErrors((prev) => ({ ...prev, threshold: false }))
                      }}
                      placeholder="$ 0.00"
                      aria-invalid={homeFormErrors.threshold || undefined}
                    />
                  </div>

                  <div className="formRow">
                    <label htmlFor="check-frequency">Check Frequency</label>
                    <select
                      id="check-frequency"
                      className="input"
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value)}
                    >
                      {FREQUENCIES.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  className="primaryBtn"
                  onClick={addProduct}
                  disabled={loadingId === 'adding'}
                  aria-busy={loadingId === 'adding'}
                >
                  {loadingId === 'adding' ? 'Adding...' : 'Add to Drop List'}
                </button>
              </section>

              <section className="card stepsCard" aria-label="How it works">
                <div className="stepItem">
                  <div className="stepCircle blue">1</div>
                  <h4>Add Product URL</h4>
                  <p>Paste a product link from any online store.</p>
                </div>
                <div className="stepItem">
                  <div className="stepCircle pink">2</div>
                  <h4>Set Alert</h4>
                  <p>Choose threshold and frequency for checks.</p>
                </div>
                <div className="stepItem">
                  <div className="stepCircle green">3</div>
                  <h4>Get Notified</h4>
                  <p>We track drops and trigger your alert workflow.</p>
                </div>
              </section>
            </>
          )}

          {tab === 'droplist' && (
            <section ref={droplistRef} aria-label="Product list">
              <div className="droplistHeader">
                <div>
                  <h2 className="sectionTitle">My Droplist</h2>
                  <p className="sectionSub">Manage all your tracked products</p>
                </div>
                <div className="sortControls">
                  <label className="sortLabel" htmlFor="sort-by">Sort by</label>
                  <select
                    id="sort-by"
                    className="sortSelect"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="default">Default</option>
                    <optgroup label="Product Name">
                      <option value="name-asc">Name A → Z</option>
                      <option value="name-desc">Name Z → A</option>
                    </optgroup>
                    <optgroup label="Website">
                      <option value="site-asc">Website A → Z</option>
                      <option value="site-desc">Website Z → A</option>
                    </optgroup>
                    <optgroup label="Price">
                      <option value="price-asc">Price Low → High</option>
                      <option value="price-desc">Price High → Low</option>
                    </optgroup>
                  </select>
                </div>
              </div>

              {products.length === 0 && <div className="card">No products yet. Add one from Home.</div>}

              <div className="listWrap">
                {sortedProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    loadingId={loadingId}
                    scrapingUrls={scrapingUrls}
                    expandedHistory={expandedHistory}
                    historyByUrl={historyByUrl}
                    historyLoadingByUrl={historyLoadingByUrl}
                    onCheck={checkProductNow}
                    onRedoPick={redoVisualPick}
                    onRemove={removeProduct}
                    onUpdate={updateProduct}
                    onToggleHistory={toggleHistory}
                  />
                ))}
              </div>

              {showBackToTop && (
                <button
                  className="backToTopBtn"
                  onClick={scrollToTop}
                  aria-label="Back to top"
                  style={navHidden && typeof window !== 'undefined' && window.innerWidth < 980 ? { bottom: '1.5rem' } : undefined}
                >
                  ↑ Back to Top
                </button>
              )}
            </section>
          )}

          {tab === 'emailSettings' && (
            <section aria-label="Email alert settings">
              <div className="droplistHeader">
                <div>
                  <h2 className="sectionTitle">Email Alert Settings</h2>
                  <p className="sectionSub">Get notified when prices drop below your thresholds</p>
                </div>
              </div>

              <div className="card" style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Email Alerts</h3>
                    <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
                      Send a digest email when tracked products drop below threshold
                    </p>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={emailSettings.enabled}
                      onChange={(e) => updateEmailSettings({ enabled: e.target.checked })}
                      disabled={emailSettingsLoading}
                      style={{ width: '18px', height: '18px', accentColor: 'var(--purple)' }}
                    />
                    <span style={{ fontWeight: 600 }}>{emailSettings.enabled ? 'On' : 'Off'}</span>
                  </label>
                </div>

                <div style={{ padding: '12px', background: 'var(--bg-highlight)', borderRadius: '8px', marginBottom: '16px' }}>
                  <div style={{ fontSize: '0.85em', color: 'var(--muted)', marginBottom: '4px' }}>Primary Email (login)</div>
                  <div style={{ fontWeight: 600 }}>{emailSettings.primaryEmail || authEmail || '—'}</div>
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <label
                    htmlFor="new-recipient"
                    style={{ fontWeight: 600, fontSize: '0.85em', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}
                  >
                    Additional Recipients
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      id="new-recipient"
                      className="input"
                      type="email"
                      placeholder="another@email.com"
                      autoComplete="email"
                      value={newRecipientEmail}
                      onChange={(e) => {
                        setNewRecipientEmail(e.target.value)
                        setRecipientEmailInvalid(false)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && addRecipient()}
                      style={{ flex: 1 }}
                      aria-invalid={recipientEmailInvalid || undefined}
                    />
                    <button
                      className="primaryBtn"
                      onClick={addRecipient}
                      disabled={emailSettingsLoading}
                      style={{ whiteSpace: 'nowrap', padding: '8px 16px' }}
                      type="button"
                    >
                      Add
                    </button>
                  </div>
                </div>

                {emailSettings.recipients.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
                    {emailSettings.recipients.map((email) => (
                      <div
                        key={email}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          background: 'var(--bg-hover)',
                          borderRadius: '6px',
                          border: '1px solid var(--line)',
                        }}
                      >
                        <span style={{ fontSize: '0.9em' }}>{email}</span>
                        <button
                          onClick={() => removeRecipient(email)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--muted-lighter)',
                            cursor: 'pointer',
                            fontSize: '16px',
                            padding: '0 4px',
                          }}
                          title="Remove"
                          aria-label={`Remove ${email}`}
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {emailSettings.recipients.length === 0 && (
                  <p style={{ color: 'var(--muted-lightest)', fontSize: '0.85em', marginBottom: '16px' }}>
                    No additional recipients. Alerts will be sent to your primary email only.
                  </p>
                )}
              </div>

              {pendingAlertCount > 0 && (
                <div className="card" style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Pending Alerts</h3>
                    <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
                      {pendingAlertCount} price drop{pendingAlertCount !== 1 ? 's' : ''} not yet emailed
                    </p>
                  </div>
                    <button className="primaryBtn" onClick={sendDigestNow} style={{ padding: '8px 20px' }}>
                      Send Now
                    </button>
                  </div>
                </div>
              )}

              <div className="card">
                <h3 style={{ marginBottom: '8px' }}>How it works</h3>
                <ol style={{ paddingLeft: '20px', color: 'var(--muted)', fontSize: '0.9em', lineHeight: '1.8' }}>
                  <li>Set a price threshold on any tracked product</li>
                  <li>When a price check detects a drop below your threshold, an alert is queued</li>
                  <li>Alerts are collected and sent as a digest email to all your recipients</li>
                </ol>
              </div>
            </section>
          )}

        </>
      </main>

      <ToastNotification toast={toast} onDismiss={dismissToast} />
      <div aria-live="polite" aria-atomic="true" className="srOnly">
        {toast?.message || ''}
      </div>

      <ExtensionPromptModal
        show={showExtPrompt}
        dontShowAgain={dontShowExtPromptAgain}
        onChangeDontShowAgain={setDontShowExtPromptAgain}
        onGetExtension={handleGetExtension}
        onSkip={handleSkipExtensionPrompt}
        onDismiss={dismissExtensionPrompt}
      />
    </div>
  )
}

export default App
