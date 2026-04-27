import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API, DEFAULT_CURRENCY_CODE } from '../constants'
import {
  checkDuplicateUrl,
  createId,
  findLocalDuplicate,
  formatPrice,
  getExtensionPickedPrice,
  getExtensionPickedSelector,
  getOriginalSelector,
  getPlatform,
  getWebsiteNameFallback,
  normalizeCurrencyCode,
  normalizeFrequency,
  scrapeWithPolling,
} from '../utils'
import { useAuth } from './useAuth'
import { useToast } from './useToast'

const extractUiChangedError = (payload) => {
  if (!payload) return false
  if (payload?.error_code === 'UI_CHANGED') return true
  if (payload?.detail?.error_code === 'UI_CHANGED') return true
  if (typeof payload?.error === 'string' && payload.error.includes('UI_CHANGED')) return true
  if (typeof payload?.detail?.error === 'string' && payload.detail.error.includes('UI_CHANGED')) return true
  return false
}

// Stateful single-use hook: call once at the app root and pass values down.
// Owns products list + mutators. Consumes other domain hooks via parameters
// (rather than calling them internally) because they are also stateful
// single-use hooks — calling them inside would yield independent state
// disconnected from AppShell's instances.
//
// Returns:
//   - products, setProducts, loadingId, scrapingUrls
//   - addProduct(payload), addProductViaExtension, addProductViaBackend
//   - handleSkipExtensionPrompt
//   - redoVisualPick, removeProduct, updateProduct, checkProductNow
//   - trackedCount, belowThresholdCount, getSortedProducts(sortBy)
//
// addProduct / handleSkipExtensionPrompt return { ok: boolean } so the caller
// can decide whether to reset the add-product form (Phase 4 design decision #1).
export function useProducts({ ext, email, history, setTab }) {
  const { authToken, authFetch, authHeaders } = useAuth()
  const { showToast } = useToast()
  const isLoggedIn = Boolean(authToken)

  const [products, setProducts] = useState([])
  const [loadingId, setLoadingId] = useState('')
  const [scrapingUrls, setScrapingUrls] = useState(new Set())

  // Per-hook logout cleanup: reset products state when auth flips truthy → falsy.
  // Indirected through resetOnLogout() to satisfy react-hooks/set-state-in-effect.
  const prevAuthTokenRef = useRef(authToken)
  useEffect(() => {
    const resetOnLogout = () => {
      setProducts([])
      setLoadingId('')
      setScrapingUrls(new Set())
    }
    const wasLoggedIn = Boolean(prevAuthTokenRef.current)
    const isNowLoggedIn = Boolean(authToken)
    if (wasLoggedIn && !isNowLoggedIn) {
      resetOnLogout()
    }
    prevAuthTokenRef.current = authToken
  }, [authToken])

  const updateProduct = useCallback(
    (id, patch) => {
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
    },
    [authFetch],
  )

  const removeProduct = useCallback(
    (id) => {
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
    },
    [authFetch, products, showToast],
  )

  const addProductViaExtension = useCallback(
    async (trimmedUrl, parsedThreshold, selectedFrequency) => {
      if (!isLoggedIn) {
        showToast('Please log in to use the extension visual picker.', 'error')
        return { ok: false }
      }

      setLoadingId('adding')
      showToast('Starting extension picker...', 'neutral')

      try {
        const pickData = await ext.requestExtensionVisualPick(trimmedUrl, parsedThreshold, selectedFrequency)
        const pickedSelector = getExtensionPickedSelector(pickData)
        const pickedPrice = getExtensionPickedPrice(pickData)
        const pickedOriginalSelector = getOriginalSelector(pickData)
        const pickedOriginalPrice = pickData?.original_price != null ? Number(pickData.original_price) : null
        if (!pickedSelector) {
          showToast('Please complete the extension price selection before adding to droplist.', 'error')
          setLoadingId('')
          return { ok: false }
        }

        const finalThreshold = pickData.threshold != null ? pickData.threshold : parsedThreshold
        const finalFrequency = normalizeFrequency(pickData.frequency || selectedFrequency)
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

        setTab('droplist')
        setLoadingId('')
        showToast('Product added from extension picker.', 'success')
        return { ok: true }
      } catch (err) {
        console.error(err)
        showToast(err?.message || 'Failed to start extension picker.', 'error')
        setLoadingId('')
        return { ok: false }
      }
    },
    [authFetch, ext, isLoggedIn, setTab, showToast],
  )

  const addProductViaBackend = useCallback(
    async (trimmedUrl, parsedThreshold, selectedFrequency) => {
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

        setLoadingId('')
        return { ok: true }
      } catch (err) {
        console.error(err)
        showToast(err?.message || 'Failed to add product via automatic detection.', 'error')
        setLoadingId('')
        return { ok: false }
      }
    },
    [authFetch, authHeaders, setTab, showToast],
  )

  const handleSkipExtensionPrompt = useCallback(async () => {
    const pending = ext.pendingProduct
    ext.dismissExtensionPrompt()
    if (!pending?.url) return { ok: false }
    return addProductViaBackend(pending.url, pending.threshold, pending.frequency)
  }, [addProductViaBackend, ext])

  const addProduct = useCallback(
    async ({ url: trimmedUrl, threshold: parsedThreshold, frequency: selectedFrequency }) => {
      // Check duplicate - local first (instant), then backend (canonical match)
      const localDupe = findLocalDuplicate(products, trimmedUrl)
      if (localDupe) {
        showToast(
          `You're already tracking "${localDupe.name || 'this product'}". Check your Droplist.`,
          'error',
        )
        setTab('droplist')
        return { ok: false }
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
          return { ok: false }
        }
      }

      const detectedPlatform = getPlatform()

      if (detectedPlatform === 'chrome-desktop' && ext.extensionInstalled) {
        return addProductViaExtension(trimmedUrl, parsedThreshold, selectedFrequency)
      }

      if (detectedPlatform === 'chrome-desktop' && !ext.extensionInstalled && !ext.dismissedExtPrompt) {
        ext.setDontShowExtPromptAgain(false)
        ext.setPendingProduct({ url: trimmedUrl, threshold: parsedThreshold, frequency: selectedFrequency })
        ext.setShowExtPrompt(true)
        return { ok: false }
      }

      return addProductViaBackend(trimmedUrl, parsedThreshold, selectedFrequency)
    },
    [
      addProductViaBackend,
      addProductViaExtension,
      authHeaders,
      ext,
      isLoggedIn,
      products,
      setTab,
      showToast,
    ],
  )

  const redoVisualPick = useCallback(
    async (product) => {
      setLoadingId(product.id)
      showToast('Opening browser! Please click the new price location...', 'neutral')

      try {
        const pickData = await ext.requestExtensionVisualPick(product.url, product.threshold, product.frequency)
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
    },
    [authFetch, ext, showToast, updateProduct],
  )

  const checkProductNow = useCallback(
    async (product) => {
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
          history.fetchProductHistory(product.url, true)
          email.fetchPendingAlertCount()
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
    },
    [authFetch, authHeaders, email, history, scrapingUrls, showToast, updateProduct],
  )

  const trackedCount = products.length
  const belowThresholdCount = useMemo(
    () =>
      products.filter(
        (p) => p.lastPrice != null && p.threshold !== '' && Number(p.lastPrice) <= Number(p.threshold),
      ).length,
    [products],
  )

  const getSortedProducts = useCallback(
    (sortBy) => {
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
    },
    [products],
  )

  return {
    products,
    setProducts,
    loadingId,
    scrapingUrls,
    addProduct,
    addProductViaExtension,
    addProductViaBackend,
    handleSkipExtensionPrompt,
    redoVisualPick,
    removeProduct,
    updateProduct,
    checkProductNow,
    trackedCount,
    belowThresholdCount,
    getSortedProducts,
  }
}
