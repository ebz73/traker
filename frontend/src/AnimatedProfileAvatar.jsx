import { useEffect, useMemo, useRef, useState } from 'react'
import './AnimatedProfileAvatar.css'

const CHARACTERS = {
  purple: {
    bg: '#6c3ff5',
    bodyShape: 'rect',
    eyeStyle: 'eyeball',
    eyeWhite: '#FFFFFF',
    pupilColor: '#252525',
    backdrop: '#efeef5',
    mouthColor: 'rgba(255,255,255,0.55)',
  },
  black: {
    bg: '#2d2d2d',
    bodyShape: 'rect',
    eyeStyle: 'eyeball',
    eyeWhite: '#FFFFFF',
    pupilColor: '#1D1D1D',
    backdrop: '#efeef5',
    mouthColor: 'rgba(255,255,255,0.5)',
  },
  orange: {
    bg: '#ff9b6b',
    bodyShape: 'dome',
    eyeStyle: 'dot',
    pupilColor: '#3A2B24',
    backdrop: '#fff0e8',
    mouthColor: '#3A2B24',
  },
  yellow: {
    bg: '#e8d754',
    bodyShape: 'dome',
    eyeStyle: 'dot',
    pupilColor: '#3A3420',
    backdrop: '#fdf8e0',
    mouthColor: '#3A3420',
  },
}

function useRandomBlink(minMs = 2500, maxMs = 6000, blinkDuration = 150) {
  const [isBlinking, setIsBlinking] = useState(false)

  useEffect(() => {
    let blinkTimer = null
    let openTimer = null
    let cancelled = false

    const scheduleNext = () => {
      const nextIn = minMs + Math.random() * (maxMs - minMs)
      blinkTimer = window.setTimeout(() => {
        if (cancelled) return
        setIsBlinking(true)
        openTimer = window.setTimeout(() => {
          if (cancelled) return
          setIsBlinking(false)
          scheduleNext()
        }, blinkDuration)
      }, nextIn)
    }

    scheduleNext()

    return () => {
      cancelled = true
      window.clearTimeout(blinkTimer)
      window.clearTimeout(openTimer)
    }
  }, [blinkDuration, maxMs, minMs])

  return isBlinking
}

function AnimatedProfileAvatar({ name, size = 40 }) {
  const avatar = CHARACTERS[name] || CHARACTERS.purple
  const avatarRef = useRef(null)
  const frameRef = useRef(0)
  const idleFrameRef = useRef(0)
  const latestMouseRef = useRef(null)
  const offsetRef = useRef({ x: 0, y: 0 })
  const hasMouseMoved = useRef(false)
  const lastMouseMove = useRef(0)
  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 })
  const isBlinking = useRandomBlink()

  const metrics = useMemo(() => {
    const maxDistance = size * 0.07
    const bodyWidth = avatar.bodyShape === 'rect' ? size * 0.8 : size * 0.92
    const bodyHeight = avatar.bodyShape === 'rect' ? size * 0.74 : size * 0.68
    const bodyOverhang = size * 0.04
    const eyeTop = avatar.bodyShape === 'rect' ? size * 0.42 : size * 0.44
    const eyeGap = size * 0.1
    const eyeballSize = size * 0.22
    const dotSize = size * 0.12
    const pupilSize = size * 0.1
    const mouthWidth = avatar.bodyShape === 'rect' ? size * 0.28 : size * 0.26
    const mouthHeight = size * 0.08
    const mouthBottom = avatar.bodyShape === 'rect' ? size * 0.16 : size * 0.18
    const smileThickness = Math.max(1.5, size * 0.05)
    const blinkHeight = 2
    const eyeSocketSize = Math.max(eyeballSize, dotSize) + maxDistance * 2 + 2

    return {
      maxDistance,
      bodyWidth,
      bodyHeight,
      bodyOverhang,
      eyeTop,
      eyeGap,
      eyeballSize,
      dotSize,
      pupilSize,
      mouthWidth,
      mouthHeight,
      mouthBottom,
      smileThickness,
      blinkHeight,
      eyeSocketSize,
    }
  }, [avatar.bodyShape, size])

  useEffect(() => {
    const startTime = performance.now()
    const idleThreshold = 3000
    const maxDrift = size * 0.04

    const animateIdle = (timestamp) => {
      const isIdle =
        !hasMouseMoved.current || performance.now() - lastMouseMove.current > idleThreshold

      if (isIdle) {
        const t = (timestamp - startTime) / 1000
        const nextOffset = {
          x: Math.sin(t * 0.6) * maxDrift,
          y: Math.sin(t * 0.4) * maxDrift * 0.6,
        }
        const previous = offsetRef.current

        if (
          Math.abs(previous.x - nextOffset.x) >= 0.01 ||
          Math.abs(previous.y - nextOffset.y) >= 0.01
        ) {
          offsetRef.current = nextOffset
          setPupilOffset(nextOffset)
        }
      }

      idleFrameRef.current = window.requestAnimationFrame(animateIdle)
    }

    idleFrameRef.current = window.requestAnimationFrame(animateIdle)

    return () => {
      if (idleFrameRef.current) {
        window.cancelAnimationFrame(idleFrameRef.current)
      }
    }
  }, [size])

  useEffect(() => {
    const updateOffset = () => {
      frameRef.current = 0

      if (!avatarRef.current || !latestMouseRef.current) return

      const rect = avatarRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const dx = latestMouseRef.current.x - centerX
      const dy = latestMouseRef.current.y - centerY
      const angle = Math.atan2(dy, dx)
      const distance = Math.min(Math.sqrt(dx * dx + dy * dy), metrics.maxDistance)
      const nextOffset = {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
      }

      const previous = offsetRef.current
      if (
        Math.abs(previous.x - nextOffset.x) < 0.01 &&
        Math.abs(previous.y - nextOffset.y) < 0.01
      ) {
        return
      }

      offsetRef.current = nextOffset
      setPupilOffset(nextOffset)
    }

    const onMouseMove = (event) => {
      hasMouseMoved.current = true
      lastMouseMove.current = performance.now()
      latestMouseRef.current = { x: event.clientX, y: event.clientY }
      if (!frameRef.current) {
        frameRef.current = window.requestAnimationFrame(updateOffset)
      }
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [metrics.maxDistance])

  const wrapStyle = {
    width: size,
    height: size,
  }

  const bodyStyle = {
    background: avatar.backdrop,
  }

  const bodyShapeStyle = {
    width: metrics.bodyWidth,
    height: metrics.bodyHeight,
    background: avatar.bg,
    '--apa-body-overhang': `${metrics.bodyOverhang}px`,
  }

  const eyeRowStyle = {
    top: metrics.eyeTop,
    gap: metrics.eyeGap,
  }

  const eyeSocketStyle = {
    width: metrics.eyeSocketSize,
    height: metrics.eyeSocketSize,
  }

  const pupilTransform = `translate(${pupilOffset.x}px, ${pupilOffset.y}px)`

  const mouthStyle = {
    width: metrics.mouthWidth,
    height: metrics.mouthHeight,
    bottom: metrics.mouthBottom,
    borderBottom: `${metrics.smileThickness}px solid ${avatar.mouthColor}`,
  }

  return (
    <div className="apa-wrap" ref={avatarRef} style={wrapStyle} aria-hidden="true">
      <div className={`apa-body apa-body--${name}`} style={bodyStyle}>
        <div
          className={`apa-bodyShape apa-bodyShape--${avatar.bodyShape}`}
          style={bodyShapeStyle}
        />

        <div className="apa-eyeRow" style={eyeRowStyle}>
          {[0, 1].map((eyeIndex) => (
            <div key={eyeIndex} className="apa-eyeSocket" style={eyeSocketStyle}>
              {avatar.eyeStyle === 'eyeball' ? (
                <div
                  className={`apa-eyeball${isBlinking ? ' apa-eyeball--blink' : ''}`}
                  style={{
                    width: metrics.eyeballSize,
                    height: isBlinking ? metrics.blinkHeight : metrics.eyeballSize,
                    background: avatar.eyeWhite,
                  }}
                >
                  <div
                    className="apa-pupil"
                    style={{
                      width: metrics.pupilSize,
                      height: metrics.pupilSize,
                      background: avatar.pupilColor,
                      transform: pupilTransform,
                      opacity: isBlinking ? 0 : 1,
                    }}
                  />
                </div>
              ) : (
                <div
                  className={`apa-dotEye${isBlinking ? ' apa-dotEye--blink' : ''}`}
                  style={{
                    width: metrics.dotSize,
                    height: isBlinking ? metrics.blinkHeight : metrics.dotSize,
                    background: avatar.pupilColor,
                    transform: pupilTransform,
                  }}
                />
              )}
            </div>
          ))}
        </div>

        <div className="apa-mouth" style={mouthStyle} />
      </div>
    </div>
  )
}

export default AnimatedProfileAvatar
