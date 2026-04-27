// Top-level constants shared across the app. Extracted from App.jsx in Phase 1
// of the App.jsx refactor (see frontend/.refactor-log.md).

export const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
export const STORAGE_KEY = 'price_tracker_products_v3'
export const DEFAULT_FREQUENCY = '24h'
export const DEFAULT_CURRENCY_CODE = 'USD'
export const DAY_IN_MS = 24 * 60 * 60 * 1000

export const SCRAPE_STATUS_POLL_INTERVAL_MS = 2000
export const SCRAPE_STATUS_MAX_ATTEMPTS = 15
export const EXT_PING_INTERVAL_MS = 300
export const EXT_PING_MAX_ATTEMPTS = 7
export const PICK_ACK_TIMEOUT_MS = 4000
export const PICK_START_TIMEOUT_MS = 90000
export const PICK_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000

export const FREQUENCIES = [
  { value: '6h', label: 'Every 6 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: '24h', label: 'Daily' },
  { value: '7d', label: 'Weekly' },
  { value: '30d', label: 'Monthly' },
]

export const HISTORY_WINDOWS = [30, 60, 90, 120]
export const FREQUENCY_VALUES = new Set(FREQUENCIES.map((f) => f.value))
export const EMPTY_HISTORY = []

export const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  JPY: '¥',
  INR: '₹',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  NZD: 'NZ$',
  CHF: 'CHF',
  CNY: 'CN¥',
  HKD: 'HK$',
  SGD: 'S$',
}

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// Single source of truth for the four character colors. Each consumer
// (App's CHARACTER_AVATARS, AnimatedProfileAvatar's CHARACTERS, LoginPage's
// inline pupilColor props, confetti palettes) keeps its own per-component
// extras (shape, eyeStyle, backdrop, mouthColor) but references these for the
// colors themselves.
export const CHARACTER_COLORS = {
  purple: { bg: '#6c3ff5', pupil: '#252525', eyeWhite: '#FFFFFF' },
  black: { bg: '#2d2d2d', pupil: '#1D1D1D', eyeWhite: '#FFFFFF' },
  orange: { bg: '#ff9b6b', pupil: '#3A2B24' },
  yellow: { bg: '#e8d754', pupil: '#3A3420' },
}

export const CHARACTER_AVATARS = {
  purple: {
    bg: CHARACTER_COLORS.purple.bg,
    eyeWhite: CHARACTER_COLORS.purple.eyeWhite,
    pupil: CHARACTER_COLORS.purple.pupil,
    shape: 'rect',
    hasMouth: false,
  },
  black: {
    bg: CHARACTER_COLORS.black.bg,
    eyeWhite: CHARACTER_COLORS.black.eyeWhite,
    pupil: CHARACTER_COLORS.black.pupil,
    shape: 'rect',
    hasMouth: false,
  },
  orange: {
    bg: CHARACTER_COLORS.orange.bg,
    eyeWhite: null,
    pupil: CHARACTER_COLORS.orange.pupil,
    shape: 'dome',
    hasMouth: true,
  },
  yellow: {
    bg: CHARACTER_COLORS.yellow.bg,
    eyeWhite: null,
    pupil: CHARACTER_COLORS.yellow.pupil,
    shape: 'dome',
    hasMouth: true,
  },
}

export const PROFILE_AVATAR_NAMES = ['purple', 'black', 'orange', 'yellow']
