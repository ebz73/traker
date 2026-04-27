import { useCallback, useEffect, useState } from 'react'

const THEME_STORAGE_KEY = 'traker_theme'
const AVATAR_STORAGE_KEY = 'pt_avatar_char'

// Stateful single-use hook: call once at the app root and pass values down.
// Multiple call sites would each get independent state.
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  const [avatarChar, setAvatarChar] = useState(() => localStorage.getItem(AVATAR_STORAGE_KEY) || 'purple')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#0f1117' : '#6c3ff5')
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const changeAvatar = useCallback((charName) => {
    setAvatarChar(charName)
    localStorage.setItem(AVATAR_STORAGE_KEY, charName)
  }, [])

  return { theme, toggleTheme, avatarChar, changeAvatar }
}
