import { useEffect, useRef } from 'react'
import { getFocusableElements, trapFocusWithin } from '../utils'

function ExtensionPromptModal({
  show,
  dontShowAgain,
  onChangeDontShowAgain,
  onGetExtension,
  onSkip,
  onDismiss,
}) {
  const modalRef = useRef(null)

  useEffect(() => {
    if (!show) return undefined

    const previousActiveElement = document.activeElement
    const focusableElements = getFocusableElements(modalRef.current)
    const nextFocusTarget = focusableElements[0] || modalRef.current
    if (nextFocusTarget instanceof HTMLElement) nextFocusTarget.focus()

    return () => {
      if (previousActiveElement instanceof HTMLElement) previousActiveElement.focus()
    }
  }, [show])

  if (!show) return null

  return (
    <div
      className="extPromptOverlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="extPromptModal card"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-prompt-title"
        aria-describedby="ext-prompt-description"
        tabIndex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDismiss()
            return
          }
          trapFocusWithin(e, modalRef.current)
        }}
      >
        <h3 id="ext-prompt-title">Use Traker Extension?</h3>
        <p id="ext-prompt-description">Install our Chrome extension for more accurate price tracking with a visual picker.</p>

        <label className="extPromptCheck">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => onChangeDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>

        <div className="extPromptActions">
          <button className="primaryBtn" type="button" onClick={onGetExtension}>
            Get Extension
          </button>
          <button className="secondaryBtn" type="button" onClick={onSkip}>
            Skip, use automatic detection
          </button>
        </div>
      </div>
    </div>
  )
}

export default ExtensionPromptModal
