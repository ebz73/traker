import { useEmailSettingsContext } from '../context/EmailSettingsContext'
import { useAuth } from '../hooks/useAuth'
import ToggleSkeleton from './ToggleSkeleton'

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
        <div role="alert" className="emailVerifyBanner">
          <div className="emailVerifyBannerMsg">
            <strong>Email not verified.</strong> Your price alerts won't send until you verify your email.
          </div>
          <button
            type="button"
            className="primaryBtn emailVerifyBannerBtn"
            onClick={() => handleResendVerification(authEmail)}
            disabled={!authEmail}
          >
            Resend verification email
          </button>
        </div>
      )}

      <div className="card emailCard">
        <div className="emailToggleRow">
          <div>
            <h3 className="emailCardTitle">Email Alerts</h3>
            <p className="emailCardSubtext">
              Send a digest email when tracked products drop below threshold
            </p>
          </div>
          {email.emailSettingsInitialLoading || email.emailSettingsLoading ? (
            <ToggleSkeleton />
          ) : (
            <label className="emailToggle">
              <input
                type="checkbox"
                className="emailToggleCheckbox"
                checked={email.emailSettings.enabled}
                onChange={(e) => email.updateEmailSettings({ enabled: e.target.checked })}
                disabled={email.emailSettingsLoading}
              />
              <span className="emailToggleLabel">{email.emailSettings.enabled ? 'On' : 'Off'}</span>
            </label>
          )}
        </div>

        <div className="emailPrimaryBox">
          <div className="emailPrimaryLabel">Primary Email (login)</div>
          <div className="emailPrimaryValue">{email.emailSettings.primaryEmail || authEmail || '—'}</div>
        </div>

        <div className="emailRecipientsSection">
          <label htmlFor="new-recipient" className="emailRecipientsLabel">
            Additional Recipients
          </label>
          <div className="emailRecipientInputRow">
            <input
              id="new-recipient"
              className="input emailRecipientInput"
              type="email"
              placeholder="another@email.com"
              autoComplete="email"
              value={email.newRecipientEmail}
              onChange={(e) => {
                email.setNewRecipientEmail(e.target.value)
                email.setRecipientEmailInvalid(false)
              }}
              onKeyDown={(e) => e.key === 'Enter' && email.addRecipient()}
              aria-invalid={email.recipientEmailInvalid || undefined}
            />
            <button
              className="primaryBtn emailRecipientAddBtn"
              onClick={email.addRecipient}
              disabled={email.emailSettingsLoading}
              type="button"
            >
              Add
            </button>
          </div>
        </div>

        {email.emailSettings.recipients.length > 0 && (
          <div className="emailRecipientList">
            {email.emailSettings.recipients.map((recipientEmail) => (
              <div key={recipientEmail} className="emailRecipientRow">
                <span className="emailRecipientEmail">{recipientEmail}</span>
                <button
                  className="emailRecipientRemoveBtn"
                  onClick={() => email.removeRecipient(recipientEmail)}
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
          <p className="emailNoRecipientsMsg">
            No additional recipients. Alerts will be sent to your primary email only.
          </p>
        )}
      </div>

      {email.pendingAlertCount > 0 && (
        <div className="card emailCard">
          <div className="emailPendingRow">
            <div>
              <h3 className="emailCardTitle">Pending Alerts</h3>
              <p className="emailCardSubtext">
                {email.pendingAlertCount} price drop{email.pendingAlertCount !== 1 ? 's' : ''} not yet emailed
              </p>
            </div>
            <button className="primaryBtn emailSendNowBtn" onClick={email.sendDigestNow}>
              Send Now
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>How it works</h3>
        <ol className="emailHowToList">
          <li>Set a price threshold on any tracked product</li>
          <li>When a price check detects a drop below your threshold, an alert is queued</li>
          <li>Queued alerts are sent as a digest email every few hours, or click <strong>Send Now</strong> to deliver immediately</li>
        </ol>
      </div>
    </section>
  )
}
