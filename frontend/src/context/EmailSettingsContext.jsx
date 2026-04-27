import { createContext, useContext } from 'react'
import { useEmailSettings } from '../hooks/useEmailSettings'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping EmailSettingsContext + EmailSettingsProvider in one file
// matches the plan's directory layout; the dev-time HMR cost is the email tree
// re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const EmailSettingsContext = createContext(null)

export function EmailSettingsProvider({ children }) {
  const value = useEmailSettings()
  return <EmailSettingsContext.Provider value={value}>{children}</EmailSettingsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useEmailSettingsContext = () => useContext(EmailSettingsContext)
