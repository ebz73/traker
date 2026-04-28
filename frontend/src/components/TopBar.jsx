import { useEmailSettingsContext } from '../context/EmailSettingsContext'
import { useNavigationContext } from '../context/NavigationContext'
import { useProductsContext } from '../context/ProductsContext'
import ProfileDropdown from './ProfileDropdown'

// Renders the brand, the three nav tabs (Home / Droplist / Email) with their
// dynamic badges, and ProfileDropdown. Only mounted when logged in (AppShell's
// early-return on !authToken keeps this subtree out of the LoginPage path).
//
// Tailwind migration notes:
// - Mobile-first; desktop overrides via lg: prefix (1024px+).
// - Color tokens reference App.css's --bg/--ink/--purple variables via the
//   (--var) syntax. Dark mode flips automatically through the existing
//   [data-theme="dark"] block in App.css.
// - Active tab state uses aria-[current=page]: instead of a className helper.
//   No more navClass() — semantic state drives visual state.
export default function TopBar() {
  const { tab, setTab, navHidden } = useNavigationContext()
  const { trackedCount } = useProductsContext()
  const { pendingAlertCount } = useEmailSettingsContext()

  // Shared button classes for the three nav tabs.
  const navBtnClass = [
    'inline-flex items-center justify-center whitespace-nowrap shrink-0',
    'flex-col gap-[3px] px-2.5 py-2.5 rounded-lg min-w-16 text-center text-[0.85rem]',
    'md:gap-1 md:px-3 md:py-3 md:min-w-20 md:text-base',
    'lg:flex-row lg:gap-2 lg:px-4 lg:py-[11px] lg:rounded-[14px] lg:min-w-0 lg:text-[1.05rem]',
    'bg-transparent text-(--ink-secondary)',
    'aria-[current=page]:bg-(--nav-active-bg) aria-[current=page]:text-(--nav-active-text)',
    'transition-[transform,opacity] duration-100 ease-out',
    'active:scale-[0.96] active:opacity-85 disabled:opacity-75',
  ].join(' ')

  // Shared badge classes for the count indicators inside nav buttons.
  const badgeClass = [
    'inline-flex items-center justify-center align-middle',
    'min-w-[18px] h-[18px] px-1 rounded-full text-[0.7rem] ml-0.5',
    'md:min-w-[20px] md:h-[20px] md:px-[5px] md:text-[0.75rem] md:ml-1',
    'lg:min-w-[22px] lg:h-[22px] lg:px-1.5 lg:text-[0.8rem] lg:ml-0',
    'bg-(--badge-bg) text-(--on-brand)',
  ].join(' ')

  return (
    <header className="flex items-center justify-between h-15 gap-3 px-3.5 bg-(--nav-bg) border-b border-(--line) lg:h-19.5 lg:gap-5 lg:px-5">
      <div className="flex items-center gap-3.5">
        <div className="grid place-items-center w-10 h-10 rounded-xl text-[28px] font-bold text-(--on-brand) bg-linear-[160deg,var(--brand-logo-start),var(--brand-logo-end)] lg:w-14 lg:h-14 lg:rounded-[17px] lg:text-[40px]">
          T
        </div>
        <h1 className="m-0 tracking-[0.5px] text-3xl lg:text-4xl">
          TRAKER
        </h1>
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 min-w-0 lg:flex-none">
        <nav
          className={[
            'fixed bottom-0 left-0 right-0 z-100 flex justify-around gap-0',
            'py-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] px-0',
            'bg-(--nav-bg) border-t border-(--line) shadow-[0_-2px_10px_var(--shadow-nav)]',
            'transition-transform duration-300 ease-in-out',
            navHidden ? 'translate-y-full' : 'translate-y-0',
            // Desktop overrides: undo fixed positioning, reset to inline flex.
            'lg:static lg:translate-y-0 lg:flex-row lg:gap-2.5 lg:items-center lg:min-w-0',
            'lg:bg-transparent lg:border-t-0 lg:shadow-none lg:py-0 lg:px-0',
          ].join(' ')}
          role="navigation"
          aria-label="Main navigation"
        >
          <button
            className={navBtnClass}
            onClick={() => setTab('home')}
            aria-current={tab === 'home' ? 'page' : undefined}
            type="button"
          >
            Home
          </button>
          <button
            className={navBtnClass}
            onClick={() => setTab('droplist')}
            aria-current={tab === 'droplist' ? 'page' : undefined}
            type="button"
          >
            <span>Droplist <span className={badgeClass}>{trackedCount}</span></span>
          </button>
          <button
            className={navBtnClass}
            onClick={() => setTab('emailSettings')}
            aria-current={tab === 'emailSettings' ? 'page' : undefined}
            type="button"
          >
            <span>Email {pendingAlertCount > 0 && <span className={badgeClass}>{pendingAlertCount}</span>}</span>
          </button>
        </nav>

        <ProfileDropdown />
      </div>
    </header>
  )
}
