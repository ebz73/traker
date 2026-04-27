import { useEffect } from 'react'
import './App.css'
import LoginPage from './LoginPage'
import DroplistTab from './components/DroplistTab'
import EmailSettingsTab from './components/EmailSettingsTab'
import ExtensionPromptModal from './components/ExtensionPromptModal'
import HomeTab from './components/HomeTab'
import TopBar from './components/TopBar'
import { AddProductFormProvider, useAddProductFormContext } from './context/AddProductFormContext'
import { AuthProvider } from './context/AuthContext'
import { EmailSettingsProvider } from './context/EmailSettingsContext'
import { ExtensionIntegrationProvider, useExtensionIntegrationContext } from './context/ExtensionIntegrationContext'
import { NavigationProvider, useNavigationContext } from './context/NavigationContext'
import { PriceHistoryProvider } from './context/PriceHistoryContext'
import { ProductsProvider, useProductsContext } from './context/ProductsContext'
import { ThemeProvider } from './context/ThemeContext'
import { ToastProvider } from './context/ToastContext'
import { useAuth } from './hooks/useAuth'


function AppShell() {
  const { authToken } = useAuth()
  const { tab } = useNavigationContext()
  const ext = useExtensionIntegrationContext()
  const products = useProductsContext()
  const form = useAddProductFormContext()

  // Service-worker registration: one-time global side effect with no other appropriate home.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // Bridges form ↔ products for the extension-prompt skip path. Phase 4 Option A
  // keeps form decoupled from products inside the form provider, so the wrapper
  // is composed at the consumer site (here, since AppShell renders the modal).
  const handleSkipExtensionPrompt = async () => {
    const result = await products.handleSkipExtensionPrompt()
    if (result?.ok) form.reset()
  }

  if (!authToken) return <LoginPage />

  return (
    <div className="pageBg">
      <a href="#main-content" className="skipLink">Skip to main content</a>
      <TopBar />

      <main className="shell" id="main-content">
        {tab === 'home' && <HomeTab />}
        {tab === 'droplist' && <DroplistTab />}
        {tab === 'emailSettings' && <EmailSettingsTab />}
      </main>

      <ExtensionPromptModal
        show={ext.showExtPrompt}
        dontShowAgain={ext.dontShowExtPromptAgain}
        onChangeDontShowAgain={ext.setDontShowExtPromptAgain}
        onGetExtension={ext.handleGetExtension}
        onSkip={handleSkipExtensionPrompt}
        onDismiss={ext.dismissExtensionPrompt}
      />
    </div>
  )
}

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ThemeProvider>
          <NavigationProvider>
            <AddProductFormProvider>
              <ExtensionIntegrationProvider>
                <EmailSettingsProvider>
                  <PriceHistoryProvider>
                    <ProductsProvider>
                      <AppShell />
                    </ProductsProvider>
                  </PriceHistoryProvider>
                </EmailSettingsProvider>
              </ExtensionIntegrationProvider>
            </AddProductFormProvider>
          </NavigationProvider>
        </ThemeProvider>
      </AuthProvider>
    </ToastProvider>
  )
}

export default App
