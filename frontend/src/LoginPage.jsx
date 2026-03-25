import { useEffect, useMemo, useRef, useState } from 'react'
import './LoginPage.css'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const randomInRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const pseudoRandom = (seed) => {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

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

function useRandomBlink(minMs, maxMs, blinkDurationMs = 170) {
  const [isBlinking, setIsBlinking] = useState(false)

  useEffect(() => {
    let blinkTimer = null
    let openTimer = null
    let cancelled = false

    const scheduleNext = () => {
      const nextIn = randomInRange(minMs, maxMs)
      blinkTimer = setTimeout(() => {
        if (cancelled) return
        setIsBlinking(true)
        openTimer = setTimeout(() => {
          if (cancelled) return
          setIsBlinking(false)
          scheduleNext()
        }, blinkDurationMs)
      }, nextIn)
    }

    scheduleNext()

    return () => {
      cancelled = true
      if (blinkTimer) clearTimeout(blinkTimer)
      if (openTimer) clearTimeout(openTimer)
    }
  }, [blinkDurationMs, maxMs, minMs])

  return isBlinking
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

    const colors = ['#6c3ff5', '#ff9b6b', '#e8d754', '#2d2d2d', '#ff4d8d', '#4dc9f6', '#f5f5f5']

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

function LoginPage({
  authView,
  setAuthView,
  loginEmail,
  setLoginEmail,
  loginPassword,
  setLoginPassword,
  authError,
  setAuthError,
  authLoading,
  authSuccess,
  handleLogin,
  handleRegister,
}) {
  const [showPassword, setShowPassword] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [purplePeek, setPurplePeek] = useState(false)
  const [emotion, setEmotion] = useState('idle')
  const [isTransitioning, setIsTransitioning] = useState(false)
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

  const purpleBlinking = useRandomBlink(3000, 7000)
  const blackBlinking = useRandomBlink(3400, 7400)
  const orangeBlinking = useRandomBlink(3600, 7600)
  const yellowBlinking = useRandomBlink(3900, 7900)
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
    <div className="loginPage">
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
                  eyeColor="#FFFFFF"
                  pupilColor="#252525"
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
                  eyeColor="#FFFFFF"
                  pupilColor="#252525"
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
                  eyeColor="#FFFFFF"
                  pupilColor="#1D1D1D"
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
                  eyeColor="#FFFFFF"
                  pupilColor="#1D1D1D"
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
                    pupilColor="#3A2B24"
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
                    pupilColor="#3A2B24"
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
                    pupilColor="#3A3420"
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
                    pupilColor="#3A3420"
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

          <div>
            <h1 className="lp-heading">{isLogin ? 'Welcome back!' : 'Create account'}</h1>
            <p className="lp-subtitle">Please enter your details</p>
          </div>

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
            </div>

            {authError && <div className="lp-error">{authError}</div>}

            <button className="lp-submitBtn" type="submit" disabled={authLoading || !loginEmail || !loginPassword}>
              {authLoading ? 'Please wait...' : isLogin ? 'Log in' : 'Register'}
            </button>

            <button className="lp-toggleBtn" type="button" onClick={handleToggleMode} disabled={authLoading || isTransitioning}>
              <span className="lp-togglePrefix">
                {isLogin ? "Don't have an account? " : 'Already have an account? '}
              </span>
              <span className="lp-toggleAction">
                {isLogin ? 'Sign Up' : 'Log in'}
              </span>
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}

export default LoginPage
