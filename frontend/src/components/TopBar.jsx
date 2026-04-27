import { useEmailSettingsContext } from '../context/EmailSettingsContext'
import { useNavigationContext } from '../context/NavigationContext'
import { useProductsContext } from '../context/ProductsContext'
import ProfileDropdown from './ProfileDropdown'

// Renders the brand, the three nav tabs (Home / Droplist / Email) with their
// dynamic badges, and ProfileDropdown. Only mounted when logged in (AppShell's
// early-return on !authToken keeps this subtree out of the LoginPage path).
export default function TopBar() {
  const { tab, setTab, navHidden, navClass } = useNavigationContext()
  const { trackedCount } = useProductsContext()
  const { pendingAlertCount } = useEmailSettingsContext()

  return (
    <header className="topbar">
      <div className="brandWrap">
        <div className="lp-logoBox homeLogoBox">T</div>
        <h1>TRAKER</h1>
      </div>

      <div className="topbarRight">
        <nav className={`navTabs${navHidden ? ' navHidden' : ''}`} role="navigation" aria-label="Main navigation">
          <button
            className={navClass('home')}
            onClick={() => setTab('home')}
            aria-current={tab === 'home' ? 'page' : undefined}
            type="button"
          >
            Home
          </button>
          <button
            className={navClass('droplist')}
            onClick={() => setTab('droplist')}
            aria-current={tab === 'droplist' ? 'page' : undefined}
            type="button"
          >
            <span>Droplist <span className="badge">{trackedCount}</span></span>
          </button>
          <button
            className={navClass('emailSettings')}
            onClick={() => setTab('emailSettings')}
            aria-current={tab === 'emailSettings' ? 'page' : undefined}
            type="button"
          >
            <span>Email {pendingAlertCount > 0 && <span className="badge">{pendingAlertCount}</span>}</span>
          </button>
        </nav>

        <ProfileDropdown />
      </div>
    </header>
  )
}
