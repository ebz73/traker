import { createContext, useCallback, useRef, useState } from 'react'
import ToastNotification from '../ToastNotification'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping ToastContext + ToastProvider in one file matches the plan's
// directory layout; the dev-time HMR cost is the toast tree re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const toastIdRef = useRef(0)

  const showToast = useCallback((message, type = 'neutral') => {
    toastIdRef.current += 1
    setToast({ message, type, id: toastIdRef.current })
  }, [])

  const dismissToast = useCallback(() => {
    setToast(null)
  }, [])

  const value = { showToast, dismissToast }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastNotification toast={toast} onDismiss={dismissToast} />
      <div aria-live="polite" aria-atomic="true" className="srOnly">
        {toast?.message || ''}
      </div>
    </ToastContext.Provider>
  )
}
