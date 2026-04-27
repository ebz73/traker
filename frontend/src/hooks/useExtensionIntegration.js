import { useCallback, useEffect, useState } from 'react'
import {
  EXT_PING_INTERVAL_MS,
  EXT_PING_MAX_ATTEMPTS,
  PICK_ACK_TIMEOUT_MS,
  PICK_COMPLETION_TIMEOUT_MS,
  PICK_START_TIMEOUT_MS,
} from '../constants'
import { createId, getPlatform } from '../utils'
import { useToast } from './useToast'

// Stateful single-use hook: call once at the app root and pass values down.
// Owns extension detection (ping), the install-prompt modal flow state, and the
// requestExtensionVisualPick callback. Does NOT own handleSkipExtensionPrompt
// (that lives on useProducts because it triggers a backend product add).
export function useExtensionIntegration() {
  const { showToast } = useToast()

  const [platform] = useState(() => getPlatform())
  const [extensionInstalled, setExtensionInstalled] = useState(false)
  const [dismissedExtPrompt, setDismissedExtPrompt] = useState(
    () => localStorage.getItem('pt_dismiss_ext_prompt') === 'true',
  )
  const [showExtPrompt, setShowExtPrompt] = useState(false)
  const [pendingProduct, setPendingProduct] = useState(null)
  const [dontShowExtPromptAgain, setDontShowExtPromptAgain] = useState(false)

  // Extension ping detection: postMessage handshake, retried until the extension
  // responds or we hit EXT_PING_MAX_ATTEMPTS.
  useEffect(() => {
    let isUnmounted = false
    let isDetected = false
    let pingAttempts = 0
    let pingTimerId = null

    const sendExtensionPing = () => {
      if (isUnmounted || isDetected || pingAttempts >= EXT_PING_MAX_ATTEMPTS) {
        if (pingTimerId) clearInterval(pingTimerId)
        return
      }
      pingAttempts += 1
      window.postMessage(
        { source: 'price-tracker-web', type: 'PT_PING_EXT' },
        window.location.origin,
      )
    }

    const handler = (event) => {
      if (event.source !== window) return
      if (event.origin !== window.location.origin) return
      if (
        event.data?.source === 'price-tracker-extension' &&
        event.data?.type === 'PT_EXT_READY'
      ) {
        isDetected = true
        if (pingTimerId) clearInterval(pingTimerId)
        setExtensionInstalled(true)
      }
    }
    window.addEventListener('message', handler)

    sendExtensionPing()
    pingTimerId = setInterval(sendExtensionPing, EXT_PING_INTERVAL_MS)

    return () => {
      isUnmounted = true
      window.removeEventListener('message', handler)
      if (pingTimerId) clearInterval(pingTimerId)
    }
  }, [])

  // Cross-tab sync of the "don't show again" flag.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === 'pt_dismiss_ext_prompt') {
        setDismissedExtPrompt(event.newValue === 'true')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    console.log('[Traker] Platform detected:', platform)
  }, [platform])

  useEffect(() => {
    console.log('[Traker] Extension installed:', extensionInstalled, '| dismissedExtPrompt:', dismissedExtPrompt)
  }, [extensionInstalled, dismissedExtPrompt])

  const requestExtensionVisualPick = useCallback(
    (targetUrl, pickThreshold, pickFrequency) =>
      new Promise((resolve, reject) => {
        const requestId = createId()
        let accepted = false
        let started = false
        let ackTimeoutId = null
        let startupTimeoutId = null
        let completionTimeoutId = null

        const cleanup = () => {
          window.removeEventListener('message', onMessage)
          if (ackTimeoutId) clearTimeout(ackTimeoutId)
          if (startupTimeoutId) clearTimeout(startupTimeoutId)
          if (completionTimeoutId) clearTimeout(completionTimeoutId)
        }

        const fail = (nextMessage) => {
          cleanup()
          reject(new Error(nextMessage))
        }

        const armStartupTimeout = () => {
          if (startupTimeoutId) clearTimeout(startupTimeoutId)
          startupTimeoutId = setTimeout(() => {
            if (started) return
            fail('Extension accepted the picker request, but startup is taking too long. The product page may be slow or blocked; please try again.')
          }, PICK_START_TIMEOUT_MS)
        }

        const armCompletionTimeout = () => {
          if (completionTimeoutId) clearTimeout(completionTimeoutId)
          completionTimeoutId = setTimeout(() => {
            fail('Timed out waiting for price selection.')
          }, PICK_COMPLETION_TIMEOUT_MS)
        }

        const onMessage = (event) => {
          if (event.source !== window) return
          if (event.origin !== window.location.origin) return
          const msg = event.data
          if (!msg || msg.source !== 'price-tracker-extension' || msg.requestId !== requestId) return

          if (msg.type === 'PT_PICK_ACCEPTED') {
            accepted = true
            if (ackTimeoutId) clearTimeout(ackTimeoutId)
            showToast(
              msg.alreadyInFlight
                ? 'Picker request already in progress. Waiting for product page...'
                : 'Extension accepted request. Opening product page...',
              'neutral',
            )
            armStartupTimeout()
            return
          }

          if (msg.type === 'PT_PICK_STARTED') {
            accepted = true
            started = true
            if (ackTimeoutId) clearTimeout(ackTimeoutId)
            if (startupTimeoutId) clearTimeout(startupTimeoutId)
            showToast('Extension picker opened. Click the price element on the product page, then press Save.', 'neutral')
            armCompletionTimeout()
            return
          }

          if (msg.type === 'PT_PICK_RESULT') {
            cleanup()
            resolve(msg.payload || {})
            return
          }

          if (msg.type === 'PT_PICK_ERROR') {
            fail(msg.error || 'Extension picker failed.')
          }
        }

        ackTimeoutId = setTimeout(() => {
          if (accepted) return
          fail('Extension bridge not reachable. Set extension Site access to "On all sites", then reload extension and refresh this page.')
        }, PICK_ACK_TIMEOUT_MS)

        window.addEventListener('message', onMessage)
        window.postMessage(
          {
            source: 'price-tracker-web',
            type: 'PT_START_PICK',
            requestId,
            payload: {
              url: targetUrl,
              threshold: pickThreshold,
              frequency: pickFrequency,
            },
          },
          window.location.origin,
        )
      }),
    [showToast],
  )

  const dismissExtensionPrompt = useCallback(() => {
    if (dontShowExtPromptAgain) {
      localStorage.setItem('pt_dismiss_ext_prompt', 'true')
      setDismissedExtPrompt(true)
    }
    setShowExtPrompt(false)
    setPendingProduct(null)
  }, [dontShowExtPromptAgain])

  const handleGetExtension = useCallback(() => {
    window.open('https://chrome.google.com/webstore/detail/traker/YOUR_ID', '_blank', 'noopener,noreferrer')
    dismissExtensionPrompt()
  }, [dismissExtensionPrompt])

  return {
    platform,
    extensionInstalled,
    dismissedExtPrompt,
    showExtPrompt,
    setShowExtPrompt,
    pendingProduct,
    setPendingProduct,
    dontShowExtPromptAgain,
    setDontShowExtPromptAgain,
    requestExtensionVisualPick,
    dismissExtensionPrompt,
    handleGetExtension,
  }
}
