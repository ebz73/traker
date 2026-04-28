import { useMemo, useState } from 'react'
import { EMPTY_HISTORY, FREQUENCIES, HISTORY_WINDOWS } from '../constants'
import { getPriceTrend, getWebsiteNameFallback, normalizeFrequency } from '../utils'
import ChartErrorBoundary from './ChartErrorBoundary'
import ConfirmDialog from './ConfirmDialog'
import PriceHistoryChart from './PriceHistoryChart'
import PriceHistoryChartSkeleton from './PriceHistoryChartSkeleton'

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
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
            onClick={() => setShowDeleteConfirm(true)}
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

      <button className="historyToggle" onClick={() => onToggleHistory(product)}>
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

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={`Remove "${product.name || 'this product'}" from your droplist?`}
        description="This will stop tracking the product and remove its price history."
        confirmText="Remove"
        cancelText="Cancel"
        destructive
        onConfirm={() => onRemove(product.id)}
      />
    </article>
  )
}

export default ProductCard
