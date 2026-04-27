import { createContext, useContext } from 'react'
import { useProducts } from '../hooks/useProducts'
import { useProductsSync } from '../hooks/useProductsSync'
import { useEmailSettingsContext } from './EmailSettingsContext'
import { useExtensionIntegrationContext } from './ExtensionIntegrationContext'
import { useNavigationContext } from './NavigationContext'
import { usePriceHistoryContext } from './PriceHistoryContext'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping ProductsContext + ProductsProvider in one file matches
// the plan's directory layout; the dev-time HMR cost is the products tree
// re-mounts on edit.
//
// ProductsProvider also wires up useProductsSync (initial load + periodic +
// extension-sync + persist effects). useProductsSync is a pure side-effect
// hook owned alongside useProducts so they're co-located in one Provider rather
// than split across two.
// eslint-disable-next-line react-refresh/only-export-components
export const ProductsContext = createContext(null)

export function ProductsProvider({ children }) {
  const ext = useExtensionIntegrationContext()
  const email = useEmailSettingsContext()
  const history = usePriceHistoryContext()
  const { setTab } = useNavigationContext()

  const products = useProducts({ ext, email, history, setTab })
  useProductsSync({
    products: products.products,
    setProducts: products.setProducts,
    fetchEmailSettings: email.fetchEmailSettings,
    fetchPendingAlertCount: email.fetchPendingAlertCount,
  })

  return <ProductsContext.Provider value={products}>{children}</ProductsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useProductsContext = () => useContext(ProductsContext)
