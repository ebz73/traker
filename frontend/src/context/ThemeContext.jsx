import { createContext, useContext } from 'react'
import { useTheme } from '../hooks/useTheme'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping ThemeContext + ThemeProvider in one file matches the plan's
// directory layout; the dev-time HMR cost is the theme tree re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const value = useTheme()
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useThemeContext = () => useContext(ThemeContext)
