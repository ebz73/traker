import { useCallback, useState } from 'react'
import { DEFAULT_FREQUENCY } from '../constants'
import { useToast } from './useToast'

// Stateful single-use hook: call once at the app root and pass values down.
// Phase 4 design decision #1 (Option A): the form is decoupled from
// useProducts. validate() returns null on failure (after showing the error
// toast and setting the visual error flag), or a payload on success. The
// caller orchestrates: const payload = form.validate(); if (!payload) return;
// const result = await products.addProduct(payload); if (result.ok) form.reset()
export function useAddProductForm() {
  const { showToast } = useToast()

  const [url, setUrl] = useState('')
  const [threshold, setThreshold] = useState('')
  const [frequency, setFrequency] = useState(DEFAULT_FREQUENCY)
  const [errors, setErrors] = useState({ url: false, threshold: false })

  const validate = useCallback(() => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setErrors((prev) => ({ ...prev, url: true }))
      showToast('Please enter a product URL.', 'error')
      return null
    }
    setErrors((prev) => ({ ...prev, url: false }))

    const parsedThreshold = threshold === '' ? '' : Number(threshold)
    if (parsedThreshold !== '' && Number.isNaN(parsedThreshold)) {
      setErrors((prev) => ({ ...prev, threshold: true }))
      showToast('Threshold must be a valid number.', 'error')
      return null
    }
    setErrors((prev) => ({ ...prev, threshold: false }))

    return { url: trimmedUrl, threshold: parsedThreshold, frequency }
  }, [frequency, showToast, threshold, url])

  const reset = useCallback(() => {
    setUrl('')
    setThreshold('')
    setFrequency(DEFAULT_FREQUENCY)
  }, [])

  return {
    url,
    setUrl,
    threshold,
    setThreshold,
    frequency,
    setFrequency,
    errors,
    setErrors,
    validate,
    reset,
  }
}
