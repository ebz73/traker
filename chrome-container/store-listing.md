# TRAKER — Chrome Web Store Listing

## Extension Name
TRAKER

## Short Description (132 characters max — shown in search results)
Track product prices on any online store. Get alerts when prices drop below your threshold.

## Detailed Description (shown on listing page)

TRAKER lets you track prices on any online store and get notified when they drop.

HOW IT WORKS
1. Visit any product page and click "Pick Price Element" in the TRAKER popup
2. Click on the price you want to track — TRAKER learns where to find it
3. Set a price threshold and check frequency
4. TRAKER checks the price automatically and notifies you when it drops

FEATURES
• Track prices on any website — Amazon, Walmart, Target, Best Buy, Costco, Nike, and thousands more
• Smart price detection with sale price and original price support
• Customizable check frequency: every 6 hours, 12 hours, daily, weekly, or monthly
• Browser notifications when prices drop below your threshold
• Optional email alerts for price drops
• Price history tracking so you can see trends over time
• Dark mode support
• Works alongside the TRAKER web app for a complete price tracking dashboard

PRIVACY FIRST
• TRAKER only accesses sites you explicitly choose to track
• No browsing history collection
• No third-party analytics or advertising
• Data transmitted securely over HTTPS
• You can delete your data at any time

Requires a free TRAKER account to sync your tracked products across devices.

---

## Category
Shopping

## Language
English

## Privacy Practices (developer dashboard checkboxes)

### This extension collects the following:

☑ Personally identifiable information
  - "Email address for account authentication"
  - Marked as: "Essential to functionality"

☑ Website content
  - "Product prices and page metadata from sites the user chooses to track"
  - Marked as: "Essential to functionality"

☑ User activity
  - "Product page URLs that the user explicitly adds for price tracking"
  - Marked as: "Essential to functionality"

### This extension does NOT collect:
☐ Health information
☐ Financial and payment information
☐ Authentication information (note: we collect email, covered under PII above)
☐ Personal communications
☐ Location
☐ Web history (we only access pages the user explicitly tracks)

### Certifications:
☑ "I certify that the data collected is only used for the purposes disclosed above"
☑ "I certify that the data is not sold to third parties"
☑ "I certify that the data is not used for purposes unrelated to the item's core functionality"
☑ "I certify that the data is not used for creditworthiness or lending purposes"

---

## Single Purpose Description (for the justification form if asked)
TRAKER enables users to track product prices across online stores by allowing them to select price elements on product pages, periodically checking those prices in the background, and notifying users when prices drop below their configured thresholds.

## Permission Justifications (if asked during review)

### activeTab
Used to inject the price picker UI onto the current tab when the user clicks "Pick Price Element" in the extension popup. Only activated by explicit user action.

### storage
Stores user authentication tokens, tracked product data, and user preferences (theme setting) locally in the browser for offline access and session persistence.

### alarms
Schedules periodic background price checks at user-configured intervals (6h, 12h, daily, weekly, monthly). Also used for authentication token refresh and extension heartbeat.

### scripting
Injects the price picker interface (content_picker.js) and price extraction script (content_scraper.js) into product pages. The picker is injected on user action; the scraper runs in background tabs during scheduled price checks.

### notifications
Displays browser notifications when a tracked product's price drops below the user's configured threshold.

### optional host permissions (<all_urls>)
Requested at runtime on a per-domain basis when the user chooses to track a product on a new website. Required to inject the price picker and perform background price checks on that specific domain. The extension only requests access to domains the user explicitly selects.

---

## Contact Email (for store listing)
privacy@traker.app
