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

export default PriceHistoryChartSkeleton
