import { createContext, useContext } from 'react'
import { useExtensionIntegration } from '../hooks/useExtensionIntegration'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping ExtensionIntegrationContext + ExtensionIntegrationProvider
// in one file matches the plan's directory layout; the dev-time HMR cost is the
// extension tree re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const ExtensionIntegrationContext = createContext(null)

export function ExtensionIntegrationProvider({ children }) {
  const value = useExtensionIntegration()
  return (
    <ExtensionIntegrationContext.Provider value={value}>
      {children}
    </ExtensionIntegrationContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useExtensionIntegrationContext = () => useContext(ExtensionIntegrationContext)
