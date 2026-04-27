import { createContext, useContext } from 'react'
import { useAddProductForm } from '../hooks/useAddProductForm'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping AddProductFormContext + AddProductFormProvider in one file
// matches the plan's directory layout; the dev-time HMR cost is the form tree
// re-mounts on edit.
//
// Phase 4 design decision #1 (Option A) is preserved here: the form does NOT
// consume products — it only owns its own state and validate/reset. Consumers
// (HomeTab + AppShell) bridge form ↔ products themselves so this provider has
// no dependency on ProductsProvider and can sit higher in the tree.
// eslint-disable-next-line react-refresh/only-export-components
export const AddProductFormContext = createContext(null)

export function AddProductFormProvider({ children }) {
  const value = useAddProductForm()
  return <AddProductFormContext.Provider value={value}>{children}</AddProductFormContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAddProductFormContext = () => useContext(AddProductFormContext)
