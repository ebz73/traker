import './ToggleSkeleton.css'
import Skeleton from './Skeleton'

export default function ToggleSkeleton() {
  return (
    <span className="toggleSkeleton" aria-busy="true" aria-label="Loading toggle">
      <Skeleton width="18px" height="18px" radius="4px" />
      <Skeleton variant="text" width="32px" height="14px" />
    </span>
  )
}
