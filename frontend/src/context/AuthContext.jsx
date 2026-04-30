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
  const [authRefreshToken, setAuthRefreshToken] = useState(() => localStorage.getItem('pt_refresh_token') || '')
  const authRefreshTokenRef = useRef(authRefreshToken)
  const [authEmail, setAuthEmail] = useState(() => localStorage.getItem('pt_auth_email') || '')
  const authEmailRef = useRef(authEmail)
  const [authView, setAuthView] = useState('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [authSuccess, setAuthSuccess] = useState(false)
  const [loginExiting, setLoginExiting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [pendingEmail, setPendingEmail] = useState('')
  const [resetToken, setResetToken] = useState('')
  // null = unknown/loading; populated from /auth/me after authToken settles.
  const [emailVerified, setEmailVerified] = useState(null)

  // Keeps authTokenRef.current in sync with state so async callbacks (authFetch,
  // pre-fetch guards in email hooks) read the freshest token without stale closures.
  useEffect(() => {
    authTokenRef.current = authToken
  }, [authToken])

  useEffect(() => {
    authRefreshTokenRef.current = authRefreshToken
  }, [authRefreshToken])

  useEffect(() => {
    authEmailRef.current = authEmail
  }, [authEmail])

  const saveAuth = useCallback((token, refreshToken, email) => {
    authTokenRef.current = token
    authRefreshTokenRef.current = refreshToken
    authEmailRef.current = email
    setAuthToken(token)
    setAuthRefreshToken(refreshToken)
    setAuthEmail(email)
    localStorage.setItem('pt_auth_token', token)
    localStorage.setItem('pt_refresh_token', refreshToken)
    localStorage.setItem('pt_auth_email', email)
  }, [])

  const clearAuth = useCallback(() => {
    authTokenRef.current = ''
    authRefreshTokenRef.current = ''
    authEmailRef.current = ''
    setAuthToken('')
    setAuthRefreshToken('')
    setAuthEmail('')
    localStorage.removeItem('pt_auth_token')
    localStorage.removeItem('pt_refresh_token')
    localStorage.removeItem('pt_auth_email')
  }, [])

  const refreshUser = useCallback(async () => {
    const token = authTokenRef.current
    if (!token) return
    try {
      const res = await fetch(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json().catch(() => ({}))
      if (typeof data?.email_verified === 'boolean') {
        setEmailVerified(data.email_verified)
      }
      if (data?.email && data.email !== authEmailRef.current) {
        authEmailRef.current = data.email
        setAuthEmail(data.email)
        localStorage.setItem('pt_auth_email', data.email)
      }
    } catch {
      // Ignore — next user-initiated request will trip authFetch's refresh path if dead.
    }
  }, [])

  useEffect(() => {
    if (authToken) {
      refreshUser()
    } else {
      setEmailVerified(null)
    }
  }, [authToken, refreshUser])

  const refreshAccessToken = useCallback(async () => {
    const refreshToken = authRefreshTokenRef.current
    if (!refreshToken) return false
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) return false
      const data = await res.json()
      saveAuth(data.access_token, data.refresh_token, authEmailRef.current)
      return true
    } catch {
      return false
    }
  }, [saveAuth])

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
      let headers = authHeaders(options.headers || {})
      let res = await fetch(requestUrl, { ...options, headers })
      if (res.status === 401 && authRefreshTokenRef.current) {
        const refreshed = await refreshAccessToken()
        if (refreshed) {
          headers = {
            ...(options.headers || {}),
            Authorization: `Bearer ${authTokenRef.current}`,
          }
          res = await fetch(requestUrl, { ...options, headers })
        } else if (authTokenRef.current === tokenAtRequest) {
          clearAuth()
          showToast('Session expired. Please log in again.', 'error')
        }
      } else if (res.status === 401 && authTokenRef.current === tokenAtRequest) {
        clearAuth()
        showToast('Session expired. Please log in again.', 'error')
      }
      return res
    },
    [authHeaders, refreshAccessToken, clearAuth, showToast],
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginEmail,
          password: loginPassword,
          client_type: 'web',
        }),
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
          saveAuth(data.access_token, data.refresh_token, loginEmail)
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

  const signOut = useCallback(async () => {
    const refreshToken = authRefreshTokenRef.current
    if (refreshToken) {
      try {
        await fetch(`${API}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
      } catch {
        // Best-effort: clearAuth still runs below.
      }
    }
    clearAuth()
  }, [clearAuth])

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
      setPendingEmail(loginEmail)
      setAuthView('verify-email')
      setLoginPassword('')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [loginEmail, loginPassword, setLoginPassword])

  const handleVerifyEmailToken = useCallback(async (token, emailFromUrl) => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => ({}))
      window.history.replaceState({}, '', '/')
      if (!res.ok) {
        setPendingEmail(emailFromUrl || '')
        setAuthView('verify-email-error')
        setAuthError(data?.detail || 'Verification failed')
        return
      }
      saveAuth(data.access_token, data.refresh_token, emailFromUrl || authEmailRef.current)
      showToast('Email verified.', 'success')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [saveAuth, showToast])

  const handleForgotPassword = useCallback(async (email) => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setAuthError(data?.detail || 'Failed to send reset email.')
        return
      }
      setPendingEmail(email)
      setAuthView('forgot-sent')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [])

  const handleResetPassword = useCallback(async (newPassword) => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, new_password: newPassword }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAuthError(data?.detail || 'Reset failed.')
        return
      }
      // Swap in new tokens — current device stays alive, all other devices already revoked.
      saveAuth(data.access_token, data.refresh_token, authEmailRef.current || pendingEmail)
      setResetToken('')
      setLoginPassword('')
      setAuthView('login')
      showToast('Password updated.', 'success')
    } catch {
      setAuthError('Connection failed.')
    } finally {
      setAuthLoading(false)
    }
  }, [resetToken, saveAuth, pendingEmail, showToast])

  const handleGoogleHandoff = useCallback(async (handoffId) => {
    setAuthLoading(true)
    try {
      const res = await fetch(`${API}/auth/google/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoff_id: handoffId }),
      })
      const data = await res.json().catch(() => ({}))
      window.history.replaceState({}, '', '/')
      if (!res.ok) {
        showToast('Google sign-in failed.', 'error')
        return
      }
      // Handoff response doesn't include email; fetch /auth/me to populate it.
      let resolvedEmail = ''
      try {
        const meRes = await fetch(`${API}/auth/me`, {
          headers: { Authorization: `Bearer ${data.access_token}` },
        })
        if (meRes.ok) {
          const meData = await meRes.json()
          resolvedEmail = meData?.email || ''
        }
      } catch {
        // Fall through with empty email; auth still succeeds.
      }
      saveAuth(data.access_token, data.refresh_token, resolvedEmail)
    } catch {
      showToast('Connection failed.', 'error')
    } finally {
      setAuthLoading(false)
    }
  }, [saveAuth, showToast])

  const signInWithGoogle = useCallback(async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API}/auth/google/start?client_type=web`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.authorize_url) {
        showToast('Failed to start Google sign-in.', 'error')
        return
      }
      window.location.href = data.authorize_url
    } catch {
      showToast('Connection failed.', 'error')
      setAuthLoading(false)
    }
  }, [showToast])

  const handleResendVerification = useCallback(async (emailOverride) => {
    const target = emailOverride || pendingEmail
    if (!target) return
    try {
      const res = await fetch(`${API}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 429) {
        showToast(data?.detail || 'Please wait before requesting another email.', 'error')
        return
      }
      showToast('Verification email sent.', 'success')
    } catch {
      showToast('Failed to send email. Try again.', 'error')
    }
  }, [pendingEmail, showToast])

  const tokenProcessedRef = useRef(false)

  useEffect(() => {
    if (tokenProcessedRef.current) return
    const params = new URLSearchParams(window.location.search)
    const verifyToken = params.get('verify_token')
    const verifyEmail = params.get('email')
    const resetTokenParam = params.get('reset_token')
    const handoffId = params.get('google_handoff')
    const googleError = params.get('google_error')
    const view = params.get('view')
    if (verifyToken) {
      tokenProcessedRef.current = true
      handleVerifyEmailToken(verifyToken, verifyEmail)
      return
    }
    if (resetTokenParam) {
      tokenProcessedRef.current = true
      setResetToken(resetTokenParam)
      setAuthView('reset-password')
      window.history.replaceState({}, '', '/')
      return
    }
    if (handoffId) {
      tokenProcessedRef.current = true
      handleGoogleHandoff(handoffId)
      return
    }
    if (googleError) {
      tokenProcessedRef.current = true
      window.history.replaceState({}, '', '/')
      showToast('Google sign-in cancelled or failed.', 'error')
      return
    }
    if (view === 'register') {
      tokenProcessedRef.current = true
      setAuthView('register')
      window.history.replaceState({}, '', '/')
      return
    }
    if (view === 'forgot-password') {
      tokenProcessedRef.current = true
      setAuthView('forgot-password')
      window.history.replaceState({}, '', '/')
      return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = {
    authToken,
    authTokenRef,
    authRefreshToken,
    authRefreshTokenRef,
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
    pendingEmail,
    setPendingEmail,
    resetToken,
    setResetToken,
    emailVerified,
    refreshUser,
    saveAuth,
    clearAuth,
    signOut,
    authHeaders,
    authFetch,
    refreshAccessToken,
    handleLogin,
    handleRegister,
    handleResendVerification,
    handleForgotPassword,
    handleResetPassword,
    signInWithGoogle,
    deleteAccount,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
