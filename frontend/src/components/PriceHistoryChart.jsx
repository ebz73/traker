import { useId, useMemo, useState } from 'react'
import { DAY_IN_MS } from '../constants'
import {
  buildSmoothPath,
  formatAxisTick,
  formatChartDay,
  formatPrice,
  niceScale,
  normalizeCurrencyCode,
} from '../utils'

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

export default PriceHistoryChart
