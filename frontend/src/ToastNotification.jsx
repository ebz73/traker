import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './ToastNotification.css'
import { CHARACTER_COLORS } from './constants'
import { pseudoRandom } from './utils'

const ENTER_DELAY_MS = 30
const AUTO_HIDE_DURATIONS = {
  success: 3500,
  neutral: 4000,
  error: 6000,
}
const DEFAULT_AUTO_HIDE_MS = AUTO_HIDE_DURATIONS.neutral
const EXIT_DURATION_MS = 350
const CHARACTERS = [
  { type: 'orange', delay: '0ms' },
  { type: 'purple', delay: '80ms' },
  { type: 'black', delay: '160ms' },
  { type: 'yellow', delay: '240ms' },
]

function MiniConfetti({ active }) {
  const pieces = useMemo(() => {
    if (!active) return []

    const colors = [
      CHARACTER_COLORS.purple.bg,
      CHARACTER_COLORS.orange.bg,
      CHARACTER_COLORS.yellow.bg,
      CHARACTER_COLORS.black.bg,
      '#34d399',
      '#60a5fa',
      '#f43f5e',
      '#f5f5f5',
    ]

    return Array.from({ length: 16 }, (_, index) => ({
      id: index,
      left: 10 + pseudoRandom(index * 1.17 + 4.2) * 78,
      delay: pseudoRandom(index * 1.51 + 8.9) * 0.18,
      duration: 0.95 + pseudoRandom(index * 1.83 + 13.4) * 0.55,
      width: 4 + pseudoRandom(index * 2.11 + 17.8) * 4,
      height: 6 + pseudoRandom(index * 2.39 + 21.6) * 5,
      drift: (pseudoRandom(index * 2.67 + 28.4) - 0.5) * 48,
      rotation: pseudoRandom(index * 2.91 + 31.1) * 360,
      color: colors[index % colors.length],
    }))
  }, [active])

  if (!active) return null

  return (
    <div className="toast-confetti" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="toast-confetti-piece"
          style={{
            left: `${piece.left}%`,
            width: `${piece.width}px`,
            height: `${piece.height}px`,
            backgroundColor: piece.color,
            animationDelay: `${piece.delay}s`,
            animationDuration: `${piece.duration}s`,
            '--drift': `${piece.drift}px`,
            '--rotation': `${piece.rotation}deg`,
          }}
        />
      ))}
    </div>
  )
}

function MiniCharacter({ type, delay }) {
  const isRectangle = type === 'purple' || type === 'black'

  return (
    <div className={`toast-character toast-character--${type}`} style={{ '--character-delay': delay }}>
      <div className="toast-character-motion">
        <div className="toast-character-body">
          {isRectangle ? (
            <div className={`toast-eye-row toast-eye-row--${type}`}>
              <div className="toast-eyeball">
                <div className="toast-pupil" />
              </div>
              <div className="toast-eyeball">
                <div className="toast-pupil" />
              </div>
            </div>
          ) : (
            <>
              <div className={`toast-dot-eye-row toast-dot-eye-row--${type}`}>
                <span className="toast-dot-eye" />
                <span className="toast-dot-eye" />
              </div>
              <div className={`toast-mouth toast-mouth--${type}`} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function MiniCharacters({ emotion }) {
  return (
    <div className={`toast-characters-row toast-characters-row--${emotion}`} aria-hidden="true">
      <MiniConfetti active={emotion === 'success'} />
      {CHARACTERS.map((character) => (
        <MiniCharacter key={character.type} type={character.type} delay={character.delay} />
      ))}
    </div>
  )
}

function ToastNotification({ toast, onDismiss }) {
  const [renderedToast, setRenderedToast] = useState(null)
  const [visible, setVisible] = useState(false)
  const timersRef = useRef({ sync: null, enter: null, auto: null, exit: null })
  const renderedToastRef = useRef(null)
  const visibleRef = useRef(false)
  const dismissingRef = useRef(false)
  const timerStartedAtRef = useRef(0)
  const remainingMsRef = useRef(0)
  const hoverPausedRef = useRef(false)
  const touchPausedRef = useRef(false)
  const focusPausedRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (timersRef.current.sync) clearTimeout(timersRef.current.sync)
    if (timersRef.current.enter) clearTimeout(timersRef.current.enter)
    if (timersRef.current.auto) clearTimeout(timersRef.current.auto)
    if (timersRef.current.exit) clearTimeout(timersRef.current.exit)
    timersRef.current = { sync: null, enter: null, auto: null, exit: null }
    hoverPausedRef.current = false
    touchPausedRef.current = false
    focusPausedRef.current = false
  }, [])

  const startDismiss = useCallback(
    (notifyParent = true) => {
      if (dismissingRef.current || !renderedToastRef.current) return

      dismissingRef.current = true
      clearTimers()
      visibleRef.current = false
      setVisible(false)

      timersRef.current.exit = setTimeout(() => {
        dismissingRef.current = false
        renderedToastRef.current = null
        setRenderedToast(null)

        if (notifyParent && typeof onDismiss === 'function') {
          onDismiss()
        }
      }, EXIT_DURATION_MS)
    },
    [clearTimers, onDismiss],
  )

  const isPaused = useCallback(
    () => hoverPausedRef.current || touchPausedRef.current || focusPausedRef.current,
    [],
  )

  const syncPauseState = useCallback(() => {
    if (dismissingRef.current) return
    const shouldPause = isPaused()
    if (shouldPause && timersRef.current.auto) {
      clearTimeout(timersRef.current.auto)
      timersRef.current.auto = null
      remainingMsRef.current = Math.max(
        0,
        remainingMsRef.current - (Date.now() - timerStartedAtRef.current),
      )
    } else if (!shouldPause && !timersRef.current.auto && remainingMsRef.current > 0) {
      timerStartedAtRef.current = Date.now()
      timersRef.current.auto = setTimeout(() => startDismiss(true), remainingMsRef.current)
    }
  }, [isPaused, startDismiss])

  const handleMouseEnter = useCallback(() => {
    hoverPausedRef.current = true
    syncPauseState()
  }, [syncPauseState])

  const handleMouseLeave = useCallback(() => {
    hoverPausedRef.current = false
    syncPauseState()
  }, [syncPauseState])

  const handleTouchStart = useCallback(() => {
    touchPausedRef.current = true
    syncPauseState()
  }, [syncPauseState])

  const handleTouchEnd = useCallback(() => {
    touchPausedRef.current = false
    syncPauseState()
  }, [syncPauseState])

  const handleFocus = useCallback(() => {
    focusPausedRef.current = true
    syncPauseState()
  }, [syncPauseState])

  const handleBlur = useCallback(() => {
    focusPausedRef.current = false
    syncPauseState()
  }, [syncPauseState])

  useEffect(() => {
    renderedToastRef.current = renderedToast
  }, [renderedToast])

  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  useEffect(
    () => () => {
      clearTimers()
    },
    [clearTimers],
  )

  useEffect(() => {
    if (!toast) {
      if (renderedToastRef.current && !dismissingRef.current) {
        timersRef.current.exit = setTimeout(() => {
          startDismiss(false)
        }, 0)
      }
      return undefined
    }

    clearTimers()
    dismissingRef.current = false
    timersRef.current.sync = setTimeout(() => {
      renderedToastRef.current = toast
      setRenderedToast(toast)
    }, 0)

    const toastType =
      toast.type === 'success' || toast.type === 'error' || toast.type === 'neutral'
        ? toast.type
        : 'neutral'
    const duration = AUTO_HIDE_DURATIONS[toastType] ?? DEFAULT_AUTO_HIDE_MS

    const totalDuration = visibleRef.current ? duration : ENTER_DELAY_MS + duration
    timerStartedAtRef.current = Date.now()
    remainingMsRef.current = totalDuration

    if (!visibleRef.current) {
      timersRef.current.enter = setTimeout(() => {
        visibleRef.current = true
        setVisible(true)
      }, ENTER_DELAY_MS)
    }

    timersRef.current.auto = setTimeout(() => {
      startDismiss(true)
    }, totalDuration)

    return clearTimers
  }, [toast, clearTimers, startDismiss])

  if (!renderedToast) return null

  const type =
    renderedToast.type === 'success' || renderedToast.type === 'error' || renderedToast.type === 'neutral'
      ? renderedToast.type
      : 'neutral'
  const toastKey = renderedToast.id ?? `${type}-${renderedToast.message}`

  return (
    <div
      className={`toast-outer ${visible ? 'toast-enter' : 'toast-exit'}`}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape') startDismiss(true)
      }}
    >
      <div className={`toast-box toast-box--${type}`}>
        <MiniCharacters key={toastKey} emotion={type} />
        <p className="toast-message">{renderedToast.message}</p>

        <button
          type="button"
          className="toast-close"
          aria-label="Dismiss notification"
          onClick={() => startDismiss(true)}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3L3 11" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default ToastNotification
