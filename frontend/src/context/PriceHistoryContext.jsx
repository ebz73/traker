import { createContext, useContext } from 'react'
import { usePriceHistory } from '../hooks/usePriceHistory'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping PriceHistoryContext + PriceHistoryProvider in one file
// matches the plan's directory layout; the dev-time HMR cost is the history tree
// re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const PriceHistoryContext = createContext(null)

export function PriceHistoryProvider({ children }) {
  const value = usePriceHistory()
  return <PriceHistoryContext.Provider value={value}>{children}</PriceHistoryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const usePriceHistoryContext = () => useContext(PriceHistoryContext)
