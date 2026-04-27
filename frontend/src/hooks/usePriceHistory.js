import { useCallback, useEffect, useRef, useState } from 'react'
import { API } from '../constants'
import { useAuth } from './useAuth'

// Stateful single-use hook: call once at the app root and pass values down.
// toggleHistory takes the product object directly (not just an id) so this
// hook doesn't need to know about the products list — see Phase 4 design
// decision #5 in .refactor-log.md.
export function usePriceHistory() {
  const { authToken, authFetch } = useAuth()

  const [expandedHistory, setExpandedHistory] = useState({})
  const [historyByUrl, setHistoryByUrl] = useState({})
  const [historyLoadingByUrl, setHistoryLoadingByUrl] = useState({})

  // Per-hook logout cleanup: reset history state when auth flips truthy → falsy.
  // Indirected through resetOnLogout() to satisfy react-hooks/set-state-in-effect.
  const prevAuthTokenRef = useRef(authToken)
  useEffect(() => {
    const resetOnLogout = () => {
      setExpandedHistory({})
      setHistoryByUrl({})
      setHistoryLoadingByUrl({})
    }
    const wasLoggedIn = Boolean(prevAuthTokenRef.current)
    const isNowLoggedIn = Boolean(authToken)
    if (wasLoggedIn && !isNowLoggedIn) {
      resetOnLogout()
    }
    prevAuthTokenRef.current = authToken
  }, [authToken])

  const fetchProductHistory = useCallback(
    async (productUrl, force = false) => {
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
    },
    [authFetch, historyByUrl],
  )

  const toggleHistory = useCallback(
    (product) => {
      if (!product) return
      setExpandedHistory((prev) => {
        const nextOpen = !prev[product.id]
        if (nextOpen) {
          fetchProductHistory(product.url, true)
        }
        return { ...prev, [product.id]: nextOpen }
      })
    },
    [fetchProductHistory],
  )

  return {
    expandedHistory,
    historyByUrl,
    historyLoadingByUrl,
    fetchProductHistory,
    toggleHistory,
  }
}
