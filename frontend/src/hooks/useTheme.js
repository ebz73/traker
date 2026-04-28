import { useCallback, useEffect, useState } from 'react'

const THEME_STORAGE_KEY = 'traker_theme'
const AVATAR_STORAGE_KEY = 'pt_avatar_char'

function readStoredPreference() {
  if (typeof window === 'undefined') return 'auto'
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

function readSystemTheme() {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Stateful single-use hook: call once at the app root and pass values down.
export function useTheme() {
  const [preference, setPreference] = useState(readStoredPreference)
  const [systemTheme, setSystemTheme] = useState(readSystemTheme)
  const [avatarChar, setAvatarChar] = useState(
    () => localStorage.getItem(AVATAR_STORAGE_KEY) || 'purple',
  )

  const resolvedTheme = preference === 'auto' ? systemTheme : preference

  // Apply resolved theme to the DOM
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', resolvedTheme === 'dark' ? '#0f1117' : '#6c3ff5')
    }
  }, [resolvedTheme])

  // React to system theme changes when preference is 'auto'
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event) => setSystemTheme(event.matches ? 'dark' : 'light')
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [])

  const setTheme = useCallback((next) => {
    if (next === 'auto') {
      localStorage.removeItem(THEME_STORAGE_KEY)
    } else if (next === 'light' || next === 'dark') {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } else {
      return
    }
    setPreference(next)
  }, [])

  const changeAvatar = useCallback((charName) => {
    setAvatarChar(charName)
    localStorage.setItem(AVATAR_STORAGE_KEY, charName)
  }, [])

  return { preference, resolvedTheme, setTheme, avatarChar, changeAvatar }
}
