import { useEffect, useMemo, useRef, useState } from 'react'
import './LoginPage.css'
import { CHARACTER_COLORS } from './constants'
import { useAuth } from './hooks/useAuth'
import { useRandomBlink } from './hooks/useRandomBlink'
import { pseudoRandom } from './utils'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const randomInRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

function resolveLook({ deltaX, deltaY, maxDistance, forceLookX, forceLookY }) {
  if (typeof forceLookX === 'number' || typeof forceLookY === 'number') {
    return {
      x: clamp(typeof forceLookX === 'number' ? forceLookX : 0, -maxDistance, maxDistance),
      y: clamp(typeof forceLookY === 'number' ? forceLookY : 0, -maxDistance, maxDistance),
    }
  }

  const angle = Math.atan2(deltaY, deltaX)
  const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), maxDistance)

  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
  }
}

function EyeBall({
  size,
  pupilSize,
  maxDistance,
  eyeColor,
  pupilColor,
  isBlinking,
  forceLookX,
  forceLookY,
  deltaX,
  deltaY,
}) {
  const look = resolveLook({ deltaX, deltaY, maxDistance, forceLookX, forceLookY })

  return (
    <div
      className={`lp-eyeball${isBlinking ? ' lp-eyeballBlink' : ''}`}
      style={{
        width: `${size}px`,
        height: `${isBlinking ? 2 : size}px`,
        background: eyeColor,
      }}
    >
      <div
        className="lp-eyePupil"
        style={{
          width: `${pupilSize}px`,
          height: `${pupilSize}px`,
          background: pupilColor,
          transform: `translate(${look.x}px, ${look.y}px)`,
          opacity: isBlinking ? 0 : 1,
        }}
      />
    </div>
  )
}

function Pupil({ size, maxDistance, pupilColor, forceLookX, forceLookY, deltaX, deltaY, isBlinking, emotion }) {
  const look = resolveLook({ deltaX, deltaY, maxDistance, forceLookX, forceLookY })
  const scale = emotion === 'success' ? 1.2 : emotion === 'error' ? 0.9 : 1

  return (
    <div
      className={`lp-pupil${isBlinking ? ' lp-pupilBlink' : ''}`}
      style={{
        width: `${size}px`,
        height: `${isBlinking ? 2 : size}px`,
        background: pupilColor,
        transform: `translate(${isBlinking ? 0 : look.x}px, ${isBlinking ? 0 : look.y}px) scale(${scale})`,
      }}
    />
  )
}

function getCharacterTrack(element, mouseX, mouseY) {
  if (!element) {
    return { deltaX: 0, deltaY: 0, skew: 0 }
  }

  const rect = element.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 3
  const deltaX = mouseX - centerX
  const deltaY = mouseY - centerY
  const skew = clamp(-deltaX / 120, -6, 6)

  return { deltaX, deltaY, skew }
}

function Confetti({ active }) {
  const pieces = useMemo(() => {
    if (!active) return []

    const colors = [
      CHARACTER_COLORS.purple.bg,
      CHARACTER_COLORS.orange.bg,
      CHARACTER_COLORS.yellow.bg,
      CHARACTER_COLORS.black.bg,
      '#ff4d8d',
      '#4dc9f6',
      '#f5f5f5',
    ]

    return Array.from({ length: 40 }, (_, i) => {
      const color = colors[i % colors.length]
      const left = pseudoRandom(i * 1.11 + 10.7) * 100
      const delay = pseudoRandom(i * 1.41 + 23.1) * 0.6
      const duration = 1.4 + pseudoRandom(i * 1.73 + 31.9) * 1.0
      const size = 6 + pseudoRandom(i * 2.07 + 47.3) * 6
      const rotation = pseudoRandom(i * 2.29 + 59.8) * 360
      const drift = (pseudoRandom(i * 2.63 + 71.2) - 0.5) * 120
      const height = size * (0.4 + pseudoRandom(i * 2.97 + 89.4) * 0.6)

      return (
        <div
          key={i}
          className="lp-confetti-piece"
          style={{
            left: `${left}%`,
            width: `${size}px`,
            height: `${height}px`,
            backgroundColor: color,
            animationDelay: `${delay}s`,
            animationDuration: `${duration}s`,
            '--drift': `${drift}px`,
            '--rotation': `${rotation}deg`,
          }}
        />
      )
    })
  }, [active])

  if (!active) return null
  return <div className="lp-confetti-container">{pieces}</div>
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  )
}

function LoginPage() {
  // Phase 6: LoginPage consumes useAuth() directly. The AuthProvider is mounted
  // above this component (AppShell early-returns to LoginPage when !authToken),
  // so all auth state + handlers are available via context.
  const {
    authView,
    setAuthView,
    loginEmail,
    setLoginEmail,
    loginPassword,
    setLoginPassword,
    pendingEmail,
    setPendingEmail,
    authError,
    setAuthError,
    authLoading,
    authSuccess,
    loginExiting,
    handleLogin,
    handleRegister,
    handleResendVerification,
    handleForgotPassword,
    handleResetPassword,
    signInWithGoogle,
  } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [purplePeek, setPurplePeek] = useState(false)
  const [emotion, setEmotion] = useState('idle')
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [lastResendAt, setLastResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const typingTimerRef = useRef(null)
  const transitionSwapTimerRef = useRef(null)
  const transitionEndTimerRef = useRef(null)

  const purpleRef = useRef(null)
  const blackRef = useRef(null)
  const orangeRef = useRef(null)
  const yellowRef = useRef(null)

  const [track, setTrack] = useState({
    purple: { deltaX: 80, deltaY: 60, skew: -0.5 },
    black: { deltaX: -40, deltaY: 50, skew: 0.3 },
    orange: { deltaX: 60, deltaY: 40, skew: -0.3 },
    yellow: { deltaX: -60, deltaY: 50, skew: 0.4 },
  })

  const purpleBlinking = useRandomBlink({ minMs: 3000, maxMs: 7000, blinkDuration: 170 })
  const blackBlinking = useRandomBlink({ minMs: 3400, maxMs: 7400, blinkDuration: 170 })
  const orangeBlinking = useRandomBlink({ minMs: 3600, maxMs: 7600, blinkDuration: 170 })
  const yellowBlinking = useRandomBlink({ minMs: 3900, maxMs: 7900, blinkDuration: 170 })
  const passwordVisible = showPassword && loginPassword.trim().length > 0
  const purpleHiding = loginPassword.length > 0 && !showPassword
  const engagedExpression = purpleHiding || isTyping
  const isLogin = authView === 'login'

  useEffect(() => {
    const onMouseMove = (event) => {
      const mouseX = event.clientX
      const mouseY = event.clientY

      setTrack({
        purple: getCharacterTrack(purpleRef.current, mouseX, mouseY),
        black: getCharacterTrack(blackRef.current, mouseX, mouseY),
        orange: getCharacterTrack(orangeRef.current, mouseX, mouseY),
        yellow: getCharacterTrack(yellowRef.current, mouseX, mouseY),
      })
    }

    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

  useEffect(
    () => () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      if (transitionSwapTimerRef.current) clearTimeout(transitionSwapTimerRef.current)
      if (transitionEndTimerRef.current) clearTimeout(transitionEndTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!passwordVisible) {
      return
    }

    let peekStartTimer = null
    let peekEndTimer = null
    let cancelled = false

    const schedulePeek = () => {
      peekStartTimer = setTimeout(() => {
        if (cancelled) return
        setPurplePeek(true)

        peekEndTimer = setTimeout(() => {
          if (cancelled) return
          setPurplePeek(false)
          schedulePeek()
        }, 800)
      }, randomInRange(2000, 5000))
    }

    schedulePeek()

    return () => {
      cancelled = true
      if (peekStartTimer) clearTimeout(peekStartTimer)
      if (peekEndTimer) clearTimeout(peekEndTimer)
      setPurplePeek(false)
    }
  }, [passwordVisible])

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowPassword(false)
    }, 0)

    return () => clearTimeout(timer)
  }, [authView])

  useEffect(() => {
    if (emotion === 'idle') return
    const timer = setTimeout(() => setEmotion('idle'), 2000)
    return () => clearTimeout(timer)
  }, [emotion])

  useEffect(() => {
    if (authError) {
      const timer = setTimeout(() => {
        setEmotion('error')
      }, 0)

      return () => clearTimeout(timer)
    }
  }, [authError])

  useEffect(() => {
    if (authSuccess) {
      const timer = setTimeout(() => {
        setEmotion('success')
      }, 0)

      return () => clearTimeout(timer)
    }
  }, [authSuccess])

  const triggerTypingReaction = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setIsTyping(true)
    typingTimerRef.current = setTimeout(() => {
      setIsTyping(false)
    }, 800)
  }

  const handleEmailChange = (event) => {
    setLoginEmail(event.target.value)
    if (authError) setAuthError('')
    triggerTypingReaction()
  }

  const handlePasswordChange = (event) => {
    setLoginPassword(event.target.value)
    if (authError) setAuthError('')
  }

  const handleToggleMode = () => {
    if (isTransitioning || authLoading) return

    if (transitionSwapTimerRef.current) clearTimeout(transitionSwapTimerRef.current)
    if (transitionEndTimerRef.current) clearTimeout(transitionEndTimerRef.current)

    setIsTransitioning(true)
    transitionSwapTimerRef.current = setTimeout(() => {
      setAuthView((prev) => (prev === 'login' ? 'register' : 'login'))
      setAuthError('')
      transitionSwapTimerRef.current = null

      transitionEndTimerRef.current = setTimeout(() => {
        setIsTransitioning(false)
        transitionEndTimerRef.current = null
      }, 50)
    }, 300)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!loginEmail || !loginPassword || authLoading || isTransitioning) return

    if (isLogin) {
      await handleLogin()
      return
    }

    await handleRegister()
  }

  const resendCooldownRemaining = Math.max(0, 30000 - (now - lastResendAt))

  useEffect(() => {
    if (resendCooldownRemaining <= 0) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [resendCooldownRemaining])

  const handleResendClick = async () => {
    if (resendCooldownRemaining > 0) return
    setLastResendAt(Date.now())
    setNow(Date.now())
    await handleResendVerification()
  }

  const handleBackToLogin = () => {
    setLoginPassword('')
    setPendingEmail('')
    setAuthError('')
    setAuthView('login')
  }

  const purpleForce = useMemo(() => {
    if (emotion === 'success') return { x: 0, y: 0 }
    if (emotion === 'error') return { x: 0, y: 3 }
    if (passwordVisible) return purplePeek ? { x: 5, y: 5 } : { x: -7, y: -7 }
    if (engagedExpression) return { x: 6, y: -1 }
    return null
  }, [emotion, engagedExpression, passwordVisible, purplePeek])

  const blackForce = useMemo(() => {
    if (emotion === 'success') return { x: 0, y: 0 }
    if (emotion === 'error') return { x: 0, y: 3 }
    if (passwordVisible) return { x: -6, y: -6 }
    if (engagedExpression) return { x: -6, y: -1 }
    return null
  }, [emotion, engagedExpression, passwordVisible])

  const orangeForce = useMemo(() => {
    if (emotion === 'success') return { x: 0, y: 0 }
    if (emotion === 'error') return { x: 0, y: 3 }
    if (passwordVisible) return { x: -5, y: -4 }
    if (isTyping) return { x: 2, y: -1 }
    return null
  }, [emotion, isTyping, passwordVisible])

  const yellowForce = useMemo(() => {
    if (emotion === 'success') return { x: 0, y: 0 }
    if (emotion === 'error') return { x: 0, y: 3 }
    if (passwordVisible) return { x: -4, y: -4 }
    if (isTyping) return { x: -2, y: -1 }
    return null
  }, [emotion, isTyping, passwordVisible])

  const purpleTransform =
    emotion === 'success'
      ? 'skewX(3deg)'
      : emotion === 'error'
        ? 'skewX(-2deg)'
        : passwordVisible
          ? 'skewX(-6deg)'
          : engagedExpression
            ? `skewX(${(track.purple.skew || 0) - 12}deg) translateX(40px)`
            : `skewX(${track.purple.skew}deg)`

  const blackTransform =
    emotion === 'success'
      ? 'skewX(-3deg)'
      : emotion === 'error'
        ? 'skewX(2deg)'
        : passwordVisible
          ? 'skewX(-4deg)'
          : engagedExpression
            ? `skewX(${(track.black.skew || 0) * 1.5 + 10}deg) translateX(20px)`
            : `skewX(${track.black.skew}deg)`

  const orangeSkew =
    emotion === 'success' ? 0 : emotion === 'error' ? -2 : passwordVisible ? -3 : track.orange.skew
  const yellowSkew =
    emotion === 'success' ? 0 : emotion === 'error' ? 2 : passwordVisible ? -3 : track.yellow.skew

  const orangeMouth = {
    x: passwordVisible ? -3 : clamp(track.orange.deltaX / 180, -4, 4),
    y: passwordVisible ? -1 : clamp(track.orange.deltaY / 220, -2, 2),
  }

  const yellowMouth = {
    x: passwordVisible ? -3 : clamp(track.yellow.deltaX / 120, -8, 8),
    y: passwordVisible ? -1 : clamp(track.yellow.deltaY / 160, -4, 4),
  }

  return (
    <div className={`loginPage${loginExiting ? ' lp-exiting' : ''}`}>
      <section className="lp-leftPanel">
        <div className="lp-brand">
          <div className="lp-logoBox">T</div>
          <div className="lp-brandText">TRAKER</div>
        </div>

        <div className="lp-stage">
          <Confetti active={emotion === 'success'} />
          <div
            className={`lp-characterGroup${emotion === 'success' ? ' lp-emotionSuccess' : emotion === 'error' ? ' lp-emotionError' : ''}`}
          >
            <div
              ref={purpleRef}
              className="lp-character lp-charPurple"
              style={{
                transform: purpleTransform,
                height: engagedExpression ? '530px' : '480px',
              }}
            >
              <div
                className="lp-eyeRow lp-eyeRowPurple"
                style={{
                  left: passwordVisible
                    ? '20px'
                    : engagedExpression
                      ? '55%'
                      : `calc(50% + ${clamp(track.purple.deltaX / 20, -15, 15)}px)`,
                  top: passwordVisible
                    ? '42px'
                    : engagedExpression
                      ? '78px'
                      : `${110 + clamp(track.purple.deltaY / 30, -10, 10)}px`,
                  transform: passwordVisible || engagedExpression ? 'none' : 'translateX(-50%)',
                }}
              >
                <EyeBall
                  size={18}
                  pupilSize={7}
                  maxDistance={5}
                  eyeColor={CHARACTER_COLORS.purple.eyeWhite}
                  pupilColor={CHARACTER_COLORS.purple.pupil}
                  isBlinking={purpleBlinking}
                  forceLookX={purpleForce?.x}
                  forceLookY={purpleForce?.y}
                  deltaX={track.purple.deltaX}
                  deltaY={track.purple.deltaY}
                />
                <EyeBall
                  size={18}
                  pupilSize={7}
                  maxDistance={5}
                  eyeColor={CHARACTER_COLORS.purple.eyeWhite}
                  pupilColor={CHARACTER_COLORS.purple.pupil}
                  isBlinking={purpleBlinking}
                  forceLookX={purpleForce?.x}
                  forceLookY={purpleForce?.y}
                  deltaX={track.purple.deltaX}
                  deltaY={track.purple.deltaY}
                />
              </div>
            </div>

            <div ref={blackRef} className="lp-character lp-charBlack" style={{ transform: blackTransform }}>
              <div
                className="lp-eyeRow lp-eyeRowBlack"
                style={{
                  left: passwordVisible
                    ? '10px'
                    : engagedExpression
                      ? '55%'
                      : `calc(50% + ${clamp(track.black.deltaX / 20, -12, 12)}px)`,
                  top: passwordVisible
                    ? '34px'
                    : engagedExpression
                      ? '14px'
                      : `${88 + clamp(track.black.deltaY / 30, -8, 8)}px`,
                  transform: passwordVisible || engagedExpression ? 'none' : 'translateX(-50%)',
                }}
              >
                <EyeBall
                  size={16}
                  pupilSize={6}
                  maxDistance={4}
                  eyeColor={CHARACTER_COLORS.black.eyeWhite}
                  pupilColor={CHARACTER_COLORS.black.pupil}
                  isBlinking={blackBlinking}
                  forceLookX={blackForce?.x}
                  forceLookY={blackForce?.y}
                  deltaX={track.black.deltaX}
                  deltaY={track.black.deltaY}
                />
                <EyeBall
                  size={16}
                  pupilSize={6}
                  maxDistance={4}
                  eyeColor={CHARACTER_COLORS.black.eyeWhite}
                  pupilColor={CHARACTER_COLORS.black.pupil}
                  isBlinking={blackBlinking}
                  forceLookX={blackForce?.x}
                  forceLookY={blackForce?.y}
                  deltaX={track.black.deltaX}
                  deltaY={track.black.deltaY}
                />
              </div>
            </div>

            <div ref={orangeRef} className="lp-character lp-charOrange" style={{ transform: `skewX(${orangeSkew}deg)` }}>
              <div
                className="lp-eyeRow lp-eyeRowOrange"
                style={{
                  left: passwordVisible ? '50px' : `calc(50% + ${clamp(track.orange.deltaX / 18, -14, 14)}px)`,
                  top: passwordVisible ? '102px' : `${100 + clamp(track.orange.deltaY / 25, -8, 8)}px`,
                  transform: passwordVisible ? 'none' : 'translateX(-50%)',
                }}
              >
                <div className="lp-pupilSocket">
                  <Pupil
                    size={12}
                    maxDistance={4}
                    pupilColor={CHARACTER_COLORS.orange.pupil}
                    forceLookX={orangeForce?.x}
                    forceLookY={orangeForce?.y}
                    deltaX={track.orange.deltaX}
                    deltaY={track.orange.deltaY}
                    isBlinking={orangeBlinking}
                    emotion={emotion}
                  />
                </div>
                <div className="lp-pupilSocket">
                  <Pupil
                    size={12}
                    maxDistance={4}
                    pupilColor={CHARACTER_COLORS.orange.pupil}
                    forceLookX={orangeForce?.x}
                    forceLookY={orangeForce?.y}
                    deltaX={track.orange.deltaX}
                    deltaY={track.orange.deltaY}
                    isBlinking={orangeBlinking}
                    emotion={emotion}
                  />
                </div>
              </div>

              <div
                className="lp-mouth lp-mouthOrange"
                style={{
                  transform: `translate(calc(-50% + ${orangeMouth.x}px), ${orangeMouth.y}px)`,
                }}
              />
            </div>

            <div ref={yellowRef} className="lp-character lp-charYellow" style={{ transform: `skewX(${yellowSkew}deg)` }}>
              <div
                className="lp-eyeRow lp-eyeRowYellow"
                style={{
                  left: passwordVisible ? '20px' : `calc(50% + ${clamp(track.yellow.deltaX / 18, -12, 12)}px)`,
                  top: passwordVisible ? '42px' : `${85 + clamp(track.yellow.deltaY / 25, -6, 6)}px`,
                  transform: passwordVisible ? 'none' : 'translateX(-50%)',
                }}
              >
                <div className="lp-pupilSocket">
                  <Pupil
                    size={12}
                    maxDistance={3.6}
                    pupilColor={CHARACTER_COLORS.yellow.pupil}
                    forceLookX={yellowForce?.x}
                    forceLookY={yellowForce?.y}
                    deltaX={track.yellow.deltaX}
                    deltaY={track.yellow.deltaY}
                    isBlinking={yellowBlinking}
                    emotion={emotion}
                  />
                </div>
                <div className="lp-pupilSocket">
                  <Pupil
                    size={12}
                    maxDistance={3.6}
                    pupilColor={CHARACTER_COLORS.yellow.pupil}
                    forceLookX={yellowForce?.x}
                    forceLookY={yellowForce?.y}
                    deltaX={track.yellow.deltaX}
                    deltaY={track.yellow.deltaY}
                    isBlinking={yellowBlinking}
                    emotion={emotion}
                  />
                </div>
              </div>

              <div
                className="lp-mouth"
                style={{ transform: `translate(calc(-50% + ${yellowMouth.x}px), ${yellowMouth.y}px)` }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="lp-rightPanel">
        <div className={`lp-formWrap ${isTransitioning ? 'lp-formFading' : ''}`}>
          <div className="lp-brand lp-mobileBrand">
            <div className="lp-logoBox">T</div>
            <div className="lp-brandText lp-brandTextDark">TRAKER</div>
          </div>

          {(isLogin || authView === 'register') && (
            <div>
              <h1 className="lp-heading">{isLogin ? 'Welcome back!' : 'Create account'}</h1>
              <p className="lp-subtitle">Please enter your details</p>
            </div>
          )}

          {authView === 'verify-email' && (
            <>
              <div>
                <h1 className="lp-heading">Check your email</h1>
                <p className="lp-subtitle">
                  We sent a confirmation link to <strong>{pendingEmail}</strong>. Click the link to activate your account, then come back here to log in.
                </p>
              </div>
              <div className="lp-form">
                <button
                  className="lp-toggleBtn"
                  type="button"
                  onClick={handleResendClick}
                  disabled={resendCooldownRemaining > 0}
                >
                  {resendCooldownRemaining > 0
                    ? `Resend available in ${Math.ceil(resendCooldownRemaining / 1000)}s`
                    : "Didn't get it? Resend email"}
                </button>
                <button
                  className="lp-toggleBtn"
                  type="button"
                  onClick={handleBackToLogin}
                >
                  ← Back to Login
                </button>
              </div>
            </>
          )}

          {authView === 'verify-email-error' && (
            <>
              <div>
                <h1 className="lp-heading">Verification failed</h1>
                <p className="lp-subtitle">
                  {authError || 'This verification link is invalid or has expired.'}
                </p>
              </div>
              <div className="lp-form">
                {pendingEmail && (
                  <button
                    className="lp-toggleBtn"
                    type="button"
                    onClick={handleResendClick}
                    disabled={resendCooldownRemaining > 0}
                  >
                    {resendCooldownRemaining > 0
                      ? `Resend available in ${Math.ceil(resendCooldownRemaining / 1000)}s`
                      : 'Send a new verification email'}
                  </button>
                )}
                <button
                  className="lp-toggleBtn"
                  type="button"
                  onClick={handleBackToLogin}
                >
                  ← Back to Login
                </button>
              </div>
            </>
          )}

          {authView === 'forgot-password' && (
            <>
              <div>
                <h1 className="lp-heading">Reset password</h1>
                <p className="lp-subtitle">Enter your email and we'll send you a reset link.</p>
              </div>
              <form
                className="lp-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!loginEmail || authLoading) return
                  handleForgotPassword(loginEmail)
                }}
              >
                <div className="lp-field">
                  <label className="lp-label" htmlFor="lp-forgot-email">Email</label>
                  <input
                    id="lp-forgot-email"
                    className="lp-input"
                    type="email"
                    autoComplete="email"
                    value={loginEmail}
                    onChange={handleEmailChange}
                    placeholder="you@example.com"
                  />
                </div>
                {authError && <div className="lp-error">{authError}</div>}
                <button
                  className="lp-submitBtn"
                  type="submit"
                  disabled={authLoading || !loginEmail}
                >
                  {authLoading ? 'Sending…' : 'Send reset link'}
                </button>
                <button
                  className="lp-toggleBtn"
                  type="button"
                  onClick={handleBackToLogin}
                >
                  ← Back to Login
                </button>
              </form>
            </>
          )}

          {authView === 'forgot-sent' && (
            <>
              <div>
                <h1 className="lp-heading">Check your email</h1>
                <p className="lp-subtitle">
                  We sent a password reset link to <strong>{pendingEmail}</strong>. Click the link in the email to set a new password.
                </p>
              </div>
              <div className="lp-form">
                <button
                  className="lp-toggleBtn"
                  type="button"
                  onClick={handleBackToLogin}
                >
                  ← Back to Login
                </button>
              </div>
            </>
          )}

          {authView === 'reset-password' && (
            <>
              <div>
                <h1 className="lp-heading">Set new password</h1>
                <p className="lp-subtitle">Enter your new password below.</p>
              </div>
              <form
                className="lp-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!loginPassword || authLoading) return
                  handleResetPassword(loginPassword)
                }}
              >
                <div className="lp-field">
                  <label className="lp-label" htmlFor="lp-new-password">New password</label>
                  <div className="lp-passwordWrap">
                    <input
                      id="lp-new-password"
                      className="lp-input lp-passwordInput"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={loginPassword}
                      onChange={handlePasswordChange}
                      placeholder="At least 8 characters with letters and digits"
                    />
                    <button
                      className="lp-passwordToggle"
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? (
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      ) : (
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                {authError && <div className="lp-error">{authError}</div>}
                <button
                  className="lp-submitBtn"
                  type="submit"
                  disabled={authLoading || !loginPassword}
                >
                  {authLoading ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </>
          )}

          {(isLogin || authView === 'register') && (
          <form className="lp-form" onSubmit={handleSubmit}>
            <div className="lp-field">
              <label className="lp-label" htmlFor="lp-email">Email</label>
              <input
                id="lp-email"
                className="lp-input"
                type="email"
                autoComplete="email"
                value={loginEmail}
                onFocus={triggerTypingReaction}
                onChange={handleEmailChange}
                placeholder="you@example.com"
              />
            </div>

            <div className="lp-field">
              <label className="lp-label" htmlFor="lp-password">Password</label>
              <div className="lp-passwordWrap">
                <input
                  id="lp-password"
                  className="lp-input lp-passwordInput"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  value={loginPassword}
                  onChange={handlePasswordChange}
                  placeholder="Password"
                />
                <button
                  className="lp-passwordToggle"
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
              </div>
              {isLogin && (
                <button
                  className="lp-forgotLink"
                  type="button"
                  onClick={() => {
                    setAuthError('')
                    setAuthView('forgot-password')
                  }}
                  disabled={authLoading}
                >
                  Forgot password?
                </button>
              )}
            </div>

            {authError && <div className="lp-error">{authError}</div>}

            <button className="lp-submitBtn" type="submit" disabled={authLoading || authSuccess || loginExiting || !loginEmail || !loginPassword}>
              {authSuccess || loginExiting
                ? "✓"
                : authLoading
                  ? (isLogin ? "Logging in…" : "Creating account…")
                  : (isLogin ? "Log in" : "Register")}
            </button>

            <div className="lp-divider">
              <span className="lp-dividerText">or</span>
            </div>

            <button
              className="lp-googleBtn"
              type="button"
              onClick={signInWithGoogle}
              disabled={authLoading || authSuccess || loginExiting}
            >
              <GoogleIcon />
              <span>Continue with Google</span>
            </button>

            <button className="lp-toggleBtn" type="button" onClick={handleToggleMode} disabled={authLoading || isTransitioning}>
              <span className="lp-togglePrefix">
                {isLogin ? "Don't have an account? " : 'Already have an account? '}
              </span>
              <span className="lp-toggleAction">
                {isLogin ? 'Sign up' : 'Log in'}
              </span>
            </button>
          </form>
          )}
        </div>
      </section>
    </div>
  )
}

export default LoginPage
