// Returns a boolean that flips to true briefly at random intervals, intended
// to drive eye-blink animations on character avatars.
//
// Extracted in Phase 1 of the App.jsx refactor — previously duplicated in
// LoginPage.jsx and AnimatedProfileAvatar.jsx with slightly different defaults.
//
//   - AnimatedProfileAvatar called useRandomBlink() with no args → defaults:
//       minMs=2500, maxMs=6000, blinkDuration=150
//   - LoginPage called useRandomBlink(min, max) and relied on a local default
//       blinkDurationMs=170. Those call sites now pass blinkDuration: 170
//       explicitly when they need the longer blink.
//
// Sub-millisecond rounding behavior of the prior LoginPage `randomInRange`
// integer-floor formula is collapsed into the continuous Math.random() form;
// the difference is below perception threshold and below setTimeout granularity.
import { useEffect, useState } from 'react'

export function useRandomBlink({ minMs = 2500, maxMs = 6000, blinkDuration = 150 } = {}) {
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
