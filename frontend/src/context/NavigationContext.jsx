import { createContext, useContext } from 'react'
import { useNavigation } from '../hooks/useNavigation'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping NavigationContext + NavigationProvider in one file matches
// the plan's directory layout; the dev-time HMR cost is the navigation tree
// re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const NavigationContext = createContext(null)

export function NavigationProvider({ children }) {
  const value = useNavigation()
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useNavigationContext = () => useContext(NavigationContext)
