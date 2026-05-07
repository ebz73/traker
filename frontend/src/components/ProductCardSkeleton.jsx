import './ProductCardSkeleton.css'
import Skeleton from './Skeleton'

export default function ProductCardSkeleton() {
  return (
    <article
      className="card productCard productCardSkeleton"
      aria-busy="true"
      aria-label="Loading product"
    >
      <div className="productHead">
        <div className="productCardSkeletonTitleBlock">
          <Skeleton width="65%" height="22px" />
          <Skeleton width="92px" height="22px" radius="99px" />
          <Skeleton width="110px" height="16px" />
          <Skeleton width="220px" height="14px" />
        </div>
        <div className="productHeadActions">
          <Skeleton width="72px" height="36px" radius="10px" />
        </div>
      </div>

      <div className="productGrid">
        <div className="miniBox productCardSkeletonMiniBox">
          <Skeleton width="70px" height="14px" />
          <Skeleton width="90px" height="22px" />
        </div>
        <div className="miniBox productCardSkeletonMiniBox">
          <Skeleton width="90px" height="14px" />
          <Skeleton width="100%" height="42px" radius="12px" />
        </div>
        <div className="miniBox productCardSkeletonMiniBox">
          <Skeleton width="105px" height="14px" />
          <Skeleton width="100%" height="42px" radius="12px" />
        </div>
      </div>

      <Skeleton width="240px" height="46px" radius="12px" />
      <Skeleton width="100%" height="38px" radius="10px" />
    </article>
  )
}
