import { createContext, useCallback, useEffect, useRef, useState } from 'react'
import { API } from '../constants'
import { useToast } from '../hooks/useToast'

// HMR fast-refresh treats files that export both a component and a non-component
// as ineligible. Keeping AuthContext + AuthProvider in one file matches the plan's
// directory layout; the dev-time HMR cost is the auth tree re-mounts on edit.
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { showToast, dismissToast } = useToast()

  const [authToken, setAuthToken] = useState(() => localStorage.getItem('pt_auth_token') || '')
  const authTokenRef = useRef(authToken)
  const [authEmail, setAuthEmail] = useState(() => localStorage.getItem('pt_auth_email') || '')
  const [authView, setAuthView] = useState('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [authSuccess, setAuthSuccess] = useState(false)
  const [loginExiting, setLoginExiting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // Keeps authTokenRef.current in sync with state so async callbacks (authFetch,
  // pre-fetch guards in email hooks) read the freshest token without stale closures.
  useEffect(() => {
    authTokenRef.current = authToken
  }, [authToken])

  const saveAuth = useCallback((token, email) => {
    authTokenRef.current = token
    setAuthToken(token)
    setAuthEmail(email)
    localStorage.setItem('pt_auth_token', token)
    localStorage.setItem('pt_auth_email', email)
  }, [])

  const clearAuth = useCallback(() => {
    authTokenRef.current = ''
    setAuthToken('')
    setAuthEmail('')
    localStorage.removeItem('pt_auth_token')
    localStorage.removeItem('pt_auth_email')
  }, [])

  const authHeaders = useCallback(
    (extraHeaders = {}) => ({
      ...extraHeaders,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  )

  const authFetch = useCallback(
    async (requestUrl, options = {}) => {
      // Read from the ref, not the state, so async callbacks captured at an
      // earlier render still see the freshest token.
      const tokenAtRequest = authTokenRef.current
      const headers = authHeaders(options.headers || {})
      const res = await fetch(requestUrl, { ...options, headers })
      if (res.status === 401) {
        // Ignore stale 401s from requests started before a newer session was established.
        if (authTokenRef.current === tokenAtRequest) {
          clearAuth()
          showToast('Session expired. Please log in again.', 'error')
        }
      }
      return res
    },
    [authHeaders, clearAuth, showToast],
  )

  const deleteAccount = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/auth/account`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail || 'Failed to delete account')
      }
      clearAuth()
      showToast('Your account has been permanently deleted.', 'success')
    } catch (err) {
      console.error('[Traker] account deletion failed:', err)
      showToast(err?.message || 'Failed to delete account. Please try again.', 'error')
    }
  }, [authFetch, clearAuth, showToast])

  const handleLogin = useCallback(async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthError(data?.detail || 'Login failed.')
        return
      }
      setAuthSuccess(true)

      const isMobile = window.innerWidth <= 1024
      const celebrationDuration = isMobile ? 0 : 1600
      const exitDuration = isMobile ? 300 : 400

      setTimeout(() => {
        setLoginExiting(true)
        setTimeout(() => {
          saveAuth(data.access_token, loginEmail)
          dismissToast()
          setAuthSuccess(false)
          setLoginExiting(false)
        }, exitDuration)
      }, celebrationDuration)
      setLoginPassword('')
      setAuthError('')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [loginEmail, loginPassword, saveAuth, dismissToast])

  const handleRegister = useCallback(async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthError(data?.detail || 'Registration failed.')
        return
      }
      setAuthView('login')
      await handleLogin()
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [loginEmail, loginPassword, handleLogin])

  const value = {
    authToken,
    authTokenRef,
    authEmail,
    authView,
    setAuthView,
    authLoading,
    authError,
    setAuthError,
    authSuccess,
    loginExiting,
    loginEmail,
    setLoginEmail,
    loginPassword,
    setLoginPassword,
    saveAuth,
    clearAuth,
    authHeaders,
    authFetch,
    handleLogin,
    handleRegister,
    deleteAccount,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
