import { useEffect, useRef, useState } from 'react'
import AnimatedProfileAvatar from '../AnimatedProfileAvatar'
import { PROFILE_AVATAR_NAMES } from '../constants'
import { useAuth } from '../hooks/useAuth'
import { useThemeContext } from '../context/ThemeContext'
import { trapFocusWithin } from '../utils'

// Phase 5 design decision (Option A): consumes useAuth + useThemeContext directly
// rather than receiving values as props. Single-use component; testability
// argument for prop-passing is theoretical without a test suite.
//
// Logout cleanup is handled by unmount: AppShell early-returns to LoginPage on
// !authToken, so this component (and its profileOpen state) is destroyed. No
// useEffect-based reset needed — do NOT add one back.
export default function ProfileDropdown() {
  const { authEmail, clearAuth, deleteAccount } = useAuth()
  const { theme, toggleTheme, avatarChar, changeAvatar } = useThemeContext()

  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef(null)

  const handleProfileWrapKeyDown = (event) => {
    if (event.key === 'Escape' && profileOpen) {
      event.preventDefault()
      setProfileOpen(false)
      profileRef.current?.querySelector('.profileBtn')?.focus()
      return
    }

    if (profileOpen) {
      trapFocusWithin(event, profileRef.current)
    }
  }

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="profileWrap" ref={profileRef} onKeyDown={handleProfileWrapKeyDown}>
      <button
        className="profileBtn"
        onClick={() => setProfileOpen((prev) => !prev)}
        aria-label="Profile menu"
        aria-expanded={profileOpen}
        type="button"
      >
        <AnimatedProfileAvatar name={avatarChar} size={38} />
      </button>

      {profileOpen && (
        <div className="profileDropdown">
          <div className="profileDropdownEmail">{authEmail}</div>

          <div className="profileDropdownDivider" />

          <div className="profileDropdownLabel">Choose Avatar</div>
          <div className="avatarPicker">
            {PROFILE_AVATAR_NAMES.map((charName) => (
              <button
                key={charName}
                className={`avatarOption${avatarChar === charName ? ' avatarOptionActive' : ''}`}
                onClick={() => changeAvatar(charName)}
                aria-label={`Select ${charName} avatar`}
                type="button"
              >
                <AnimatedProfileAvatar name={charName} size={36} />
              </button>
            ))}
          </div>

          <div className="profileDropdownDivider" />

          <button
            className="themeToggleBtn"
            onClick={toggleTheme}
            type="button"
          >
            {theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode'}
          </button>

          <div className="profileDropdownDivider" />

          <button
            className="profileDropdownDelete"
            onClick={() => {
              deleteAccount()
            }}
            type="button"
          >
            Delete Account
          </button>

          <button
            className="profileDropdownLogout"
            onClick={() => {
              clearAuth()
              setProfileOpen(false)
            }}
            type="button"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  )
}
