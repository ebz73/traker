import { FREQUENCIES } from '../constants'
import { useAddProductFormContext } from '../context/AddProductFormContext'
import { useEmailSettingsContext } from '../context/EmailSettingsContext'
import { useNavigationContext } from '../context/NavigationContext'
import { useProductsContext } from '../context/ProductsContext'

// Stats grid + add-product form + how-it-works steps.
//
// Form state lives in AddProductFormContext (Phase 5 design decision) so values
// survive tab switches — typing a long URL and tabbing away to peek at the
// droplist preserves what was typed. handleAddProduct is bridged here rather
// than in the form provider because Phase 4 Option A keeps form decoupled from
// products; HomeTab pulls both contexts and composes them.
export default function HomeTab() {
  const products = useProductsContext()
  const email = useEmailSettingsContext()
  const { setTab } = useNavigationContext()
  const form = useAddProductFormContext()

  const handleAddProduct = async () => {
    const payload = form.validate()
    if (!payload) return
    const result = await products.addProduct(payload)
    if (result?.ok) form.reset()
  }

  return (
    <>
      <section className="statsGrid" aria-label="Tracking overview">
        <div className="card">
          <h2 className="statsHeading">Tracking</h2>
          <p>{products.trackedCount} products</p>
        </div>
        <div className="card">
          <h2 className="statsHeading">Below Threshold</h2>
          <p>{products.belowThresholdCount} products</p>
        </div>
        <div
          className="card"
          style={{ cursor: 'pointer' }}
          onClick={() => setTab('emailSettings')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setTab('emailSettings')
            }
          }}
          role="button"
          tabIndex={0}
        >
          <h2 className="statsHeading">Email Alerts</h2>
          <p>{email.emailSettings.enabled ? `On · ${email.pendingAlertCount} pending` : 'Off'}</p>
        </div>
      </section>

      <section className="card addCard" aria-label="Add product form">
        <h2>Add Product by URL</h2>
        <div className="formRow">
          <label htmlFor="product-url">Product URL</label>
          <input
            id="product-url"
            className="input"
            value={form.url}
            onChange={(e) => {
              form.setUrl(e.target.value)
              form.setErrors((prev) => ({ ...prev, url: '' }))
            }}
            onFocus={(e) => e.target.select()}
            placeholder="https://www.walmart.com/..."
            aria-required="true"
            aria-invalid={form.errors.url ? true : undefined}
            aria-describedby="product-url-error"
          />
          <div
            id="product-url-error"
            className="lp-error"
            aria-live="polite"
            hidden={!form.errors.url}
          >
            {form.errors.url}
          </div>
        </div>

        <div className="formSplit">
          <div className="formRow">
            <label htmlFor="alert-threshold">Alert Threshold</label>
            <input
              id="alert-threshold"
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={form.threshold}
              onChange={(e) => {
                form.setThreshold(e.target.value)
                form.setErrors((prev) => ({ ...prev, threshold: '' }))
              }}
              placeholder="$ 0.00"
              aria-invalid={form.errors.threshold ? true : undefined}
              aria-describedby="alert-threshold-error"
            />
            <div
              id="alert-threshold-error"
              className="lp-error"
              aria-live="polite"
              hidden={!form.errors.threshold}
            >
              {form.errors.threshold}
            </div>
          </div>

          <div className="formRow">
            <label htmlFor="check-frequency">Check Frequency</label>
            <select
              id="check-frequency"
              className="input"
              value={form.frequency}
              onChange={(e) => form.setFrequency(e.target.value)}
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          className="primaryBtn"
          onClick={handleAddProduct}
          disabled={products.loadingId === 'adding'}
          aria-busy={products.loadingId === 'adding'}
        >
          {products.loadingId === 'adding' ? 'Adding...' : 'Add to Drop List'}
        </button>
      </section>

      <section className="card stepsCard" aria-label="How it works">
        <div className="stepItem">
          <div className="stepCircle blue">1</div>
          <h4>Add Product URL</h4>
          <p>Paste a product link from any online store.</p>
        </div>
        <div className="stepItem">
          <div className="stepCircle pink">2</div>
          <h4>Set Alert</h4>
          <p>Choose threshold and frequency for checks.</p>
        </div>
        <div className="stepItem">
          <div className="stepCircle green">3</div>
          <h4>Get Notified</h4>
          <p>We track drops and trigger your alert workflow.</p>
        </div>
      </section>
    </>
  )
}
