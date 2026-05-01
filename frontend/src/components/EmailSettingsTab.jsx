import { useEmailSettingsContext } from '../context/EmailSettingsContext'
import { useAuth } from '../hooks/useAuth'

// Email toggle, recipients list, pending-alerts CTA, how-it-works section.
// authEmail is read from useAuth as a fallback for the primary-email display
// when the backend hasn't returned it yet (matches Phase 4 behavior).
//
// Inner JSX param `recipientEmail` is named explicitly to avoid shadowing the
// outer `email` from useEmailSettingsContext (rename was made in Phase 4).
export default function EmailSettingsTab() {
  const email = useEmailSettingsContext()
  const { authEmail, emailVerified, handleResendVerification } = useAuth()

  return (
    <section aria-label="Email alert settings">
      <div className="droplistHeader">
        <div>
          <h2 className="sectionTitle">Email Alert Settings</h2>
          <p className="sectionSub">Get notified when prices drop below your thresholds</p>
        </div>
      </div>

      {emailVerified === false && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '12px 16px',
            marginBottom: '16px',
            background: 'var(--warn-bg, #fff7ed)',
            border: '1px solid var(--warn-border, #fdba74)',
            borderRadius: '8px',
            color: 'var(--warn-ink, #9a3412)',
          }}
        >
          <div style={{ fontSize: '0.9em', lineHeight: 1.4 }}>
            <strong>Email not verified.</strong> Your price alerts won't send until you verify your email.
          </div>
          <button
            type="button"
            className="primaryBtn"
            onClick={() => handleResendVerification(authEmail)}
            disabled={!authEmail}
            style={{ whiteSpace: 'nowrap', padding: '6px 12px', fontSize: '0.85em' }}
          >
            Resend verification email
          </button>
        </div>
      )}

      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Email Alerts</h3>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
              Send a digest email when tracked products drop below threshold
            </p>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={email.emailSettings.enabled}
              onChange={(e) => email.updateEmailSettings({ enabled: e.target.checked })}
              disabled={email.emailSettingsLoading}
              style={{ width: '18px', height: '18px', accentColor: 'var(--purple)' }}
            />
            <span style={{ fontWeight: 600 }}>{email.emailSettings.enabled ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div style={{ padding: '12px', background: 'var(--bg-highlight)', borderRadius: '8px', marginBottom: '16px' }}>
          <div style={{ fontSize: '0.85em', color: 'var(--muted)', marginBottom: '4px' }}>Primary Email (login)</div>
          <div style={{ fontWeight: 600 }}>{email.emailSettings.primaryEmail || authEmail || '—'}</div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label
            htmlFor="new-recipient"
            style={{ fontWeight: 600, fontSize: '0.85em', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}
          >
            Additional Recipients
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              id="new-recipient"
              className="input"
              type="email"
              placeholder="another@email.com"
              autoComplete="email"
              value={email.newRecipientEmail}
              onChange={(e) => {
                email.setNewRecipientEmail(e.target.value)
                email.setRecipientEmailInvalid(false)
              }}
              onKeyDown={(e) => e.key === 'Enter' && email.addRecipient()}
              style={{ flex: 1 }}
              aria-invalid={email.recipientEmailInvalid || undefined}
            />
            <button
              className="primaryBtn"
              onClick={email.addRecipient}
              disabled={email.emailSettingsLoading}
              style={{ whiteSpace: 'nowrap', padding: '8px 16px' }}
              type="button"
            >
              Add
            </button>
          </div>
        </div>

        {email.emailSettings.recipients.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
            {email.emailSettings.recipients.map((recipientEmail) => (
              <div
                key={recipientEmail}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  background: 'var(--bg-hover)',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                }}
              >
                <span style={{ fontSize: '0.9em' }}>{recipientEmail}</span>
                <button
                  onClick={() => email.removeRecipient(recipientEmail)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--muted-lighter)',
                    cursor: 'pointer',
                    fontSize: '16px',
                    padding: '0 4px',
                  }}
                  title="Remove"
                  aria-label={`Remove ${recipientEmail}`}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {email.emailSettings.recipients.length === 0 && (
          <p style={{ color: 'var(--muted-lightest)', fontSize: '0.85em', marginBottom: '16px' }}>
            No additional recipients. Alerts will be sent to your primary email only.
          </p>
        )}
      </div>

      {email.pendingAlertCount > 0 && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>Pending Alerts</h3>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
              {email.pendingAlertCount} price drop{email.pendingAlertCount !== 1 ? 's' : ''} not yet emailed
            </p>
          </div>
            <button className="primaryBtn" onClick={email.sendDigestNow} style={{ padding: '8px 20px' }}>
              Send Now
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: '8px' }}>How it works</h3>
        <ol style={{ paddingLeft: '20px', color: 'var(--muted)', fontSize: '0.9em', lineHeight: '1.8' }}>
          <li>Set a price threshold on any tracked product</li>
          <li>When a price check detects a drop below your threshold, an alert is queued</li>
          <li>Queued alerts are sent as a digest email every few hours, or click <strong>Send Now</strong> to deliver immediately</li>
        </ol>
      </div>
    </section>
  )
}
