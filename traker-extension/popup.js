const elBtnPick = document.getElementById("btn-pick");
const elBtnCheck = document.getElementById("btn-check");
const elStatus = document.getElementById("status");
const elProductList = document.getElementById("product-list");
const elProductCount = document.getElementById("product-count");
const elAuthSection = document.getElementById("auth-section");
const elAuthedContent = document.getElementById("authed-content");
const elAuthLoggedOut = document.getElementById("auth-logged-out");
const elAuthEmail = document.getElementById("auth-email");
const elAuthPassword = document.getElementById("auth-password");
const elBtnLogin = document.getElementById("btn-login");
const elBtnGoogle = document.getElementById("btn-google");
const elLinkSignup = document.getElementById("link-signup");
const elLinkForgotPassword = document.getElementById("link-forgot-password");
const elAuthError = document.getElementById("auth-error");
const elProfileWrap = document.getElementById("profile-wrap");
const elBtnProfile = document.getElementById("btn-profile");
const elProfileDropdown = document.getElementById("profile-dropdown");
const elProfileEmail = document.getElementById("profile-email");
const elProfileAvatar = document.getElementById("profile-avatar");
const elAvatarPicker = document.getElementById("avatar-picker");
const elBtnTheme = document.getElementById("btn-theme");
const elBtnLogout = document.getElementById("btn-logout");
const elBtnDeleteAccount = document.getElementById("btn-delete-account");
const AVATAR_NAMES = ["purple", "black", "orange", "yellow"];
const FREQUENCY_OPTIONS = [
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "24h", label: "Daily" },
  { value: "7d", label: "Weekly" },
  { value: "30d", label: "Monthly" },
];
const settingsOpenUrls = new Set();
let settingsInteractionUntil = 0;
let profileDropdownOpen = false;
let currentAvatarName = "purple";
let headerAvatarHandle = null;
const pickerAvatarHandles = [];

// --- Helpers ---

function destroyHeaderAvatar() {
  if (headerAvatarHandle) {
    headerAvatarHandle.destroy();
    headerAvatarHandle = null;
  }
}

function destroyPickerAvatars() {
  pickerAvatarHandles.forEach((handle) => handle.destroy());
  pickerAvatarHandles.length = 0;
  if (elAvatarPicker) {
    elAvatarPicker.replaceChildren();
  }
}

function renderHeaderAvatar() {
  destroyHeaderAvatar();
  if (elProfileAvatar && typeof renderAvatar === "function") {
    headerAvatarHandle = renderAvatar(elProfileAvatar, currentAvatarName, 28);
  }
}

function renderAvatarPicker() {
  if (!elAvatarPicker || typeof renderAvatar !== "function") return;

  destroyPickerAvatars();

  AVATAR_NAMES.forEach((name) => {
    const btn = document.createElement("button");
    btn.className = "avatar-picker-btn" + (name === currentAvatarName ? " active" : "");
    btn.type = "button";
    btn.dataset.avatarName = name;
    btn.setAttribute("aria-label", `Select ${name} avatar`);
    btn.title = name.charAt(0).toUpperCase() + name.slice(1);

    const container = document.createElement("div");
    container.style.width = "30px";
    container.style.height = "30px";
    container.style.borderRadius = "50%";
    container.style.overflow = "hidden";
    btn.appendChild(container);

    const handle = renderAvatar(container, name, 30);
    pickerAvatarHandles.push(handle);

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      currentAvatarName = name;
      await setStorage({ extensionAvatar: name });
      renderHeaderAvatar();
      elAvatarPicker.querySelectorAll(".avatar-picker-btn").forEach((pickerButton) => {
        pickerButton.classList.toggle("active", pickerButton.dataset.avatarName === name);
      });
    });

    elAvatarPicker.appendChild(btn);
  });
}

function updateThemeButton(theme) {
  elBtnTheme.textContent = theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
}

function showStatus(msg, type = "info") {
  elStatus.textContent = msg;
  elStatus.className = type;
}

function clearStatus() {
  elStatus.textContent = "";
  elStatus.className = "";
}

function friendlyError(err) {
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("cannot access a chrome") || msg.includes("chrome://") || msg.includes("chrome-extension://")) {
    return "This page can't be tracked (browser internal page).";
  }
  if (msg.includes("manifest must request permission") || msg.includes("cannot access contents")) {
    return "Permission needed for this site. Try again and accept the prompt.";
  }
  if (msg.includes("no tab with id") || msg.includes("no current browser")) {
    return "The tab was closed before the action completed.";
  }
  if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("network")) {
    return "Couldn't reach the server. Check your connection.";
  }
  if (msg.includes("please log in")) {
    return "Please log in to use this feature.";
  }
  return "Something went wrong. Please try again.";
}

function formatPrice(price, currencySymbol = "$") {
  if (price == null) return "—";
  return currencySymbol + Number(price).toFixed(2);
}

function calcPercentOff(originalPrice, salePrice) {
  const orig = Number(originalPrice);
  const sale = Number(salePrice);
  if (!Number.isFinite(orig) || !Number.isFinite(sale) || orig <= 0 || sale >= orig) return null;
  return Math.round((1 - sale / orig) * 100);
}

function getTrendIndicator(lastPrice, previousPrice) {
  if (lastPrice == null || previousPrice == null) return "";
  const current = Number(lastPrice);
  const previous = Number(previousPrice);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "";
  if (current < previous) return '<span class="trend trend-down" title="Price dropped" aria-label="Price dropped" role="img">↓</span>';
  if (current > previous) return '<span class="trend trend-up" title="Price increased" aria-label="Price increased" role="img">↑</span>';
  return "";
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

function bumpSettingsInteractionWindow(ms = 25000) {
  settingsInteractionUntil = Date.now() + ms;
}

function isSettingsInteractionActive() {
  if (Date.now() < settingsInteractionUntil) return true;
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest(".product-settings"));
}

async function refreshAccessTokenFromPopup() {
  const { refreshToken = "" } = await getStorage(["refreshToken"]);
  if (!refreshToken) return false;

  try {
    const resp = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        await setStorage({ authToken: "", refreshToken: "" });
      }
      return false;
    }

    const data = await resp.json();
    await setStorage({
      authToken: data.access_token,
      refreshToken: data.refresh_token,
    });
    return true;
  } catch (err) {
    console.warn("[Traker] Popup token refresh failed:", err);
    return false;
  }
}

async function extFetchWithRefresh(url, options = {}) {
  let resp = await extFetch(url, options);
  if (resp.status === 401) {
    const refreshed = await refreshAccessTokenFromPopup();
    if (refreshed) {
      resp = await extFetch(url, options);
    }
  }
  return resp;
}

async function loginWithGoogle() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const startUrl =
    `${API_BASE_URL}/auth/google/start?client_type=extension&redirect_url=` +
    encodeURIComponent(redirectUrl);
  const startResp = await fetch(startUrl);
  if (!startResp.ok) {
    const data = await startResp.json().catch(() => ({}));
    throw new Error(data?.detail || "Failed to start Google sign-in");
  }
  const { authorize_url: authorizeUrl } = await startResp.json();
  if (!authorizeUrl) throw new Error("Google sign-in unavailable");

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl,
    interactive: true,
  });
  if (!responseUrl) throw new Error("Google sign-in canceled");

  const fragment = new URL(responseUrl).hash.slice(1);
  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access");
  const refreshToken = params.get("refresh");
  const email = params.get("email") || "";

  if (!accessToken || !refreshToken) {
    throw new Error("Invalid response from Google sign-in");
  }

  await setStorage({
    authToken: accessToken,
    refreshToken: refreshToken,
    authEmail: email,
  });
  chrome.alarms.create("refresh_access_token", { periodInMinutes: 45 });
  return { access_token: accessToken, email };
}

async function loginFromPopup(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, client_type: "extension" }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || "Login failed");
  }
  const data = await res.json();
  await setStorage({
    authToken: data.access_token,
    refreshToken: data.refresh_token,
    authEmail: email,
  });
  // Start proactive token refresh
  chrome.alarms.create("refresh_access_token", { periodInMinutes: 45 });
  return data;
}

async function logoutFromPopup() {
  // Revoke refresh token on the backend before clearing storage
  const { refreshToken = "" } = await getStorage(["refreshToken"]);
  if (refreshToken) {
    try {
      // NOTE (Azure migration): Change URL to Entra ID's revocation endpoint
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch (err) {
      console.warn("[Traker] Backend logout failed:", err);
      // Don't block client-side logout if backend is unreachable
    }
  }
  await setStorage({ authToken: "", refreshToken: "", authEmail: "" });
}

function toggleProfileDropdown() {
  profileDropdownOpen = !profileDropdownOpen;
  elProfileDropdown.style.display = profileDropdownOpen ? "block" : "none";
  if (profileDropdownOpen) {
    renderAvatarPicker();
  } else {
    destroyPickerAvatars();
  }
}

function closeProfileDropdown() {
  profileDropdownOpen = false;
  elProfileDropdown.style.display = "none";
  destroyPickerAvatars();
}

function updateAuthDisplay(authToken, authEmail = "") {
  const loggedIn = Boolean(authToken);
  elAuthSection.style.display = loggedIn ? "none" : "block";
  elAuthLoggedOut.style.display = loggedIn ? "none" : "grid";
  elProfileWrap.style.display = loggedIn ? "block" : "none";
  elAuthedContent.style.display = loggedIn ? "block" : "none";
  if (loggedIn) {
    elProfileEmail.textContent = authEmail;
    renderHeaderAvatar();
    elAuthError.textContent = "";
    clearStatus();
    elAuthPassword.value = "";
  } else {
    elProfileEmail.textContent = "";
    destroyHeaderAvatar();
  }
  // Close dropdown when auth state changes
  closeProfileDropdown();
}

async function requireAuth() {
  const { authToken = "", authEmail = "" } = await getStorage(["authToken", "authEmail"]);
  if (authToken) return authToken;
  updateAuthDisplay("", "");
  elAuthError.textContent = authEmail ? "Session expired. Please log in again." : "Please log in to use the extension.";
  return "";
}

async function buildTrackedProductSyncError(resp, payload) {
  const { authEmail = "" } = await getStorage(["authEmail"]);
  const normalizedEmail = normalizeEmail(authEmail);
  const detail = extractApiErrorMessage(payload);
  let message = "";

  if (resp.status === 401) {
    message = normalizedEmail
      ? `Extension session for ${normalizedEmail} expired. Please log in again in the extension.`
      : "Extension session expired. Please log in again in the extension.";
    await setStorage({ authToken: "", refreshToken: "" });
  } else if (resp.status >= 500) {
    message = detail || "Backend sync failed. Please try again in a moment.";
  } else if (resp.status > 0) {
    message = detail || `Backend sync failed (${resp.status}).`;
  } else {
    message = detail || "Could not reach the backend. Check your connection and try again.";
  }

  const err = new Error(message);
  err.status = resp.status || 0;
  err.authEmail = normalizedEmail;
  err.body = payload;
  return err;
}

async function notifyTrackedProductsSynced(data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: "broadcast_tracked_products_synced", data },
      () => resolve()
    );
  });
}

async function upsertProductSettings(product) {
  const resp = await extFetchWithRefresh(`${API_BASE_URL}/tracked-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: product.url,
      threshold: product.threshold === "" ? null : Number(product.threshold),
      frequency: normalizeFrequency(product.frequency),
    }),
  });
  const data = await parseResponseBody(resp);
  if (!resp.ok) {
    throw await buildTrackedProductSyncError(resp, data);
  }
  return data;
}

async function deleteTrackedProductByUrl(url) {
  const resp = await extFetchWithRefresh(
    `${API_BASE_URL}/tracked-products/by-url/delete?url=${encodeURIComponent(url)}`,
    { method: "DELETE" }
  );
  const data = await parseResponseBody(resp);
  if (!resp.ok) {
    throw await buildTrackedProductSyncError(resp, data);
  }
  return data;
}

// --- Render product list ---

function renderProducts(products) {
  elProductCount.textContent = products.length;

  if (!products.length) {
    elProductList.innerHTML = '<li class="empty-state">No products tracked yet.</li>';
    return;
  }

  elProductList.innerHTML = products
    .map(
      (p, i) => {
        const frequency = normalizeFrequency(p.frequency);
        const threshold = normalizeThreshold(p.threshold);
        const thresholdInput = threshold === "" ? "" : String(threshold);
        const freqOptionsHtml = FREQUENCY_OPTIONS.map(
          (opt) => `<option value="${opt.value}"${opt.value === frequency ? " selected" : ""}>${opt.label}</option>`
        ).join("");
        return `
    <li class="product-item" data-index="${i}">
      <div class="product-info">
        <div class="product-name" title="${escapeHtml(p.url)}">${escapeHtml(p.name || p.url)}</div>
        <div class="product-price">
          ${formatPrice(p.lastPrice, p.currencySymbol || "$")} ${getTrendIndicator(p.lastPrice, p.previousPrice)}${p.lastOriginalPrice != null && Number(p.lastOriginalPrice) > Number(p.lastPrice)
            ? ` <span class="original-price">${formatPrice(p.lastOriginalPrice, p.currencySymbol || "$")}</span>
               <span class="pct-off">-${calcPercentOff(p.lastOriginalPrice, p.lastPrice)}%</span>`
            : ""}
        </div>
        <div class="product-meta">${escapeHtml(p.url.replace(/^https?:\/\//, "").substring(0, 40))} &middot; ${formatTime(p.lastChecked)}</div>
        <details class="product-settings" data-url="${escapeHtml(p.url)}">
          <summary class="settings-summary">Alert Settings</summary>
          <div class="settings-grid">
            <div class="setting-field">
              <label class="setting-label" for="threshold-${i}">Threshold</label>
              <input
                id="threshold-${i}"
                class="setting-input threshold-input"
                data-index="${i}"
                type="number"
                min="0"
                step="0.01"
                value="${escapeHtml(thresholdInput)}"
                placeholder="No threshold"
              />
            </div>
            <div class="setting-field">
              <label class="setting-label" for="frequency-${i}">Frequency</label>
              <select id="frequency-${i}" class="setting-input freq-select" data-index="${i}">
                ${freqOptionsHtml}
              </select>
            </div>
          </div>
        </details>
      </div>
      <button class="btn-remove" data-index="${i}" title="Remove ${escapeHtml(p.name || "product")}" aria-label="Remove ${escapeHtml(p.name || "product")}">&times;</button>
    </li>`;
      }
    )
    .join("");

  elProductList.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
      const removedProduct = trackedProducts[idx];
      if (!removedProduct?.url) return;
      if (!confirm(`Remove "${removedProduct.name || "this product"}" from tracking?`)) return;
      if (removedProduct?.url) {
        try {
          await deleteTrackedProductByUrl(removedProduct.url);
          trackedProducts.splice(idx, 1);
          await setStorage({ trackedProducts });
          renderProducts(trackedProducts);
          await notifyTrackedProductsSynced({
            urls: [removedProduct.url],
            changeType: "deleted",
            source: "popup-remove",
          });
          showStatus("Product removed.", "ok");
        } catch (err) {
          console.warn("[Traker] failed to remove from backend:", err);
          if (err?.status === 401) {
            updateAuthDisplay("", err?.authEmail || "");
            elAuthError.textContent = err.message;
          }
          showStatus(err?.message || "Could not remove product from backend.", "err");
        }
      }
    });
  });

  elProductList.querySelectorAll(".product-settings").forEach((detailsEl) => {
    const url = detailsEl.dataset.url || "";
    if (settingsOpenUrls.has(url)) {
      detailsEl.open = true;
    }
    detailsEl.addEventListener("toggle", (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
      if (detailsEl.open) {
        settingsOpenUrls.add(url);
      } else {
        settingsOpenUrls.delete(url);
      }
    });
    detailsEl.addEventListener("click", (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
    });
  });

  elProductList.querySelectorAll(".threshold-input").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
    });
    input.addEventListener("focus", () => bumpSettingsInteractionWindow());
    input.addEventListener("input", () => bumpSettingsInteractionWindow());
    input.addEventListener("change", async (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
      const idx = parseInt(input.dataset.index, 10);
      const nextThreshold = normalizeThreshold(input.value.trim());
      const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
      const product = trackedProducts[idx];
      if (!product) return;
      settingsOpenUrls.add(product.url);
      const nextProduct = {
        ...product,
        threshold: nextThreshold,
        frequency: normalizeFrequency(product.frequency),
      };
      try {
        await upsertProductSettings(nextProduct);
        trackedProducts[idx] = nextProduct;
        await setStorage({ trackedProducts });
        await notifyTrackedProductsSynced({
          urls: [product.url],
          changeType: "updated",
          source: "popup-settings",
        });
        showStatus("Product alert settings saved.", "ok");
      } catch (err) {
        console.warn("[Traker] failed to save product settings:", err);
        if (err?.status === 401) {
          updateAuthDisplay("", err?.authEmail || "");
          elAuthError.textContent = err.message;
        }
        input.value = product.threshold === "" ? "" : String(product.threshold);
        showStatus(err?.message || "Could not save settings to backend.", "err");
      }
    });
  });

  elProductList.querySelectorAll(".freq-select").forEach((select) => {
    select.addEventListener("click", (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
    });
    select.addEventListener("focus", () => bumpSettingsInteractionWindow());
    select.addEventListener("change", async (e) => {
      e.stopPropagation();
      bumpSettingsInteractionWindow();
      const idx = parseInt(select.dataset.index, 10);
      const nextFrequency = normalizeFrequency(select.value);
      const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
      const product = trackedProducts[idx];
      if (!product) return;
      settingsOpenUrls.add(product.url);
      const nextProduct = {
        ...product,
        frequency: nextFrequency,
        threshold: normalizeThreshold(product.threshold),
      };
      try {
        await upsertProductSettings(nextProduct);
        trackedProducts[idx] = nextProduct;
        await setStorage({ trackedProducts });
        await notifyTrackedProductsSynced({
          urls: [product.url],
          changeType: "updated",
          source: "popup-settings",
        });
        showStatus("Product alert settings saved.", "ok");
      } catch (err) {
        console.warn("[Traker] failed to save product settings:", err);
        if (err?.status === 401) {
          updateAuthDisplay("", err?.authEmail || "");
          elAuthError.textContent = err.message;
        }
        select.value = normalizeFrequency(product.frequency);
        showStatus(err?.message || "Could not save settings to backend.", "err");
      }
    });
  });

  elProductList.querySelectorAll(".product-item").forEach((productEl) => {
    productEl.style.cursor = "pointer";
    productEl.setAttribute("tabindex", "0");
    productEl.setAttribute("role", "link");
    productEl.setAttribute("aria-label", "Open product in Traker web app");

    const handleActivate = (e) => {
      if (
        e.target.closest(".btn-remove") ||
        e.target.closest(".product-settings") ||
        e.target.closest(".setting-input")
      ) return;
      chrome.tabs.create({ url: `${WEB_APP_URL}/?tab=droplist` });
      window.close();
    };

    productEl.addEventListener("click", handleActivate);
    productEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleActivate(e);
      }
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Init ---

async function syncWithBackend() {
  const { authToken = "", authEmail = "" } = await getStorage(["authToken", "authEmail"]);
  if (!authToken) return;
  const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
  try {
    const resp = await extFetchWithRefresh(`${API_BASE_URL}/tracked-products`);
    if (resp.status === 401) {
      await setStorage({ authToken: "", refreshToken: "" });
      updateAuthDisplay("", authEmail);
      elAuthError.textContent = authEmail
        ? `Extension session for ${normalizeEmail(authEmail)} expired. Please log in again.`
        : "Extension session expired. Please log in again.";
      return;
    }
    if (!resp.ok) return;
    const backendProducts = await resp.json();
    const backendByUrl = new Map(backendProducts.map((bp) => [bp.url, bp]));

    // Keep only products that still exist in backend.
    const nextTrackedProducts = trackedProducts.filter((p) => backendByUrl.has(p.url));
    let changed = nextTrackedProducts.length !== trackedProducts.length;

    for (const bp of backendProducts) {
      const local = nextTrackedProducts.find((p) => p.url === bp.url);
      if (!local) {
        nextTrackedProducts.push({
          url: bp.url,
          backendId: bp.id ?? null,
          name: bp.product_name,
          siteName: bp.site_name || null,
          selector: bp.custom_selector,
          originalSelector: bp.original_price_selector || "",
          lastPrice: bp.current_price,
          lastOriginalPrice: bp.original_price ?? null,
          lastChecked: bp.last_checked,
          threshold: normalizeThreshold(bp.threshold),
          frequency: normalizeFrequency(bp.frequency),
          currencyCode: bp.currency_code || null,
          currencySymbol: bp.currency_symbol || "$",
          previousPrice: null,
        });
        changed = true;
        continue;
      }

      const nextName = bp.product_name || local.name;
      const nextSelector = bp.custom_selector || local.selector;
      const nextOriginalSelector = bp.original_price_selector || local.originalSelector || "";
      const nextPrice = bp.current_price != null ? bp.current_price : local.lastPrice;
      const nextOriginalPrice =
        bp.original_price != null ? bp.original_price : local.lastOriginalPrice ?? null;
      const nextChecked = bp.last_checked || local.lastChecked;
      const nextThreshold = bp.threshold == null ? normalizeThreshold(local.threshold) : normalizeThreshold(bp.threshold);
      const nextFrequency = normalizeFrequency(bp.frequency || local.frequency);
      const nextSiteName = bp.site_name || local.siteName || null;
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

    if (changed) await setStorage({ trackedProducts: nextTrackedProducts });
  } catch (err) {
    console.warn("[Traker] backend sync failed:", err);
  }
}

async function init() {
  const { extensionTheme = "", extensionAvatar = "purple" } = await getStorage(["extensionTheme", "extensionAvatar"]);
  currentAvatarName = AVATAR_NAMES.includes(extensionAvatar) ? extensionAvatar : "purple";
  let theme = extensionTheme;
  if (!theme) {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeButton(theme);

  const {
    authToken = "",
    authEmail = "",
    trackedProducts = [],
  } = await getStorage([
    "authToken",
    "authEmail",
    "trackedProducts",
  ]);
  updateAuthDisplay(authToken, authEmail);
  renderProducts(trackedProducts);
}

async function refreshFromBackendAndRender() {
  const { authToken = "" } = await getStorage(["authToken"]);
  if (!authToken) return;
  if (isSettingsInteractionActive()) return;
  await syncWithBackend();
  const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
  renderProducts(trackedProducts);
}

async function deleteAccountFromPopup() {
  if (!confirm("Are you sure you want to permanently delete your account? This will remove all your tracked products, price history, and settings. This cannot be undone.")) {
    return;
  }
  if (!confirm("This is permanent. All your data will be deleted immediately. Continue?")) {
    return;
  }

  closeProfileDropdown();

  try {
    const resp = await extFetchWithRefresh(`${API_BASE_URL}/auth/account`, {
      method: "DELETE",
    });

    if (!resp.ok) {
      const data = await parseResponseBody(resp);
      throw new Error(data?.detail || "Failed to delete account.");
    }

    await setStorage({
      authToken: "",
      refreshToken: "",
      authEmail: "",
      trackedProducts: [],
    });

    updateAuthDisplay("", "");
    renderProducts([]);
    showStatus("Account deleted successfully.", "ok");
  } catch (err) {
    console.warn("[Traker] account deletion failed:", err);
    showStatus(err?.message || "Failed to delete account.", "err");
  }
}

elBtnLogin.addEventListener("click", async () => {
  const email = (elAuthEmail.value || "").trim();
  const password = elAuthPassword.value || "";
  if (!email || !password) {
    elAuthError.textContent = "Email and password are required.";
    return;
  }
  elBtnLogin.disabled = true;
  elAuthError.textContent = "";
  try {
    const loginData = await loginFromPopup(API_BASE_URL, email, password);
    updateAuthDisplay(loginData?.access_token || "token", email);
    await refreshFromBackendAndRender();
  } catch (err) {
    elAuthError.textContent = err?.message || "Login failed";
    console.warn("[Traker] login_failed email=%s error=%s", email, err?.message || "unknown");
  } finally {
    elBtnLogin.disabled = false;
  }
});

elBtnGoogle.addEventListener("click", async () => {
  elBtnGoogle.disabled = true;
  elBtnLogin.disabled = true;
  elAuthError.textContent = "";
  try {
    const result = await loginWithGoogle();
    updateAuthDisplay(result?.access_token || "token", result?.email || "");
    await refreshFromBackendAndRender();
  } catch (err) {
    elAuthError.textContent = err?.message || "Google sign-in failed";
    console.warn("[Traker] google_signin_failed error=%s", err?.message || "unknown");
  } finally {
    elBtnGoogle.disabled = false;
    elBtnLogin.disabled = false;
  }
});

elLinkSignup.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${WEB_APP_URL}/?view=register` });
});

elLinkForgotPassword.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${WEB_APP_URL}/?view=forgot-password` });
});

elBtnProfile.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleProfileDropdown();
});

document.addEventListener("click", (e) => {
  if (profileDropdownOpen && !elProfileWrap.contains(e.target)) {
    closeProfileDropdown();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && profileDropdownOpen) {
    closeProfileDropdown();
    elBtnProfile.focus();
  }
});

elBtnLogout.addEventListener("click", async () => {
  closeProfileDropdown();
  await logoutFromPopup();
  updateAuthDisplay("", "");
});

elBtnTheme.addEventListener("click", async () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  await setStorage({ extensionTheme: next });
  updateThemeButton(next);
});

elBtnDeleteAccount.addEventListener("click", deleteAccountFromPopup);

elAuthPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    elBtnLogin.click();
  }
});

// --- Pick price button ---

elBtnPick.addEventListener("click", async () => {
  const authToken = await requireAuth();
  if (!authToken) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus("No active tab found.", "err");
    return;
  }

  // Block internal browser pages early
  try {
    const tabUrl = new URL(tab.url || "");
    if (tabUrl.protocol === "chrome:" || tabUrl.protocol === "chrome-extension:" || tabUrl.protocol === "about:") {
      showStatus("This page can't be tracked (browser internal page).", "err");
      return;
    }
  } catch {
    showStatus("This page can't be tracked.", "err");
    return;
  }

  const origin = new URL(tab.url).origin + "/*";

  // Check if we already have permission for this domain
  let hasPermission = false;
  try {
    hasPermission = await chrome.permissions.contains({ origins: [origin] });
  } catch {}

  if (hasPermission) {
    // Permission already granted — inject picker directly and close popup
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content_picker.js"],
      });
      window.close();
    } catch (err) {
      console.warn("[Traker] picker injection failed:", err);
      showStatus(friendlyError(err), "err");
    }
    return;
  }

  // No permission yet — tell background to inject the picker into this tab
  // after permission is granted, then request permission. The native Chrome
  // dialog will close the popup, but background.js will handle the injection.
  try {
    await chrome.runtime.sendMessage({
      action: "pending_popup_pick",
      tabId: tab.id,
      origin: origin,
    });
  } catch (err) {
    console.warn("[Traker] failed to register pending pick:", err);
  }

  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    // If we get here (popup survived), inject directly
    if (granted) {
      // Clear the pending pick since we'll handle it here
      try {
        await chrome.runtime.sendMessage({ action: "clear_pending_popup_pick" });
      } catch {}
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content_picker.js"],
        });
        window.close();
      } catch (err) {
        console.warn("[Traker] picker injection failed:", err);
        showStatus(friendlyError(err), "err");
      }
    } else {
      console.warn("[Traker] host permission denied for %s", origin);
      try {
        await chrome.runtime.sendMessage({ action: "clear_pending_popup_pick" });
      } catch {}
      showStatus("Permission denied. Background price checks won't work for this site.", "err");
    }
  } catch (err) {
    console.warn("[Traker] permission request failed:", err);
    showStatus(friendlyError(err), "err");
  }
});

// --- Check all prices button ---

elBtnCheck.addEventListener("click", async () => {
  const authToken = await requireAuth();
  if (!authToken) return;

  elBtnCheck.disabled = true;
  showStatus("Checking prices…", "info");

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "check_all_prices" }, (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(resp);
      });
    });

    const { trackedProducts = [] } = await getStorage(["trackedProducts"]);
    renderProducts(trackedProducts);
    showStatus("Price check complete.", "ok");
  } catch (err) {
    console.warn("[Traker] check all failed:", err);
    showStatus(friendlyError(err), "err");
  } finally {
    elBtnCheck.disabled = false;
  }
});

// --- Listen for updates from background (e.g. after selector_picked) ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "products_updated") {
    refreshFromBackendAndRender().then(() => {
      if (msg.data?.userMessage) {
        showStatus(msg.data.userMessage, "ok");
      }
    });
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  await init();
  await refreshFromBackendAndRender();
  const intervalId = setInterval(refreshFromBackendAndRender, 20000);
  window.addEventListener("unload", () => clearInterval(intervalId), { once: true });
});
