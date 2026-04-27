import { useId } from 'react'
import { CHARACTER_AVATARS } from '../constants'

function MiniCharacter({ name, size = 40 }) {
  const char = CHARACTER_AVATARS[name] || CHARACTER_AVATARS.purple
  const clipId = `${useId()}-${name}-${size}`.replace(/:/g, '')
  const backdrop = name === 'black' ? '#efeef5' : '#f7f4ff'

  const body =
    char.shape === 'rect' ? (
      <path
        d="M7 40V15c0-4.4 3.6-8 8-8h10c4.4 0 8 3.6 8 8v25H7z"
        fill={char.bg}
      />
    ) : name === 'yellow' ? (
      <path
        d="M8 40V24c0-7.6 5.4-12.5 12-12.5S32 16.4 32 24v16H8z"
        fill={char.bg}
      />
    ) : (
      <path
        d="M3 40V28c0-9.5 7.6-17.2 17-17.2S37 18.5 37 28v12H3z"
        fill={char.bg}
      />
    )

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="40" height="40" fill={backdrop} />
        {body}

        {char.eyeWhite ? (
          <>
            <circle cx="14" cy="20" r="4.6" fill={char.eyeWhite} />
            <circle cx="14" cy="20" r="1.9" fill={char.pupil} />
            <circle cx="26" cy="20" r="4.6" fill={char.eyeWhite} />
            <circle cx="26" cy="20" r="1.9" fill={char.pupil} />
          </>
        ) : (
          <>
            <circle cx="14.2" cy="20.4" r="2.25" fill={char.pupil} />
            <circle cx="25.8" cy="20.4" r="2.25" fill={char.pupil} />
          </>
        )}

        {char.hasMouth && (
          <rect x="15" y="27.2" width="10" height="1.7" rx="0.85" fill="#2d2d2d" />
        )}
      </g>
    </svg>
  )
}

export default MiniCharacter
