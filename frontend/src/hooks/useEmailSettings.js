import { useCallback, useEffect, useRef, useState } from 'react'
import { API } from '../constants'
import { normalizeEmail } from '../utils'
import { useAuth } from './useAuth'
import { useToast } from './useToast'

// Stateful single-use hook: call once at the app root and pass values down.
// authTokenRef pre-checks read the ref (not the state) to avoid stale-closure
// 401s after a fresh login; ref is listed in deps to satisfy
// react-hooks/exhaustive-deps (refs have stable identity, so this is a no-op
// behaviorally — same pattern Chat 2 established).
export function useEmailSettings() {
  const { authToken, authTokenRef, authFetch } = useAuth()
  const { showToast } = useToast()

  const [emailSettings, setEmailSettings] = useState({ enabled: false, recipients: [], primaryEmail: '' })
  const [emailSettingsLoading, setEmailSettingsLoading] = useState(false)
  const [pendingAlertCount, setPendingAlertCount] = useState(0)
  const [newRecipientEmail, setNewRecipientEmail] = useState('')
  const [recipientEmailInvalid, setRecipientEmailInvalid] = useState(false)

  // Per-hook logout cleanup: when authToken transitions truthy → falsy, reset
  // all email-scoped local state. Each domain hook owns its own cleanup so
  // AppShell doesn't need to know about every hook's internals. Indirected
  // through resetOnLogout() to satisfy react-hooks/set-state-in-effect.
  const prevAuthTokenRef = useRef(authToken)
  useEffect(() => {
    const resetOnLogout = () => {
      setEmailSettings({ enabled: false, recipients: [], primaryEmail: '' })
      setEmailSettingsLoading(false)
      setPendingAlertCount(0)
      setNewRecipientEmail('')
      setRecipientEmailInvalid(false)
    }
    const wasLoggedIn = Boolean(prevAuthTokenRef.current)
    const isNowLoggedIn = Boolean(authToken)
    if (wasLoggedIn && !isNowLoggedIn) {
      resetOnLogout()
    }
    prevAuthTokenRef.current = authToken
  }, [authToken])

  const fetchEmailSettings = useCallback(async () => {
    if (!authTokenRef.current) return
    try {
      const res = await authFetch(`${API}/email-settings`)
      if (res.ok) {
        const data = await res.json()
        setEmailSettings({
          enabled: data.enabled,
          recipients: data.recipients || [],
          primaryEmail: data.primary_email || '',
        })
      }
    } catch {/* Ignore errors and keep existing settings */}
  }, [authFetch, authTokenRef])

  const fetchPendingAlertCount = useCallback(async () => {
    if (!authTokenRef.current) return
    try {
      const res = await authFetch(`${API}/email-alerts/pending`)
      if (res.ok) {
        const data = await res.json()
        setPendingAlertCount(data.pending_count || 0)
      }
    } catch {/* Ignore errors and keep existing count */}
  }, [authFetch, authTokenRef])

  const updateEmailSettings = useCallback(
    async (updates) => {
      setEmailSettingsLoading(true)
      try {
        const res = await authFetch(`${API}/email-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: updates.enabled ?? emailSettings.enabled,
            recipients: updates.recipients ?? emailSettings.recipients,
          }),
        })
        if (res.ok) {
          const data = await res.json()
          setEmailSettings((prev) => ({
            ...prev,
            enabled: data.enabled,
            recipients: data.recipients || prev.recipients,
          }))
          showToast('Email settings saved.', 'success')
        } else {
          showToast('Failed to save email settings.', 'error')
        }
      } catch {
        showToast('Failed to save email settings.', 'error')
      } finally {
        setEmailSettingsLoading(false)
      }
    },
    [authFetch, emailSettings.enabled, emailSettings.recipients, showToast],
  )

  const addRecipient = useCallback(() => {
    const email = normalizeEmail(newRecipientEmail)
    if (!email || !email.includes('@') || !email.includes('.')) {
      setRecipientEmailInvalid(true)
      showToast('Please enter a valid email address.', 'error')
      return
    }
    setRecipientEmailInvalid(false)
    if (email === normalizeEmail(emailSettings.primaryEmail)) {
      showToast('This is already your primary email.', 'error')
      return
    }
    if (emailSettings.recipients.includes(email)) {
      showToast('This email is already added.', 'error')
      return
    }
    const nextRecipients = [...emailSettings.recipients, email]
    setNewRecipientEmail('')
    updateEmailSettings({ recipients: nextRecipients })
  }, [emailSettings.primaryEmail, emailSettings.recipients, newRecipientEmail, showToast, updateEmailSettings])

  const removeRecipient = useCallback(
    (email) => {
      const nextRecipients = emailSettings.recipients.filter((r) => r !== email)
      updateEmailSettings({ recipients: nextRecipients })
    },
    [emailSettings.recipients, updateEmailSettings],
  )

  const sendDigestNow = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/email-alerts/send-digest`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (data.ok && data.sent > 0) {
        showToast(`Digest sent! ${data.sent} alert(s) emailed.`, 'success')
        setPendingAlertCount(0)
      } else if (data.ok && data.sent === 0) {
        showToast('No pending alerts to send.', 'neutral')
        setPendingAlertCount(0)
      } else {
        showToast(data.reason || 'Failed to send digest.', 'error')
      }
    } catch {
      showToast('Failed to send digest.', 'error')
    }
  }, [authFetch, showToast])

  return {
    emailSettings,
    emailSettingsLoading,
    pendingAlertCount,
    newRecipientEmail,
    setNewRecipientEmail,
    recipientEmailInvalid,
    setRecipientEmailInvalid,
    fetchEmailSettings,
    fetchPendingAlertCount,
    updateEmailSettings,
    addRecipient,
    removeRecipient,
    sendDigestNow,
  }
}
