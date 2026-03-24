importScripts("config.js");
importScripts("shared/api-utils.js");
const SCRAPE_STATUS_POLL_INTERVAL_MS = 2000;
const SCRAPE_STATUS_MAX_ATTEMPTS = 15;
const pendingWebPickByTabId = new Map();
const inFlightWebPickByRequestId = new Map();
const pendingPermissionRequests = new Map();
let extensionJobPollInFlight = false;
let cachedAuthToken = "";
const JOB_POLL_ALARM = "poll_extension_jobs";
const ACTIVE_JOB_REPOLL_MS = 2000;
const ACCESS_TOKEN_REFRESH_ALARM = "refresh_access_token";
const ACCESS_TOKEN_REFRESH_INTERVAL_MINUTES = 45; // Refresh 15 min before 60-min expiry
let isRefreshing = false; // Guard against concurrent refresh attempts
const HEARTBEAT_ALARM = "extension_heartbeat";
const HEARTBEAT_INTERVAL_MINUTES = 1; // Must be < server's EXTENSION_HEARTBEAT_TTL_SECONDS (180s)
// --- Pending popup pick (handles case where popup closes during permission dialog) ---
let pendingPopupPick = null; // { tabId, origin }
const JOB_MAX_CONCURRENT_TABS = 3;
const JOB_SAME_DOMAIN_DELAY_MS = 3000; // Wait 3s between requests to the same domain

// --- Storage helpers ---

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}

function setBusyBadge() {
  chrome.action.setBadgeText({ text: "..." });
  chrome.action.setBadgeBackgroundColor({ color: "#6c3ff5" });
}

function clearBusyBadge() {
  chrome.action.setBadgeText({ text: "" });
}

async function hasHostPermission(url) {
  try {
    const origin = new URL(url).origin + "/*";
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

function notifyPriceDrop(product, newPrice, oldPrice) {
  const productName = product.name || "Tracked Product";
  const domain = extractDomain(product.url);
  const sym = product.currencySymbol || "$";
  const priceStr = sym + Number(newPrice).toFixed(2);
  const thresholdStr = sym + Number(product.threshold).toFixed(2);

  let message = `${priceStr} - below your ${thresholdStr} threshold`;
  if (oldPrice != null && Number(oldPrice) > Number(newPrice)) {
    const oldStr = sym + Number(oldPrice).toFixed(2);
    message = `Dropped from ${oldStr} to ${priceStr} (threshold: ${thresholdStr})`;
  }

  const notificationId = `price_drop_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `Price Drop - ${domain}`,
    message: `${productName}\n${message}`,
    priority: 2,
  }).catch((err) => console.warn("[Traker] notification create failed:", err));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAuthToken() {
  const { authToken = "" } = await getStorage(["authToken"]);
  cachedAuthToken = authToken || "";
  return cachedAuthToken;
}

async function ensureAuthenticated() {
  const authToken = await getAuthToken();
  if (!authToken) {
    throw new Error("Please log in from the extension popup.");
  }
  return authToken;
}

async function refreshAccessToken() {
  // NOTE (Azure migration): Change the fetch URL and body format to match
  // Entra ID's /oauth2/v2.0/token endpoint. The rest of this function stays.
  if (isRefreshing) return false;
  isRefreshing = true;
  try {
    const { refreshToken = "" } = await getStorage(["refreshToken"]);
    if (!refreshToken) {
      return false;
    }

    const resp = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        // Refresh token itself is invalid/expired - full re-login needed
        await setStorage({ authToken: "", refreshToken: "" });
        cachedAuthToken = "";
        console.warn("[Traker] Refresh token expired - user must re-login");
      }
      return false;
    }

    const data = await resp.json();
    await setStorage({
      authToken: data.access_token,
      refreshToken: data.refresh_token,
    });
    cachedAuthToken = data.access_token;
    return true;
  } catch (err) {
    console.warn("[Traker] Token refresh failed:", err);
    return false;
  } finally {
    isRefreshing = false;
  }
}

async function extFetchWithRefresh(url, options = {}) {
  let resp = await extFetch(url, options);
  if (resp.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Retry with the new access token
      resp = await extFetch(url, options);
    }
  }
  return resp;
}

async function sendHeartbeat() {
  if (!cachedAuthToken) return;
  try {
    await extFetchWithRefresh(`${API_BASE_URL}/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
  } catch (err) {
    // Heartbeat failures are non-critical - don't log aggressively
    if (err?.message && !err.message.includes("Failed to fetch")) {
      console.warn("[Traker] heartbeat failed:", err);
    }
  }
}

function isIgnorableMessagingError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("receiving end does not exist") ||
    normalized.includes("could not establish connection") ||
    normalized.includes("message port closed before a response was received")
  );
}

function buildTrackedProductSyncErrorMessage(status, payload, extensionEmail = "") {
  const detail = extractApiErrorMessage(payload);
  if (status === 401) {
    return extensionEmail
      ? `Extension session for ${extensionEmail} expired. Please log in again in the extension.`
      : "Extension session expired. Please log in again in the extension.";
  }
  if (status >= 500) {
    return detail || "Backend sync failed. Please try again in a moment.";
  }
  if (status > 0) {
    return detail || `Backend sync failed (${status}).`;
  }
  return detail || "Could not reach the backend. Check your connection and try again.";
}

async function getExtensionAuthContext({ verify = false } = {}) {
  const { authToken = "", authEmail = "" } = await getStorage(["authToken", "authEmail"]);
  const storedEmail = normalizeEmail(authEmail);
  if (!verify || !authToken) {
    return {
      authToken,
      authEmail: storedEmail,
      verified: false,
      authenticated: Boolean(authToken),
    };
  }

  try {
    const resp = await extFetch(`${API_BASE_URL}/auth/me`);
    if (resp.status === 401) {
      return {
        authToken,
        authEmail: storedEmail,
        verified: true,
        authenticated: false,
      };
    }
    if (!resp.ok) {
      return {
        authToken,
        authEmail: storedEmail,
        verified: true,
        authenticated: true,
      };
    }

    const data = await parseResponseBody(resp);
    const nextEmail = normalizeEmail(data?.email || storedEmail);
    if (nextEmail && nextEmail !== storedEmail) {
      await setStorage({ authEmail: nextEmail });
    }
    return {
      authToken,
      authEmail: nextEmail,
      verified: true,
      authenticated: true,
    };
  } catch (err) {
    console.warn("[Traker] auth verification failed:", err);
    return {
      authToken,
      authEmail: storedEmail,
      verified: false,
      authenticated: Boolean(authToken),
    };
  }
}

async function syncTrackedProductToBackend(payload) {
  let resp;
  try {
    resp = await extFetchWithRefresh(`${API_BASE_URL}/tracked-products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const networkError = new Error(
      buildTrackedProductSyncErrorMessage(0, null, "")
    );
    networkError.cause = err;
    networkError.status = 0;
    throw networkError;
  }

  const body = await parseResponseBody(resp);
  if (!resp.ok) {
    const authContext = await getExtensionAuthContext({ verify: resp.status === 401 });
    if (resp.status === 401) {
      cachedAuthToken = "";
      await setStorage({ authToken: "", refreshToken: "" });
    }
    const syncError = new Error(
      buildTrackedProductSyncErrorMessage(resp.status, body, authContext.authEmail)
    );
    syncError.status = resp.status;
    syncError.body = body;
    syncError.authEmail = authContext.authEmail;
    throw syncError;
  }

  return body;
}

async function broadcastTrackedProductsChanged(data = {}) {
  const authContext = await getExtensionAuthContext();
  const payload = {
    extensionEmail: authContext.authEmail,
    ...data,
  };

  chrome.runtime.sendMessage({ action: "products_updated", data: payload }).catch((err) => {
    if (!isIgnorableMessagingError(err?.message)) {
      console.warn("[Traker] products_updated broadcast failed:", err);
    }
  });

  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id != null)
        .map((tab) =>
          chrome.tabs.sendMessage(tab.id, {
            action: "tracked_products_synced",
            data: payload,
          })
        )
    );
  } catch (err) {
    console.warn("[Traker] tracked product tab broadcast failed:", err);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.authToken) {
    cachedAuthToken = changes.authToken.newValue || "";
    if (cachedAuthToken) {
      startExtensionJobPolling();
      sendHeartbeat();
      chrome.alarms.create(HEARTBEAT_ALARM, {
        periodInMinutes: HEARTBEAT_INTERVAL_MINUTES,
      });
    } else {
      stopExtensionJobPolling();
      chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});
    }
  }
  // When refresh token is cleared (logout), stop the refresh alarm
  if (changes.refreshToken && !changes.refreshToken.newValue) {
    chrome.alarms.clear(ACCESS_TOKEN_REFRESH_ALARM).catch(() => {});
  }
  // When auth token is cleared, stop heartbeat (TTL will expire naturally)
  if (changes.authToken && !changes.authToken.newValue) {
    chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});
  }
});

(async () => {
  const { authToken = "", refreshToken = "" } = await getStorage(["authToken", "refreshToken"]);
  cachedAuthToken = authToken;
  if (cachedAuthToken) {
    startExtensionJobPolling();
    // Start heartbeat so backend knows extension is available for Tier 3 scraping
    sendHeartbeat();
    chrome.alarms.create(HEARTBEAT_ALARM, {
      periodInMinutes: HEARTBEAT_INTERVAL_MINUTES,
    });
  }
  if (refreshToken) {
    chrome.alarms.create(ACCESS_TOKEN_REFRESH_ALARM, {
      periodInMinutes: ACCESS_TOKEN_REFRESH_INTERVAL_MINUTES,
    });
  }
})();

function isValidApiUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function splitSelectorList(value) {
  if (!value || typeof value !== "string") return [];
  const parts = [];
  let current = "";
  let quote = null;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }

    if (char === "," && bracketDepth === 0 && parenDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function normalizeSelectorString(value) {
  if (typeof value !== "string") return "";
  const parts = splitSelectorList(value);
  return Array.from(new Set(parts)).join(", ");
}

function frequencyToMinutes(freq) {
  const map = { "6h": 360, "12h": 720, "24h": 1440, "7d": 10080, "30d": 43200 };
  return map[freq] || 1440;
}

function alarmNameForUrl(url) {
  return "price_check::" + encodeURIComponent(url);
}

async function syncProductAlarms(trackedProducts) {
  // Get all existing price_check:: alarms
  const allAlarms = await chrome.alarms.getAll();
  const existingAlarmNames = new Set(allAlarms.map((a) => a.name).filter((n) => n.startsWith("price_check::")));

  // Build the desired set
  const desiredAlarmNames = new Set();
  for (const product of trackedProducts) {
    const name = alarmNameForUrl(product.url);
    desiredAlarmNames.add(name);
    const periodInMinutes = frequencyToMinutes(product.frequency);
    // Only create if it doesn't exist or period changed
    const existing = allAlarms.find((a) => a.name === name);
    const expectedPeriod = periodInMinutes;
    if (!existing || Math.abs((existing.periodInMinutes || 0) - expectedPeriod) > 1) {
      chrome.alarms.create(name, { periodInMinutes });
    }
  }

  // Remove alarms for products that are no longer tracked
  for (const name of existingAlarmNames) {
    if (!desiredAlarmNames.has(name)) {
      chrome.alarms.clear(name);
    }
  }
}

async function syncTrackedProductsFromBackend(trackedProducts) {
  try {
    const resp = await extFetchWithRefresh(`${API_BASE_URL}/tracked-products`);
    if (!resp.ok) return trackedProducts;
    const backendProducts = await resp.json();
    const backendByUrl = new Map(backendProducts.map((bp) => [bp.url, bp]));

    // Keep only entries that still exist in backend source of truth.
    const nextTrackedProducts = trackedProducts.filter((p) => backendByUrl.has(p.url));
    const localByUrl = new Map(nextTrackedProducts.map((p, i) => [p.url, i]));
    let changed = nextTrackedProducts.length !== trackedProducts.length;

    for (const bp of backendProducts) {
      const localIdx = localByUrl.get(bp.url);
      const local = localIdx !== undefined ? nextTrackedProducts[localIdx] : undefined;
      if (!local) {
        nextTrackedProducts.push({
          url: bp.url,
          backendId: bp.id ?? null,
          name: bp.product_name || bp.url,
          siteName: bp.site_name || null,
          selector: bp.custom_selector || "",
          originalSelector: bp.original_price_selector || "",
          lastPrice: bp.current_price ?? null,
          lastOriginalPrice: bp.original_price ?? null,
          lastChecked: bp.last_checked || "",
          threshold: normalizeThreshold(bp.threshold),
          frequency: normalizeFrequency(bp.frequency),
          currencyCode: bp.currency_code || null,
          currencySymbol: bp.currency_symbol || "$",
          previousPrice: null,
        });
        localByUrl.set(bp.url, nextTrackedProducts.length - 1);
        changed = true;
        continue;
      }

      const nextName = bp.product_name || local.name || bp.url;
      const nextSiteName = bp.site_name || local.siteName || null;
      const nextSelector = bp.custom_selector || local.selector || "";
      const nextOriginalSelector =
        bp.original_price_selector || local.originalSelector || "";
      const nextPrice = bp.current_price != null ? bp.current_price : local.lastPrice ?? null;
      const nextOriginalPrice =
        bp.original_price != null ? bp.original_price : local.lastOriginalPrice ?? null;
      const nextChecked = bp.last_checked || local.lastChecked || "";
      const nextThreshold = bp.threshold == null ? normalizeThreshold(local.threshold) : normalizeThreshold(bp.threshold);
      const nextFrequency = normalizeFrequency(bp.frequency || local.frequency);
      const nextCurrencyCode = bp.currency_code || local.currencyCode || null;
      const nextCurrencySymbol = bp.currency_symbol || local.currencySymbol || "$";
      const nextBackendId = bp.id ?? local.backendId ?? null;
      const nextPreviousPrice =
        bp.current_price != null && local.lastPrice != null && bp.current_price !== local.lastPrice
          ? local.lastPrice
          : local.previousPrice ?? null;

      if (
        local.name !== nextName ||
        (local.siteName || null) !== nextSiteName ||
        local.selector !== nextSelector ||
        (local.originalSelector || "") !== nextOriginalSelector ||
        local.lastPrice !== nextPrice ||
        (local.lastOriginalPrice ?? null) !== nextOriginalPrice ||
        local.lastChecked !== nextChecked ||
        normalizeThreshold(local.threshold) !== nextThreshold ||
        normalizeFrequency(local.frequency) !== nextFrequency ||
        (local.currencyCode || null) !== nextCurrencyCode ||
        (local.currencySymbol || "$") !== nextCurrencySymbol ||
        (local.backendId ?? null) !== nextBackendId ||
        (local.previousPrice ?? null) !== nextPreviousPrice
      ) {
        local.name = nextName;
        local.siteName = nextSiteName;
        local.selector = nextSelector;
        local.originalSelector = nextOriginalSelector;
        local.lastPrice = nextPrice;
        local.lastOriginalPrice = nextOriginalPrice;
        local.lastChecked = nextChecked;
        local.threshold = nextThreshold;
        local.frequency = nextFrequency;
        local.currencyCode = nextCurrencyCode;
        local.currencySymbol = nextCurrencySymbol;
        local.backendId = nextBackendId;
        local.previousPrice = nextPreviousPrice;
        changed = true;
      }
    }

    if (changed) {
      await setStorage({ trackedProducts: nextTrackedProducts });
    }
    return nextTrackedProducts;
  } catch (err) {
    console.warn("[Traker] failed to sync tracked products before checking:", err);
    return trackedProducts;
  }
}

async function postExtensionJobCompletion(jobId, payload) {
  try {
    const resp = await extFetchWithRefresh(`${API_BASE_URL}/extension/jobs/${jobId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // If job was cleaned up (404), fall back to price-report so data isn't lost
    if (resp.status === 404 && !payload.failed && payload.price != null) {
      console.warn("[Traker] Job %d was cleaned up; falling back to price-report", jobId);
      try {
        await extFetchWithRefresh(`${API_BASE_URL}/extension/price-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: payload.url,
            price: payload.price,
            original_price: payload.original_price ?? null,
            name: payload.name || "Unknown Product",
            site_name: payload.site_name || null,
            currency_code: payload.currency_code || null,
            selector: payload.selector || null,
            original_selector: payload.original_selector || null,
          }),
        });
      } catch (fallbackErr) {
        console.warn("[Traker] price-report fallback also failed:", fallbackErr);
      }
    }
  } catch (err) {
    console.warn("[Traker] extension job completion report failed:", err);
  }
}

async function executeJob(job) {
  let tabId = null;
  const jobUrl = (job?.url || "").trim();
  const selector = job?.custom_selector || null;
  const originalSelector = job?.original_price_selector || null;
  const jobId = job?.id;

  if (!jobId || !/^https?:\/\//i.test(jobUrl)) {
    if (jobId) {
      await postExtensionJobCompletion(jobId, {
        url: jobUrl || "unknown",
        selector,
        original_selector: originalSelector,
        failed: true,
        error_reason: "invalid_url",
      });
    }
    return;
  }

  // Check host permission before opening a tab — skip if user hasn't granted access
  if (!await hasHostPermission(jobUrl)) {
    console.warn("[Traker] job_skipped_no_permission job_id=%d domain=%s", jobId, extractDomain(jobUrl));
    await postExtensionJobCompletion(jobId, {
      url: jobUrl,
      selector,
      original_selector: originalSelector,
      failed: true,
      error_reason: "no_host_permission",
    });
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url: jobUrl, active: false });
    if (!tab?.id) {
      throw new Error("Failed to create background tab for extension job.");
    }
    tabId = tab.id;
    await waitForTabComplete(tabId, 25000);

    const scrapeResult = await scrapePayloadInTab(tabId, selector, originalSelector);
    if (!scrapeResult || scrapeResult.price == null) {
      throw new Error("no_price_extracted");
    }

    await postExtensionJobCompletion(jobId, {
      url: jobUrl,
      price: scrapeResult.price,
      original_price: scrapeResult.original_price ?? null,
      name: scrapeResult.name || "Unknown Product",
      site_name: scrapeResult.site_name || null,
      currency_code: scrapeResult.currency_code || null,
      selector,
      original_selector: originalSelector,
      selector_fallback: Boolean(scrapeResult.selector_fallback),
    });
    if (scrapeResult.selector_fallback) {
      console.warn("[Traker] job_selector_fallback job_id=%d domain=%s — selector failed, structured data fallback used",
        jobId, extractDomain(jobUrl));
    }
  } catch (err) {
    console.warn("[Traker] extension job execution failed:", err);
    await postExtensionJobCompletion(jobId, {
      url: jobUrl,
      selector,
      original_selector: originalSelector,
      failed: true,
      error_reason: err?.message ? err.message.slice(0, 200) : "unknown_error",
    });
  } finally {
    if (tabId !== null) {
      chrome.tabs
        .remove(tabId)
        .catch((err) => console.warn("[Traker] extension job tab cleanup failed:", err));
    }
  }
}

async function pollForJobs() {
  if (!isValidApiUrl(API_BASE_URL) || extensionJobPollInFlight) return;
  if (!cachedAuthToken) {
    stopExtensionJobPolling();
    return;
  }

  extensionJobPollInFlight = true;
  setBusyBadge();
  let hadJobs = false;
  try {
    const resp = await extFetchWithRefresh(`${API_BASE_URL}/extension/jobs`);
    if (!resp.ok) return;
    const jobs = await resp.json();
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    hadJobs = true;
    // Group jobs by domain for rate-limit-safe parallel execution
    const domainLastRun = new Map(); // domain -> timestamp of last job start

    // Process jobs in batches of JOB_MAX_CONCURRENT_TABS
    for (let batchStart = 0; batchStart < jobs.length; batchStart += JOB_MAX_CONCURRENT_TABS) {
      const batch = jobs.slice(batchStart, batchStart + JOB_MAX_CONCURRENT_TABS);

      await Promise.all(batch.map(async (job) => {
        // Per-domain spacing: wait if we recently hit this domain
        const domain = extractDomain(job.url || "");
        if (domain) {
          const lastRun = domainLastRun.get(domain) || 0;
          const elapsed = Date.now() - lastRun;
          if (elapsed < JOB_SAME_DOMAIN_DELAY_MS) {
            await wait(JOB_SAME_DOMAIN_DELAY_MS - elapsed);
          }
          domainLastRun.set(domain, Date.now());
        }

        await executeJob(job);
      }));

      // Heartbeat between batches to keep backend aware
      if (batchStart + JOB_MAX_CONCURRENT_TABS < jobs.length) {
        await sendHeartbeat();
      }
    }
  } catch (err) {
    console.warn("[Traker] extension job polling failed:", err);
  } finally {
    extensionJobPollInFlight = false;
    clearBusyBadge();
    if (hadJobs) {
      setTimeout(() => {
        pollForJobs();
      }, ACTIVE_JOB_REPOLL_MS);
    }
  }
}

function stopExtensionJobPolling() {
  chrome.alarms.clear(JOB_POLL_ALARM).catch(() => {});
}

function startExtensionJobPolling() {
  if (!isValidApiUrl(API_BASE_URL) || !cachedAuthToken) return;
  pollForJobs();
  chrome.alarms.create(JOB_POLL_ALARM, { periodInMinutes: 1 });
}

function notifyWebPickResult(pendingPick, data) {
  if (!pendingPick?.requesterTabId) return;
  chrome.tabs
    .sendMessage(pendingPick.requesterTabId, {
      action: "web_pick_result",
      requestId: pendingPick.requestId,
      data,
    })
    .catch((err) => console.warn("[Traker] failed to notify web pick result:", err));
}

function notifyWebPickStarted(pendingPick) {
  if (!pendingPick?.requesterTabId) return;
  chrome.tabs
    .sendMessage(pendingPick.requesterTabId, {
      action: "web_pick_started",
      requestId: pendingPick.requestId,
    })
    .catch((err) => console.warn("[Traker] failed to notify web pick started:", err));
}

function notifyWebPickError(pendingPick, error) {
  if (!pendingPick?.requesterTabId) return;
  chrome.tabs
    .sendMessage(pendingPick.requesterTabId, {
      action: "web_pick_error",
      requestId: pendingPick.requestId,
      error: error || "Picker was not completed.",
    })
    .catch((err) => console.warn("[Traker] failed to notify web pick error:", err));
}

function clearInFlightWebPickRequest(requestId) {
  if (!requestId) return;
  inFlightWebPickByRequestId.delete(requestId);
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    let pollId = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timeoutId) clearTimeout(timeoutId);
      if (pollId) clearInterval(pollId);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const checkTabNow = async () => {
      if (settled) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.status === "complete") {
          finish();
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const onUpdated = (id, info, tab) => {
      if (id !== tabId || settled) return;
      if (info.status === "complete" || tab?.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    // Fast page loads can complete before onUpdated listener observes the event.
    // Check current status immediately and via short polling.
    checkTabNow();
    pollId = setInterval(checkTabNow, 600);

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for product page to load."));
    }, timeoutMs);
  });
}

async function scrapeWithPolling(payload) {
  const scrapeResp = await extFetchWithRefresh(`${API_BASE_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const scrapeResult = await scrapeResp.json().catch(() => ({}));

  if (scrapeResult?.status === "pending" && scrapeResult?.job_id != null) {
    const jobId = scrapeResult.job_id;
    for (let attempt = 0; attempt < SCRAPE_STATUS_MAX_ATTEMPTS; attempt += 1) {
      await wait(SCRAPE_STATUS_POLL_INTERVAL_MS);
      const statusResp = await extFetchWithRefresh(`${API_BASE_URL}/scrape/status/${encodeURIComponent(jobId)}`);
      const statusResult = await statusResp.json().catch(() => ({ status: "failed", job_id: jobId }));
      if (statusResult?.status === "pending") continue;
      if (statusResult?.status === "done") {
        return { ok: true, result: statusResult };
      }
      return { ok: false, result: statusResult };
    }
    console.warn("[Traker] scrape_polling_timeout job_id=%d attempts=%d", jobId, SCRAPE_STATUS_MAX_ATTEMPTS);
    return { ok: false, result: { status: "failed", job_id: jobId } };
  }

  return { ok: scrapeResp.ok, result: scrapeResult };
}

async function injectPickerWithRetry(tabId, pickerPrefillData, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (prefillData) => {
          window.__trakerPickerData = prefillData;
          try {
            if (document.documentElement) {
              document.documentElement.setAttribute("data-traker-picker", JSON.stringify(prefillData));
            }
          } catch (err) {
            console.warn("[Traker] failed to persist picker prefill data on page:", err);
          }
        },
        args: [pickerPrefillData],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content_picker.js"],
      });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError || new Error("Timed out while injecting the price picker.");
}

async function startPickForUrl(data, sender) {
  const requesterTabId = sender?.tab?.id;
  const targetUrl = (data?.url || "").trim();
  const requestId = data?.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (!requesterTabId) {
    throw new Error("Picker request must originate from a browser tab.");
  }

  const existingRequest = inFlightWebPickByRequestId.get(requestId);
  if (existingRequest) {
    return { accepted: true, alreadyInFlight: true };
  }

  await ensureAuthenticated();

  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new Error("Please provide a valid product URL.");
  }

  const threshold = normalizeThreshold(data?.threshold);
  const frequency = normalizeFrequency(data?.frequency);

  if (!await hasHostPermission(targetUrl)) {
    // No host permission — open a single tab with the permission-grant page.
    // After the user grants permission, background navigates this same tab
    // to the product URL, waits for it to load, then injects the picker.
    const domain = extractDomain(targetUrl);
    const grantUrl = chrome.runtime.getURL(
      `permission-grant.html?requestId=${encodeURIComponent(requestId)}` +
      `&url=${encodeURIComponent(targetUrl)}` +
      `&domain=${encodeURIComponent(domain)}`
    );

    const grantTab = await chrome.tabs.create({ url: grantUrl, active: true });
    if (!grantTab?.id) {
      throw new Error("Failed to open the permission page.");
    }

    inFlightWebPickByRequestId.set(requestId, {
      startupPromise: null,
      pickerTabId: grantTab.id,
    });

    // Store everything needed to resume the pick after permission is granted
    pendingPermissionRequests.set(requestId, {
      requesterTabId,
      requestId,
      targetUrl,
      grantTabId: grantTab.id,
      threshold,
      frequency,
    });

    // Track the grant tab so we can clean up if it's closed before permission is granted
    pendingWebPickByTabId.set(grantTab.id, {
      requesterTabId,
      requestId,
      url: targetUrl,
      skipImmediateScrape: true,
    });

    return { accepted: true, alreadyInFlight: false, pendingPermission: true };
  }

  const pickerPrefillData = {
    threshold: threshold === "" ? "" : threshold,
    frequency: frequency || DEFAULT_FREQUENCY,
  };

  const inFlightRequest = {
    startupPromise: null,
    pickerTabId: null,
  };

  const startupPromise = (async () => {
    try {
      const productTab = await chrome.tabs.create({ url: targetUrl, active: true });
      if (!productTab?.id) {
        throw new Error("Failed to open the product page.");
      }

      inFlightRequest.pickerTabId = productTab.id;
      pendingWebPickByTabId.set(productTab.id, {
        requesterTabId,
        requestId,
        url: targetUrl,
        skipImmediateScrape: true,
      });

      await waitForTabComplete(productTab.id, 60000);
      await injectPickerWithRetry(productTab.id, pickerPrefillData, 60000);
      const pendingPick = pendingWebPickByTabId.get(productTab.id);
      notifyWebPickStarted(pendingPick);
    } catch (err) {
      if (inFlightRequest.pickerTabId !== null) {
        const pendingPick = pendingWebPickByTabId.get(inFlightRequest.pickerTabId);
        pendingWebPickByTabId.delete(inFlightRequest.pickerTabId);
        if (pendingPick) {
          notifyWebPickError(pendingPick, err?.message || "Failed to start price picker.");
        }
      } else {
        notifyWebPickError(
          { requesterTabId, requestId },
          err?.message || "Failed to start price picker."
        );
      }
      clearInFlightWebPickRequest(requestId);
      throw err;
    }
  })();

  inFlightRequest.startupPromise = startupPromise;
  inFlightWebPickByRequestId.set(requestId, inFlightRequest);
  startupPromise.catch(() => {});
  return { accepted: true, alreadyInFlight: false };
}

async function resumePickAfterPermission(pending) {
  const { requesterTabId, requestId, targetUrl, grantTabId, threshold, frequency } = pending;

  const pickerPrefillData = {
    threshold: threshold === "" ? "" : threshold,
    frequency: frequency || DEFAULT_FREQUENCY,
  };

  try {
    // Navigate the permission tab to the product URL (same tab, no new tab)
    await chrome.tabs.update(grantTabId, { url: targetUrl });
    await waitForTabComplete(grantTabId, 30000);

    // Update the pendingWebPickByTabId entry — the tab is now the product page
    pendingWebPickByTabId.set(grantTabId, {
      requesterTabId,
      requestId,
      url: targetUrl,
      skipImmediateScrape: true,
    });

    // Update inFlightWebPickByRequestId with the correct tab ID
    inFlightWebPickByRequestId.set(requestId, {
      startupPromise: null,
      pickerTabId: grantTabId,
    });

    await injectPickerWithRetry(grantTabId, pickerPrefillData, 60000);
    const pendingPick = pendingWebPickByTabId.get(grantTabId);
    notifyWebPickStarted(pendingPick);
  } catch (err) {
    const pendingPick = pendingWebPickByTabId.get(grantTabId);
    pendingWebPickByTabId.delete(grantTabId);
    if (pendingPick) {
      notifyWebPickError(pendingPick, err?.message || "Failed to inject price picker after permission grant.");
    } else {
      notifyWebPickError(
        { requesterTabId, requestId },
        err?.message || "Failed to inject price picker after permission grant."
      );
    }
    clearInFlightWebPickRequest(requestId);
    throw err;
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "selector_picked") {
    handleSelectorPicked(msg.data, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || "Failed to save tracked product.",
          status: err?.status || 0,
          authEmail: err?.authEmail || "",
        })
      );
    return true;
  }
  if (msg.action === "picker_cancelled") {
    handlePickerCancelled(msg.data, sender);
    return false;
  }
  if (msg.action === "broadcast_tracked_products_synced") {
    broadcastTrackedProductsChanged(msg.data)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || "Failed to broadcast tracked product update.",
        })
      );
    return true;
  }
  if (msg.action === "permission_granted") {
    const pending = pendingPermissionRequests.get(msg.requestId);
    pendingPermissionRequests.delete(msg.requestId);
    if (!pending) {
      sendResponse({ ok: false, error: "No pending request found." });
      return false;
    }
    sendResponse({ ok: true });
    // Resume the picker flow in the same tab after permission is granted
    resumePickAfterPermission(pending).catch((err) => {
      console.warn("[Traker] resume pick after permission failed:", err);
    });
    return false;
  }
  if (msg.action === "permission_denied") {
    const pending = pendingPermissionRequests.get(msg.requestId);
    pendingPermissionRequests.delete(msg.requestId);
    if (pending) {
      clearInFlightWebPickRequest(msg.requestId);
      // Clean up the grant tab
      if (pending.grantTabId != null) {
        pendingWebPickByTabId.delete(pending.grantTabId);
        chrome.tabs.remove(pending.grantTabId).catch(() => {});
      }
      notifyWebPickError(
        { requesterTabId: pending.requesterTabId, requestId: msg.requestId },
        "Permission was denied for this site."
      );
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "pending_popup_pick") {
    pendingPopupPick = { tabId: msg.tabId, origin: msg.origin };
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "clear_pending_popup_pick") {
    pendingPopupPick = null;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "start_pick_for_url") {
    startPickForUrl(msg.data, sender)
      .then((ack) =>
        sendResponse({
          ok: true,
          accepted: Boolean(ack?.accepted),
          alreadyInFlight: Boolean(ack?.alreadyInFlight),
          pendingPermission: Boolean(ack?.pendingPermission),
        })
      )
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed to start picker." }));
    return true;
  }
  if (msg.action === "check_all_prices") {
    checkAllPrices().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }
});

// --- Handle selector picked from content_picker.js ---

async function handleSelectorPicked(data, sender) {
  const sourceTabId = sender?.tab?.id ?? null;
  const pendingPick = sourceTabId !== null ? pendingWebPickByTabId.get(sourceTabId) : null;
  const skipImmediateScrape = Boolean(pendingPick?.skipImmediateScrape);
  const pickerThreshold = normalizeThreshold(data?.threshold);
  const pickerFrequency = normalizeFrequency(data?.frequency);
  const finalSelector = normalizeSelectorString(data?.selector);
  const finalOriginalSelector = normalizeSelectorString(data?.original_selector);
  const pickedPrice = data?.price ?? null;
  const pickedOriginalPrice = data?.original_price ?? null;
  const hasPickerThreshold = pickerThreshold !== "";
  const finalThreshold = hasPickerThreshold ? pickerThreshold : null;
  const finalFrequency = pickerFrequency || DEFAULT_FREQUENCY;
  const { trackedProducts: freshProducts = [] } = await getStorage(["trackedProducts"]);
  const existing = freshProducts.findIndex((p) => p.url === data.url);
  const previous = existing >= 0 ? freshProducts[existing] : null;
  const effectiveOriginalSelector = finalOriginalSelector || previous?.originalSelector || "";
  const syncPayload = {
    url: data.url,
    product_name: data.name || "Unknown Product",
    site_name: data.site_name || null,
    custom_selector: finalSelector,
    current_price: pickedPrice,
    original_price: pickedOriginalPrice,
    original_price_selector: effectiveOriginalSelector || null,
    currency_code: null,
    threshold: finalThreshold,
    frequency: finalFrequency,
  };

  try {
    const backendResult = await syncTrackedProductToBackend(syncPayload);

    // Persist locally only after the backend accepts the tracked product update.
    const entry = {
      url: data.url,
      name: data.name || data.url,
      siteName: data.site_name || previous?.siteName || null,
      selector: finalSelector,
      originalSelector: effectiveOriginalSelector,
      lastPrice: pickedPrice,
      lastOriginalPrice:
        pickedOriginalPrice != null
          ? pickedOriginalPrice
          : previous?.lastOriginalPrice ?? null,
      lastChecked: new Date().toISOString(),
      threshold: hasPickerThreshold
        ? pickerThreshold
        : existing >= 0
          ? normalizeThreshold(freshProducts[existing].threshold)
          : "",
      frequency: data?.frequency
        ? finalFrequency
        : existing >= 0
          ? normalizeFrequency(freshProducts[existing].frequency)
          : DEFAULT_FREQUENCY,
      currencyCode: previous?.currencyCode || null,
      currencySymbol: previous?.currencySymbol || "$",
      backendId: backendResult?.id ?? previous?.backendId ?? null,
      previousPrice: previous?.previousPrice ?? null,
    };
    if (existing >= 0) {
      freshProducts[existing] = entry;
    } else {
      freshProducts.push(entry);
    }
    await setStorage({ trackedProducts: freshProducts });

    // Immediately fetch the latest price from the backend unless this pick
    // originated from the web app flow where we want to avoid backend browser launch.
    if (!skipImmediateScrape) {
      try {
        const { ok, result } = await scrapeWithPolling({
          url: data.url,
          custom_selector: finalSelector,
          original_price_selector: effectiveOriginalSelector || null,
          skip_extension: true,
        });
        if (ok && result?.price != null) {
          const { trackedProducts: postScrapeProducts = [] } = await getStorage(["trackedProducts"]);
          const idx = postScrapeProducts.findIndex((p) => p.url === data.url);
          if (idx >= 0) {
            const oldPrice = postScrapeProducts[idx].lastPrice;
            if (oldPrice != null && oldPrice !== result.price) {
              postScrapeProducts[idx].previousPrice = oldPrice;
            }
            postScrapeProducts[idx].lastPrice = result.price;
            postScrapeProducts[idx].lastOriginalPrice =
              result.original_price != null
                ? result.original_price
                : postScrapeProducts[idx].lastOriginalPrice ?? null;
            postScrapeProducts[idx].siteName =
              result.site_name || data.site_name || postScrapeProducts[idx].siteName || null;
            if (result.currency_code) {
              postScrapeProducts[idx].currencyCode = result.currency_code;
            }
            postScrapeProducts[idx].originalSelector =
              effectiveOriginalSelector ||
              result.original_price_selector ||
              postScrapeProducts[idx].originalSelector ||
              "";
            postScrapeProducts[idx].lastChecked = new Date().toISOString();
            await setStorage({ trackedProducts: postScrapeProducts });
          }
        }
      } catch (err) {
        console.warn("[Traker] immediate scrape after picker save failed:", err);
      }
    }

    const { trackedProducts: refreshed = [] } = await getStorage(["trackedProducts"]);
    await syncProductAlarms(refreshed);

    const authContext = await getExtensionAuthContext();
    if (pendingPick && sourceTabId !== null) {
      notifyWebPickResult(pendingPick, {
        url: data.url,
        selector: finalSelector,
        price: pickedPrice,
        original_selector: effectiveOriginalSelector || null,
        original_price: pickedOriginalPrice,
        name: data.name,
        site_name: data.site_name || null,
        threshold: finalThreshold,
        frequency: finalFrequency,
        extension_email: authContext.authEmail,
      });
      pendingWebPickByTabId.delete(sourceTabId);
      clearInFlightWebPickRequest(pendingPick.requestId);
    }

    await broadcastTrackedProductsChanged({
      urls: [data.url],
      changeType: existing >= 0 ? "updated" : "created",
      source: pendingPick ? "web-picker" : "popup-picker",
      extensionEmail: authContext.authEmail,
      userMessage: "Selector saved!",
    });

    return {
      action: backendResult?.action || (existing >= 0 ? "updated" : "created"),
      url: data.url,
    };
  } catch (err) {
    if (pendingPick && sourceTabId !== null) {
      notifyWebPickError(
        pendingPick,
        err?.message || "Failed to sync the tracked product with the backend."
      );
      pendingWebPickByTabId.delete(sourceTabId);
      clearInFlightWebPickRequest(pendingPick.requestId);
    }
    throw err;
  }
}

async function handlePickerCancelled(data, sender) {
  const sourceTabId = sender?.tab?.id ?? null;
  const pendingPick = sourceTabId !== null ? pendingWebPickByTabId.get(sourceTabId) : null;

  if (pendingPick && sourceTabId !== null) {
    notifyWebPickError(pendingPick, "User cancelled the picker.");
    pendingWebPickByTabId.delete(sourceTabId);
    clearInFlightWebPickRequest(pendingPick.requestId);
  }
}

// --- Check all prices ---

async function checkSingleProduct(url) {
  const authToken = await getAuthToken();
  if (!authToken) return;
  const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
  const product = trackedProducts.find((p) => p.url === url);
  if (!product) return;

  // First try backend (httpx + curl_cffi tiers)
  let price = null;
  let originalPrice = product.lastOriginalPrice ?? null;
  let name = null;
  let siteName = product.siteName || null;
  let currencyCode = null;
  let extensionUsedFallback = false;
  try {
    const { ok, result } = await scrapeWithPolling({
      url: product.url,
      custom_selector: product.selector,
      original_price_selector: product.originalSelector || null,
      skip_extension: true,
    });
    if (ok && result?.price != null) {
      price = result.price;
      originalPrice = result.original_price != null ? result.original_price : originalPrice;
      name = result.name;
      siteName = result.site_name || siteName;
      currencyCode = result.currency_code;
    }
  } catch (err) {
    console.warn("[Traker] backend scrape failed for tracked product:", err);
  }

  // If backend failed, use extension hidden tab (Tier 3 — real cookies)
  if (price === null && (product.selector || product.originalSelector)) {
    const payload = await scrapeViaTab(product.url, product.selector, product.originalSelector);
    price = payload?.price ?? null;
    originalPrice = payload?.original_price != null ? payload.original_price : originalPrice;
    name = payload?.name || product.name;
    siteName = payload?.site_name || siteName;
    currencyCode = payload?.currency_code || currencyCode;
    extensionUsedFallback = Boolean(payload?.selector_fallback);
  }

  if (price === null) {
    console.warn("[Traker] price_check_failed domain=%s url=%s", extractDomain(product.url), product.url.slice(0, 100));
  }
  if (price !== null) {
    // Notify if price dropped below threshold
    const thresholdNum = Number(product.threshold);
    if (Number.isFinite(thresholdNum) && thresholdNum > 0 && price <= thresholdNum) {
      // Only notify if this is a NEW drop (price was previously above threshold, or first check)
      const previousPrice = product.lastPrice;
      if (previousPrice == null || previousPrice > thresholdNum) {
        notifyPriceDrop(product, price, previousPrice);
      }
    }
    // Report result to backend
    try {
      await extFetchWithRefresh(`${API_BASE_URL}/extension/price-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: product.url,
          price,
          original_price: originalPrice,
          name: name || product.name || "Unknown Product",
          site_name: siteName,
          currency_code: currencyCode || null,
          selector: product.selector || null,
          original_selector: product.originalSelector || null,
          selector_fallback: extensionUsedFallback,
        }),
      });
    } catch (err) {
      console.warn("[Traker] price report to backend failed:", err);
    }

    // Update local storage
    const { trackedProducts: latest = [] } = await getStorage(["trackedProducts"]);
    const idx = latest.findIndex((p) => p.url === url);
    if (idx >= 0) {
      // Preserve previous price for trend indicator
      const oldPrice = latest[idx].lastPrice;
      if (oldPrice != null && oldPrice !== price) {
        latest[idx].previousPrice = oldPrice;
      }
      latest[idx].lastPrice = price;
      latest[idx].lastOriginalPrice =
        originalPrice != null ? originalPrice : latest[idx].lastOriginalPrice ?? null;
      latest[idx].siteName = siteName || latest[idx].siteName || null;
      if (currencyCode) latest[idx].currencyCode = currencyCode;
      latest[idx].lastChecked = new Date().toISOString();
      await setStorage({ trackedProducts: latest });
    }
  }
}

async function checkAllPrices() {
  setBusyBadge();
  try {
    const authToken = await getAuthToken();
    if (!authToken) return;
    const { trackedProducts: storedProducts = [] } = await getStorage(["trackedProducts"]);
    const trackedProducts = await syncTrackedProductsFromBackend(storedProducts);
    await syncProductAlarms(trackedProducts);
    for (const product of trackedProducts) {
      await checkSingleProduct(product.url);
    }
  } finally {
    clearBusyBadge();
  }
}

// --- Extension-based tab scraping ---

async function scrapePayloadInTab(tabId, selector, originalSelector) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, origSel) => {
        window.__trakerSelector = sel || "";
        window.__trakerOriginalSelector = origSel || "";
        window.__trakerResult = undefined;
      },
      args: [selector || "", originalSelector || ""],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_scraper.js"],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return new Promise((resolve) => {
          const maxWait = 15000;
          const interval = 500;
          let elapsed = 0;
          const check = () => {
            if (window.__trakerResult !== undefined) {
              resolve(window.__trakerResult);
              return;
            }
            elapsed += interval;
            if (elapsed >= maxWait) {
              resolve(null);
              return;
            }
            setTimeout(check, interval);
          };
          check();
        });
      },
    });

    return results?.[0]?.result ?? null;
  } catch (err) {
    console.warn("[Traker] scrapePayloadInTab failed:", err);
    return null;
  }
}

async function scrapeViaTab(url, selector, originalSelector) {
  if (!await hasHostPermission(url)) {
    console.warn("[Traker] scrapeViaTab skipped — no host permission for %s", extractDomain(url));
    return null;
  }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    try {
      await waitForTabComplete(tabId, 30000);
    } catch (err) {
      console.warn("[Traker] waiting for scrape tab to load failed:", err);
    }
    return await scrapePayloadInTab(tabId, selector, originalSelector);
  } catch (err) {
    console.warn("[Traker] scrape via tab failed:", err);
    return null;
  } finally {
    if (tabId !== null) {
      chrome.tabs.remove(tabId).catch((err) => console.warn("[Traker] scrape tab cleanup failed:", err));
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [reqId, pending] of pendingPermissionRequests) {
    if (pending.grantTabId === tabId) {
      pendingPermissionRequests.delete(reqId);
      pendingWebPickByTabId.delete(tabId);
      clearInFlightWebPickRequest(reqId);
      notifyWebPickError(
        { requesterTabId: pending.requesterTabId, requestId: reqId },
        "Permission page was closed before access was granted."
      );
      return;
    }
  }

  const pendingPick = pendingWebPickByTabId.get(tabId);
  if (!pendingPick) return;
  pendingWebPickByTabId.delete(tabId);
  clearInFlightWebPickRequest(pendingPick.requestId);
  notifyWebPickError(pendingPick, "Picker tab closed before price element was saved.");
});

chrome.permissions.onAdded.addListener(async (permissions) => {
  if (!pendingPopupPick) return;

  const { tabId, origin } = pendingPopupPick;
  pendingPopupPick = null;

  // Check if the granted permission matches what we were waiting for
  if (!permissions.origins || !permissions.origins.some((o) => o === origin)) return;

  try {
    // Small delay to let the permission dialog close and tab regain focus
    await new Promise((resolve) => setTimeout(resolve, 300));
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_picker.js"],
    });
  } catch (err) {
    console.warn("[Traker] popup pick injection after permission grant failed:", err);
  }
});

// --- Periodic alarms ---

chrome.runtime.onInstalled.addListener(async () => {
  const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
  startExtensionJobPolling();
  await syncProductAlarms(trackedProducts);
});

chrome.runtime.onStartup.addListener(async () => {
  const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
  startExtensionJobPolling();
  await syncProductAlarms(trackedProducts);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ACCESS_TOKEN_REFRESH_ALARM) {
    const { refreshToken = "" } = await getStorage(["refreshToken"]);
    if (refreshToken) {
      await refreshAccessToken();
    }
    return;
  }
  if (alarm.name === HEARTBEAT_ALARM) {
    await sendHeartbeat();
    return;
  }
  if (alarm.name === JOB_POLL_ALARM) {
    await pollForJobs();
    return;
  }
  if (alarm.name.startsWith("price_check::")) {
    const url = decodeURIComponent(alarm.name.slice("price_check::".length));
    await checkSingleProduct(url);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("price_drop_")) {
    chrome.tabs.create({ url: `${WEB_APP_URL}/?tab=droplist` });
    chrome.notifications.clear(notificationId).catch(() => {});
  }
});
