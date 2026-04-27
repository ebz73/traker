import { useCallback, useEffect } from 'react'
import { API, DEFAULT_CURRENCY_CODE, STORAGE_KEY } from '../constants'
import {
  createId,
  formatPrice,
  normalizeCurrencyCode,
  normalizeEmail,
  normalizeFrequency,
} from '../utils'
import { useAuth } from './useAuth'
import { useToast } from './useToast'

// Pure side-effect hook: orchestrates load / refresh / persist effects on the
// products list owned by useProducts. Receives state + setter as args so that
// useProducts remains the sole owner of products; this hook only wires up the
// effects that read/write that state.
//
// Effects:
//   - Load from localStorage + backend on login
//   - Periodic + window-focus re-sync (every 10s + on focus)
//   - Extension sync message listener (PT_TRACKED_PRODUCTS_SYNCED)
//   - Persist products to localStorage on change
export function useProductsSync({ products, setProducts, fetchEmailSettings, fetchPendingAlertCount }) {
  const { authToken, authEmail, authFetch } = useAuth()
  const { showToast } = useToast()
  const isLoggedIn = Boolean(authToken)

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
  }, [authFetch, fetchPendingAlertCount, setProducts])

  // Initial load on login: hydrate from localStorage, then sync with backend.
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
  }, [authToken, isLoggedIn, fetchTrackedProducts, fetchEmailSettings, fetchPendingAlertCount, setProducts])

  // Periodic re-sync (10s) + window-focus re-sync.
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

  // Extension sync notification: refetch when the extension reports a change.
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

  // Persist products to localStorage on change.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(products))
  }, [products])

  return { fetchTrackedProducts }
}
