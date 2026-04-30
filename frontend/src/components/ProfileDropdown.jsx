import { useEffect, useRef, useState } from 'react'
import AnimatedProfileAvatar from '../AnimatedProfileAvatar'
import { PROFILE_AVATAR_NAMES } from '../constants'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import { useThemeContext } from '../context/ThemeContext'
import { trapFocusWithin } from '../utils'
import ConfirmDialog from './ConfirmDialog'

// Phase 5 design decision (Option A): consumes useAuth + useThemeContext directly
// rather than receiving values as props. Single-use component; testability
// argument for prop-passing is theoretical without a test suite.
//
// Logout cleanup is handled by unmount: AppShell early-returns to LoginPage on
// !authToken, so this component (and its profileOpen state) is destroyed. No
// useEffect-based reset needed — do NOT add one back.
export default function ProfileDropdown() {
  const { authEmail, signOut, deleteAccount } = useAuth()
  const { avatarChar, changeAvatar } = useThemeContext()

  const [profileOpen, setProfileOpen] = useState(false)
  const [showDeleteAccountConfirm, setShowDeleteAccountConfirm] = useState(false)
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

          <ThemeToggle />

          <div className="profileDropdownDivider" />

          <button
            className="profileDropdownDelete"
            onClick={() => setShowDeleteAccountConfirm(true)}
            type="button"
          >
            Delete Account
          </button>

          <button
            className="profileDropdownLogout"
            onClick={() => {
              setProfileOpen(false)
              signOut()
            }}
            type="button"
          >
            Log out
          </button>
        </div>
      )}

      <ConfirmDialog
        open={showDeleteAccountConfirm}
        onOpenChange={setShowDeleteAccountConfirm}
        title="Delete account permanently?"
        description="This will permanently remove your account, all tracked products, price history, and settings. This action cannot be undone."
        confirmText="Delete Account"
        cancelText="Cancel"
        destructive
        onConfirm={deleteAccount}
      />
    </div>
  )
}
