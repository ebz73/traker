import './StatCardSkeleton.css'
import Skeleton from './Skeleton'

export default function StatCardSkeleton() {
  return (
    <div className="card statCardSkeleton" aria-busy="true" aria-label="Loading stats">
      <Skeleton width="120px" height="20px" />
      <Skeleton width="140px" height="18px" />
    </div>
  )
}
