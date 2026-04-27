import { useMemo } from 'react'
import { useNavigationContext } from '../context/NavigationContext'
import { usePriceHistoryContext } from '../context/PriceHistoryContext'
import { useProductsContext } from '../context/ProductsContext'
import ProductCard from './ProductCard'

// Sort header, product list, back-to-top button. The sortedProducts useMemo
// (formerly in AppShell) lives here because sortBy comes from useNavigationContext
// and getSortedProducts comes from useProductsContext — both consumers, so the
// memo's natural home is here.
export default function DroplistTab() {
  const products = useProductsContext()
  const history = usePriceHistoryContext()
  const { sortBy, setSortBy, navHidden, showBackToTop, droplistRef, scrollToTop } = useNavigationContext()

  const sortedProducts = useMemo(
    () => products.getSortedProducts(sortBy),
    [products, sortBy],
  )

  return (
    <section ref={droplistRef} aria-label="Product list">
      <div className="droplistHeader">
        <div>
          <h2 className="sectionTitle">My Droplist</h2>
          <p className="sectionSub">Manage all your tracked products</p>
        </div>
        <div className="sortControls">
          <label className="sortLabel" htmlFor="sort-by">Sort by</label>
          <select
            id="sort-by"
            className="sortSelect"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="default">Default</option>
            <optgroup label="Product Name">
              <option value="name-asc">Name A → Z</option>
              <option value="name-desc">Name Z → A</option>
            </optgroup>
            <optgroup label="Website">
              <option value="site-asc">Website A → Z</option>
              <option value="site-desc">Website Z → A</option>
            </optgroup>
            <optgroup label="Price">
              <option value="price-asc">Price Low → High</option>
              <option value="price-desc">Price High → Low</option>
            </optgroup>
          </select>
        </div>
      </div>

      {products.products.length === 0 && <div className="card">No products yet. Add one from Home.</div>}

      <div className="listWrap">
        {sortedProducts.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            loadingId={products.loadingId}
            scrapingUrls={products.scrapingUrls}
            expandedHistory={history.expandedHistory}
            historyByUrl={history.historyByUrl}
            historyLoadingByUrl={history.historyLoadingByUrl}
            onCheck={products.checkProductNow}
            onRedoPick={products.redoVisualPick}
            onRemove={products.removeProduct}
            onUpdate={products.updateProduct}
            onToggleHistory={history.toggleHistory}
          />
        ))}
      </div>

      {showBackToTop && (
        <button
          className="backToTopBtn"
          onClick={scrollToTop}
          aria-label="Back to top"
          style={navHidden && typeof window !== 'undefined' && window.innerWidth < 980 ? { bottom: '1.5rem' } : undefined}
        >
          ↑ Back to Top
        </button>
      )}
    </section>
  )
}
