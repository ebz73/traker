import { useCallback, useEffect, useRef, useState } from 'react'

const initTabFromUrl = () => {
  if (typeof window === 'undefined') return 'home'
  try {
    const params = new URLSearchParams(window.location.search)
    const tabParam = (params.get('tab') || '').toLowerCase()
    if (tabParam === 'droplist') return 'droplist'
    if (tabParam === 'emailsettings') return 'emailSettings'
    if (tabParam === 'home') return 'home'
    if ((window.location.hash || '').toLowerCase() === '#droplist') return 'droplist'
  } catch {
    // Ignore URL parsing issues and default to home
  }
  return 'home'
}

// Stateful single-use hook: call once at the app root and pass values down.
// Multiple call sites would each get independent state.
export function useNavigation() {
  const [tab, setTab] = useState(initTabFromUrl)
  const [sortBy, setSortBy] = useState('default')
  const [navHidden, setNavHidden] = useState(false)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const droplistRef = useRef(null)
  const lastScrollY = useRef(0)

  // URL write-back: keep ?tab= in sync with current tab. replaceState (not push)
  // so we don't pollute browser history; back-button keeps prior site in history.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('tab', tab.toLowerCase())
      url.hash = ''
      window.history.replaceState(null, '', url.toString())
    } catch {
      // Ignore URL update failures
    }
  }, [tab])

  // Top-nav hides on scroll-down (past 60px), reappears on scroll-up.
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

  // Back-to-top button: only on droplist, after scrolling past 400px.
  // Single handler covers both the "wrong tab → hide" and "right tab → conditional show"
  // paths so that the only setState calls are inside an event handler (not the effect body),
  // satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    const update = () => {
      if (tab !== 'droplist' || !droplistRef.current) {
        setShowBackToTop(false)
        return
      }
      setShowBackToTop(window.scrollY > 400)
    }
    update()
    if (tab !== 'droplist') return undefined
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [tab])

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const navClass = useCallback((t) => `navBtn${tab === t ? ' active' : ''}`, [tab])

  return {
    tab,
    setTab,
    sortBy,
    setSortBy,
    navHidden,
    showBackToTop,
    droplistRef,
    scrollToTop,
    navClass,
  }
}
