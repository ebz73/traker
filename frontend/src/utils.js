// Pure utility functions shared across the app. Extracted from App.jsx in
// Phase 1 of the refactor (see frontend/.refactor-log.md). All functions in
// this module are pure / closure-free and safe to import anywhere.

import {
  CURRENCY_SYMBOLS,
  DEFAULT_CURRENCY_CODE,
  DEFAULT_FREQUENCY,
  FOCUSABLE_SELECTOR,
  FREQUENCY_VALUES,
  SCRAPE_STATUS_MAX_ATTEMPTS,
  SCRAPE_STATUS_POLL_INTERVAL_MS,
} from './constants'

export function getFocusableElements(container) {
  if (!container) return []

  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    if (!(element instanceof HTMLElement)) return false
    if (element.hidden) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    return true
  })
}

export function trapFocusWithin(event, container) {
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

export function normalizeFrequency(value) {
  return FREQUENCY_VALUES.has(value) ? value : DEFAULT_FREQUENCY
}

export function normalizeCurrencyCode(value) {
  if (!value) return DEFAULT_CURRENCY_CODE
  const normalized = String(value).trim().toUpperCase()
  if (CURRENCY_SYMBOLS[normalized]) return normalized
  return DEFAULT_CURRENCY_CODE
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getCurrencySymbol(currencyCode) {
  const code = normalizeCurrencyCode(currencyCode)
  return CURRENCY_SYMBOLS[code] || '$'
}

export function formatPrice(value, currencyCode) {
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

export function getWebsiteNameFallback(url) {
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

export function getPriceTrend(history) {
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

export function getExtensionPickedSelector(pickData) {
  // If the extension promoted an original selector to the main selector slot, it usually comes across as 'selector'
  if (pickData?.selector) return pickData.selector
  if (pickData?.custom_selector) return pickData.custom_selector

  // Failsafe in case it wasn't promoted properly
  if (pickData?.original_selector) return pickData.original_selector
  if (pickData?.original_price_selector) return pickData.original_price_selector

  return ''
}

export function getExtensionPickedPrice(pickData) {
  if (pickData?.price != null) return Number(pickData.price)
  if (pickData?.validated_price != null) return Number(pickData.validated_price)
  return null
}

export function getOriginalSelector(payload, fallback = '') {
  return payload?.original_selector || payload?.original_price_selector || fallback || ''
}

export function formatChartDay(timestamp, includeTime = false) {
  const options = includeTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(undefined, options).format(new Date(timestamp))
}

export function niceNum(range, shouldRound) {
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

export function niceScale(minVal, maxVal, maxTicks = 5) {
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

export function formatAxisTick(value, currencyCode, tickSpacing) {
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

export function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function getPlatform() {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'chrome-desktop'
  return 'other-desktop'
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function scrapeWithPolling(apiBaseUrl, payload, options = {}) {
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

export async function checkDuplicateUrl(apiBaseUrl, url, headers = {}) {
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

export function findLocalDuplicate(products, url) {
  const trimmed = url.trim().toLowerCase().replace(/\/+$/, '')
  return products.find((p) => {
    const existing = (p.url || '').trim().toLowerCase().replace(/\/+$/, '')
    return existing === trimmed
  })
}

export function buildSmoothPath(points) {
  if (points.length === 0) return ''
  if (points.length === 1) return ''
  let d = `M ${points[0].x} ${points[0].y}`

  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${points[i].x} ${points[i].y}`
  }

  return d
}

// Deterministic pseudo-random based on Math.sin(seed). Used by confetti
// generators in LoginPage (login celebration) and ToastNotification
// (success toast). Both consumers had identical local copies before Phase 1.
export function pseudoRandom(seed) {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}
