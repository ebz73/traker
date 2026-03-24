// Guard against double-injection
if (window.__trakerPickerActive) {
  // Already running — do nothing
} else {
  window.__trakerPickerActive = true;

  (function () {
    let domInjectedPickerData = {};
    try {
      const rawPickerData = document.documentElement?.getAttribute("data-traker-picker");
      if (rawPickerData) {
        domInjectedPickerData = JSON.parse(rawPickerData);
      }
    } catch (err) {
      console.warn("[Traker] failed to parse injected picker prefill data:", err);
      domInjectedPickerData = {};
    }
    const injectedPickerData = window.__trakerPickerData || domInjectedPickerData || {};
    const prefilledThreshold = injectedPickerData.threshold;
    const prefilledFrequency = injectedPickerData.frequency || "24h";
    if (document.documentElement) {
      document.documentElement.removeAttribute("data-traker-picker");
    }

    // --- Price extraction helper ---
    function extractPriceFromText(text) {
      if (!text) return null;
      const match = text.match(
        /(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)\s*[\d.,]+|[\d.,]+\s*(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+[.,]\d{1,2}\b/i
      );
      if (!match) return null;
      let cleaned = match[0].replace(/[^\d.,]/g, "");
      const lastComma = cleaned.lastIndexOf(",");
      const lastDot = cleaned.lastIndexOf(".");

      if (lastComma > lastDot) {
        cleaned = cleaned.replace(/\./g, "");
        const commaIndex = cleaned.lastIndexOf(",");
        cleaned = `${cleaned.slice(0, commaIndex).replace(/,/g, "")}.${cleaned.slice(commaIndex + 1)}`;
      } else if (lastDot > lastComma) {
        cleaned = cleaned.replace(/,/g, "");
      } else if (lastComma >= 0) {
        const decimalPart = cleaned.slice(lastComma + 1);
        if (decimalPart.length === 1 || decimalPart.length === 2) {
          cleaned = `${cleaned.slice(0, lastComma).replace(/,/g, "")}.${decimalPart}`;
        } else {
          cleaned = cleaned.replace(/,/g, "");
        }
      } else if (lastDot >= 0) {
        const decimalPart = cleaned.slice(lastDot + 1);
        if (decimalPart.length === 3) {
          cleaned = cleaned.replace(/\./g, "");
        }
      }

      const value = parseFloat(cleaned);
      return Number.isFinite(value) && value > 0 && value < 1000000 ? value : null;
    }

    function getSiteName() {
      const ogTag = document.querySelector('meta[property="og:site_name"]');
      if (ogTag) {
        const val = (ogTag.getAttribute("content") || "").trim();
        if (val && val.length < 100) return val;
      }
      const appTag = document.querySelector('meta[name="application-name"]');
      if (appTag) {
        const val = (appTag.getAttribute("content") || "").trim();
        if (val && val.length < 100) return val;
      }
      return null;
    }

    let cachedJsonLdPrice = undefined;

    function getJsonLdPrice() {
      if (cachedJsonLdPrice !== undefined) return cachedJsonLdPrice;
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      let foundPrice = null;

      const findOfferPrice = (node) => {
        if (!node) return null;
        if (Array.isArray(node)) {
          for (const item of node) {
            const nested = findOfferPrice(item);
            if (nested != null) return nested;
          }
          return null;
        }
        if (typeof node !== "object") return null;

        const typeValue = Array.isArray(node["@type"])
          ? node["@type"].join(" ")
          : node["@type"];
        if (typeof typeValue === "string" && /\b(?:Offer|AggregateOffer)\b/i.test(typeValue)) {
          for (const rawPrice of [node.price, node.lowPrice, node.highPrice]) {
            if (rawPrice == null) continue;
            const parsed =
              extractPriceFromText(String(rawPrice)) ??
              (Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null);
            if (parsed != null) return parsed;
          }
        }

        for (const value of Object.values(node)) {
          const nested = findOfferPrice(value);
          if (nested != null) return nested;
        }
        return null;
      };

      for (const script of scripts) {
        try {
          const raw = (script.textContent || "").trim();
          if (!raw) continue;
          const price = findOfferPrice(JSON.parse(raw));
          if (price != null) {
            foundPrice = price;
            break;
          }
        } catch (err) {
          // Ignore invalid or unrelated JSON-LD blocks.
        }
      }
      cachedJsonLdPrice = foundPrice || null;
      return cachedJsonLdPrice;
    }

    let cachedJsonLdSaleSignal = undefined;

    function hasJsonLdSaleSignal() {
      if (cachedJsonLdSaleSignal !== undefined) return cachedJsonLdSaleSignal;
      cachedJsonLdSaleSignal = false;

      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

      const findSaleSignal = (node) => {
        if (!node) return false;
        if (Array.isArray(node)) return node.some(findSaleSignal);
        if (typeof node !== "object") return false;

        const typeValue = Array.isArray(node["@type"])
          ? node["@type"].join(" ")
          : node["@type"] || "";

        if (/\b(?:Offer|AggregateOffer|Product)\b/i.test(String(typeValue))) {
          // Only trust explicit listPrice > price on the SAME node.
          // Do not compare across multiple offers because seller ranges are not sales.
          const salePrice =
            extractPriceFromText(String(node.price ?? "")) ??
            (Number.isFinite(Number(node.price)) ? Number(node.price) : null);
          const listPrice =
            extractPriceFromText(String(node.listPrice ?? "")) ??
            (Number.isFinite(Number(node.listPrice)) ? Number(node.listPrice) : null);

          if (salePrice != null && listPrice != null && listPrice > salePrice) {
            return true;
          }
        }

        return Object.values(node).some((value) =>
          typeof value === "object" && value !== null ? findSaleSignal(value) : false
        );
      };

      for (const script of scripts) {
        try {
          const raw = (script.textContent || "").trim();
          if (!raw) continue;
          if (findSaleSignal(JSON.parse(raw))) {
            cachedJsonLdSaleSignal = true;
            break;
          }
        } catch {
          // Ignore invalid JSON-LD blocks
        }
      }

      return cachedJsonLdSaleSignal;
    }

    function hasMetaTagSaleSignal() {
      const priceTag = document.querySelector(
        'meta[property="product:price:amount"], meta[property="og:price:amount"]'
      );
      const salePriceTag = document.querySelector('meta[property="product:sale_price:amount"]');
      if (!salePriceTag) return false;

      const salePrice = extractPriceFromText(salePriceTag.getAttribute("content") || "");
      if (salePrice == null) return false;

      if (!priceTag) return true;

      const regularPrice = extractPriceFromText(priceTag.getAttribute("content") || "");
      return regularPrice == null || regularPrice !== salePrice;
    }

    function hasSaleBadgeNearPrice(el) {
      // Require discount-specific language so site-wide promo copy does not trip this.
      const SALE_BADGE_RE =
        /\b(clearance|reduced|save\s+\$?\d|% off|\d+%\s*off|flash.?sale|price.?cut|markdown|on sale)\b/i;
      const STRUCTURAL_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
      const elRect = el.getBoundingClientRect();
      let parent = el.parentElement;
      for (let depth = 0; depth < 2 && parent; depth += 1) {
        if (STRUCTURAL_TAGS.has(parent.tagName)) break;

        for (const sibling of Array.from(parent.children || [])) {
          if (sibling === el) continue;
          if (STRUCTURAL_TAGS.has(sibling.tagName)) continue;

          const sibText = normalizeText(sibling.textContent || "");
          if (sibText.length === 0 || sibText.length > 50) continue;

          const sibRect = sibling.getBoundingClientRect();
          if (sibRect.height === 0 || sibRect.width === 0) continue;
          if (Math.abs(sibRect.top - elRect.top) > 150) continue;

          if (SALE_BADGE_RE.test(sibText)) {
            return true;
          }
        }
        parent = parent.parentElement;
      }
      return false;
    }

    // --- Bottom red banner (price picker toolbar) ---
    // This whole block builds the fixed bar shown at the bottom of the page:
    // instruction text + threshold/frequency fields + cancel/save actions.
    // For manual UI tweaks, start with this section and `applyResponsiveLayout`.
    const banner = document.createElement("div");
    const bannerInfo = document.createElement("div");
    const bannerText = document.createElement("div");
    const bannerSubtext = document.createElement("div");
    const modeWrap = document.createElement("div");
    const saleModeButton = document.createElement("button");
    const originalModeButton = document.createElement("button");
    const fieldsWrap = document.createElement("div");
    const thresholdField = document.createElement("div");
    const thresholdLabel = document.createElement("label");
    const thresholdInput = document.createElement("input");
    const frequencyField = document.createElement("div");
    const frequencyLabel = document.createElement("label");
    const frequencySelect = document.createElement("select");
    const actionsWrap = document.createElement("div");
    const cancelButton = document.createElement("button");
    const saveButton = document.createElement("button");

    bannerText.innerText = "Picking Sale Price";
    bannerSubtext.innerText = "Click the live sale price. Original price is optional.";
    thresholdLabel.innerText = "Threshold";
    frequencyLabel.innerText = "Frequency";

    thresholdInput.type = "number";
    thresholdInput.min = "0";
    thresholdInput.step = "0.01";
    thresholdInput.placeholder = "$ Threshold";
    thresholdInput.inputMode = "decimal";

    const frequencyOptions = [
      { value: "6h", label: "Every 6 hours" },
      { value: "12h", label: "Every 12 hours" },
      { value: "24h", label: "Daily" },
      { value: "7d", label: "Weekly" },
      { value: "30d", label: "Monthly" },
    ];
    for (const option of frequencyOptions) {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      frequencySelect.appendChild(opt);
    }

    cancelButton.type = "button";
    cancelButton.innerText = "Cancel";
    saveButton.type = "button";
    saveButton.innerText = "Select a sale price";
    saleModeButton.type = "button";
    saleModeButton.innerText = "Sale Price";
    originalModeButton.type = "button";
    originalModeButton.innerText = "Original Price";

    // Outer red container pinned to the bottom edge of the page.
    Object.assign(banner.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      width: "100%",
      zIndex: "2147483647",
      padding: "10px 14px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-end",
      flexWrap: "wrap",
      gap: "12px",
      color: "#fff",
      background: "linear-gradient(90deg, #cc0000 0%, #d91a1a 100%)",
      boxShadow: "0 6px 16px rgba(0,0,0,0.30)",
      borderRadius: "14px 14px 0 0",
      pointerEvents: "auto",
      boxSizing: "border-box",
    });

    Object.assign(bannerInfo.style, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      flex: "1 1 260px",
      minWidth: "220px",
    });

    Object.assign(bannerText.style, {
      fontSize: "20px",
      fontWeight: "700",
      lineHeight: "1.2",
    });

    Object.assign(bannerSubtext.style, {
      fontSize: "13px",
      color: "rgba(255,255,255,0.88)",
      lineHeight: "1.35",
    });

    Object.assign(modeWrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexWrap: "wrap",
      flex: "0 0 auto",
    });

    const modeButtonStyle = {
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,0.22)",
      padding: "7px 12px",
      fontSize: "13px",
      fontWeight: "700",
      cursor: "pointer",
      color: "#fff",
      background: "rgba(255,255,255,0.1)",
      boxSizing: "border-box",
      transition: "background 120ms ease, border-color 120ms ease, transform 120ms ease",
    };
    Object.assign(saleModeButton.style, modeButtonStyle);
    Object.assign(originalModeButton.style, modeButtonStyle);

    // Middle controls wrapper (Threshold + Frequency groups).
    Object.assign(fieldsWrap.style, {
      display: "flex",
      alignItems: "flex-end",
      gap: "10px",
      flex: "1 1 auto",
    });

    Object.assign(thresholdField.style, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });

    Object.assign(frequencyField.style, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });

    // Shared style used by "Threshold" and "Frequency" labels.
    const labelStyle = {
      fontSize: "14px",
      fontWeight: "700",
      color: "rgba(255,255,255,0.92)",
      lineHeight: "1",
    };
    Object.assign(thresholdLabel.style, labelStyle);
    Object.assign(frequencyLabel.style, labelStyle);

    // Shared style used by the threshold input and frequency select.
    const inputStyle = {
      width: "240px",
      height: "32px",
      borderRadius: "7px",
      border: "1px solid rgba(0,0,0,0.12)",
      padding: "4px 8px",
      fontSize: "13px",
      background: "#fff",
      color: "#222",
      boxSizing: "border-box",
    };
    Object.assign(thresholdInput.style, inputStyle);
    Object.assign(frequencySelect.style, inputStyle);

    // Right-side actions wrapper (Cancel + Save buttons).
    Object.assign(actionsWrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexShrink: "0",
    });

    // Secondary action button style.
    Object.assign(cancelButton.style, {
      background: "#ffffff",
      color: "#d62828",
      border: "1px solid #ffd0d0",
      borderRadius: "8px",
      padding: "8px 12px",
      minWidth: "92px",
      fontSize: "14px",
      fontWeight: "700",
      cursor: "pointer",
      height: "36px",
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    });

    // Primary action button style. Color/disabled state is updated dynamically in `updateSaveButton`.
    Object.assign(saveButton.style, {
      background: "#9aa0a6",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      padding: "8px 12px",
      minWidth: "300px",
      fontSize: "14px",
      fontWeight: "700",
      cursor: "not-allowed",
      height: "36px",
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    });

    thresholdField.appendChild(thresholdLabel);
    thresholdField.appendChild(thresholdInput);
    frequencyField.appendChild(frequencyLabel);
    frequencyField.appendChild(frequencySelect);
    fieldsWrap.appendChild(thresholdField);
    fieldsWrap.appendChild(frequencyField);

    actionsWrap.appendChild(cancelButton);
    actionsWrap.appendChild(saveButton);

    bannerInfo.appendChild(bannerText);
    bannerInfo.appendChild(bannerSubtext);
    modeWrap.appendChild(saleModeButton);
    modeWrap.appendChild(originalModeButton);

    banner.appendChild(bannerInfo);
    banner.appendChild(modeWrap);
    banner.appendChild(fieldsWrap);
    banner.appendChild(actionsWrap);
    document.body.appendChild(banner);

    if (
      prefilledThreshold !== "" &&
      prefilledThreshold != null &&
      Number.isFinite(Number(prefilledThreshold)) &&
      Number(prefilledThreshold) >= 0
    ) {
      thresholdInput.value = String(prefilledThreshold);
    }
    if (frequencyOptions.some((f) => f.value === prefilledFrequency)) {
      frequencySelect.value = prefilledFrequency;
    } else {
      frequencySelect.value = "24h";
    }

    // Responsive overrides for the bottom banner.
    // Edit breakpoints/sizes here to change mobile vs desktop layout behavior.
    const applyResponsiveLayout = () => {
      const viewportWidth = Math.max(window.innerWidth || 0, 320);
      const isCompact = viewportWidth <= 1280;
      const isSmall = viewportWidth <= 760;
      const isTransition = viewportWidth <= 1500 && !isSmall;
      const fluidMinViewport = 760;
      const fluidMaxViewport = 1600;
      const fluidViewport = Math.min(fluidMaxViewport, Math.max(fluidMinViewport, viewportWidth));
      const fluidRatio = (fluidViewport - fluidMinViewport) / (fluidMaxViewport - fluidMinViewport);
      const controlWidthPx = Math.round(148 + fluidRatio * 92);
      const saveMinWidthPx = Math.round(170 + fluidRatio * 170);
      const cancelMinWidthPx = Math.round(96 + fluidRatio * 16);
      const controlWidth = isSmall || isTransition ? "100%" : `${controlWidthPx}px`;
      const saveMinWidth = isSmall ? "0" : `${saveMinWidthPx}px`;
      const cancelMinWidth = isSmall ? "96px" : `${cancelMinWidthPx}px`;

      banner.style.padding = isSmall ? "10px 10px 12px" : isCompact ? "10px 12px" : "10px 14px";
      banner.style.gap = isSmall ? "8px" : "12px";
      banner.style.justifyContent = "flex-start";
      banner.style.alignItems = isSmall ? "stretch" : "flex-end";

      bannerInfo.style.flex = isSmall ? "1 1 100%" : isTransition ? "1 1 55%" : "1 1 260px";
      bannerInfo.style.minWidth = isSmall ? "0" : isTransition ? "180px" : "220px";
      bannerText.style.fontSize = isSmall ? "18px" : isCompact ? "19px" : "20px";
      bannerSubtext.style.fontSize = isSmall ? "12px" : "13px";

      modeWrap.style.width = isSmall ? "100%" : "auto";
      modeWrap.style.flex = isSmall ? "1 1 100%" : "0 0 auto";
      modeWrap.style.justifyContent = isSmall ? "flex-start" : "center";
      modeWrap.style.marginLeft = isSmall || !isTransition ? "0" : "auto";
      saleModeButton.style.fontSize = isSmall ? "14px" : "13px";
      originalModeButton.style.fontSize = isSmall ? "14px" : "13px";
      saleModeButton.style.padding = isSmall ? "9px 14px" : "7px 12px";
      originalModeButton.style.padding = isSmall ? "9px 14px" : "7px 12px";

      thresholdLabel.style.fontSize = isSmall ? "13px" : isCompact ? "13px" : "14px";
      frequencyLabel.style.fontSize = isSmall ? "13px" : isCompact ? "13px" : "14px";

      fieldsWrap.style.flex = isSmall ? "1 1 100%" : isTransition ? "0 1 54%" : "0 1 auto";
      fieldsWrap.style.width = isSmall ? "100%" : isTransition ? "54%" : "auto";
      fieldsWrap.style.gap = isSmall ? "8px" : "10px";

      thresholdField.style.flex = isSmall || isTransition ? "1 1 0" : "0 0 auto";
      frequencyField.style.flex = isSmall || isTransition ? "1 1 0" : "0 0 auto";

      thresholdInput.style.width = controlWidth;
      frequencySelect.style.width = controlWidth;
      thresholdInput.style.height = isSmall ? "40px" : "32px";
      frequencySelect.style.height = isSmall ? "40px" : "32px";
      thresholdInput.style.fontSize = isSmall ? "15px" : "13px";
      frequencySelect.style.fontSize = isSmall ? "15px" : "13px";

      actionsWrap.style.width = isSmall ? "100%" : isTransition ? "44%" : "auto";
      actionsWrap.style.flex = isSmall ? "1 1 100%" : isTransition ? "0 1 44%" : "0 0 auto";
      actionsWrap.style.justifyContent = isSmall ? "flex-start" : "flex-end";
      actionsWrap.style.gap = isSmall ? "8px" : "10px";
      actionsWrap.style.marginLeft = isSmall ? "0" : "auto";

      cancelButton.style.height = isSmall ? "42px" : "36px";
      saveButton.style.height = isSmall ? "42px" : "36px";
      cancelButton.style.fontSize = isSmall ? "15px" : "14px";
      saveButton.style.fontSize = isSmall ? "15px" : "14px";
      cancelButton.style.padding = isSmall ? "6px 12px" : "8px 12px";
      saveButton.style.padding = isSmall ? "6px 12px" : "8px 12px";
      cancelButton.style.minWidth = cancelMinWidth;
      saveButton.style.minWidth = isSmall ? "0" : isTransition ? "220px" : saveMinWidth;
      cancelButton.style.flex = isSmall ? "0 0 auto" : "0 0 auto";
      saveButton.style.flex = isSmall ? "1 1 auto" : isTransition ? "1 1 auto" : "0 0 auto";
    };

    const onResize = () => {
      applyResponsiveLayout();
    };

    const PRICE_RE =
      /(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)\s*[\d,]+\.?\d{0,2}|[\d,]+\.\d{2}/i;
    const SPLIT_PRICE_FRAGMENT_RE =
      /^(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹|[\d,]+|[.,]\d{1,2})$/i;
    const POSITIVE_SEMANTIC_RE =
      /(price|current|sale|final|member|deal|offer|buy.?box|amount|value|subtotal|now)/i;
    const CURRENT_HINT_RE = /\b(current|sale|now|today|our|final|live|deal|member)\b/i;
    const OLD_PRICE_RE =
      /\b(was|compare(?:\s+at)?|comp\.?\s*value|original|msrp|list\s?price|regular(?:\s?price)?|reg\.?(?:\s?price)?|old\s?price|before|normally|typical)\b/i;
    const BADGE_RE = /\b(off|save|discount|coupon|promo|promotion|rebate|markdown)\b/i;
    const SHIPPING_RE =
      /\b(shipping|delivery|pickup|installment|monthly|per month|\/mo\b|pay in|pay later|klarna|afterpay|affirm|zip)\b/i;
    const NEGATIVE_SEMANTIC_RE =
      /\b(compare|original|msrp|list|regular|old|was|strike|strikethrough|discount|coupon|promo|shipping|delivery|installment|klarna|afterpay|affirm|save|off)\b/i;
    const PRICE_CANDIDATE_SELECTOR = [
      '[itemprop="price"]',
      '[data-testid*="price" i]',
      '[data-test*="price" i]',
      '[data-automation-id*="price" i]',
      '[data-qa*="price" i]',
      '[data-selector*="price" i]',
      '[data-price-type]',
      '[aria-label*="price" i]',
      '[class*="price" i]',
      '[class*="sale" i]',
      '[class*="current" i]',
      '[id*="price" i]',
      "del",
      "s",
      "strike",
    ].join(", ");
    const SELECTOR_STABLE_ATTRS = [
      "itemprop",
      "data-automation-id",
      "data-testid",
      "data-test",
      "data-hb-id",
      "data-component-type",
      "data-cy",
      "data-qa",
      "data-selector",
      "data-price-type",
    ];
    const MAX_SELECTOR_COUNT = 6;
    const SELECTION_STYLES = {
      sale: {
        label: "Sale Price",
        hoverOutline: "3px dashed #32CD32",
        hoverBackground: "rgba(50,205,50,0.12)",
        selectedOutline: "4px solid #32CD32",
        selectedBackground: "rgba(50,205,50,0.16)",
        accent: "#32CD32",
        accentSoft: "rgba(50,205,50,0.2)",
      },
      original: {
        label: "Original Price",
        hoverOutline: "3px dashed #8A2BE2",
        hoverBackground: "rgba(138,43,226,0.12)",
        selectedOutline: "4px solid #8A2BE2",
        selectedBackground: "rgba(138,43,226,0.18)",
        accent: "#8A2BE2",
        accentSoft: "rgba(138,43,226,0.22)",
      },
    };
    let highlighted = null;
    let saleCandidate = null;
    let originalCandidate = null;
    let selectionMode = "sale";
    const originalStyles = new WeakMap();
    const elementMetaCache = new WeakMap();

    const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();

    const samePrice = (a, b) =>
      a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.009;

    const getOwnText = (el) =>
      normalizeText(
        Array.from(el.childNodes || [])
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
      );

    const getPriceMatchCount = (text) => {
      const matches = normalizeText(text).match(new RegExp(PRICE_RE.source, "ig"));
      return matches ? matches.length : 0;
    };

    const countSplitPriceFragments = (el) => {
      let count = 0;
      for (const node of Array.from(el.childNodes || []).slice(0, 10)) {
        const text = normalizeText(node.textContent || "");
        if (!text || text.length > 18) continue;
        if (SPLIT_PRICE_FRAGMENT_RE.test(text)) {
          count += 1;
        }
      }
      return count;
    };

    const parseRgb = (color) => {
      const match = (color || "").match(
        /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i
      );
      if (!match) return null;
      return {
        r: Number.parseFloat(match[1]),
        g: Number.parseFloat(match[2]),
        b: Number.parseFloat(match[3]),
        a: match[4] == null ? 1 : Number.parseFloat(match[4]),
      };
    };

    const isMutedColor = (color) => {
      const rgb = parseRgb(color);
      if (!rgb) return false;
      const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
      const average = (rgb.r + rgb.g + rgb.b) / 3;
      return spread < 18 && average > 80 && average < 190 && rgb.a > 0.35;
    };

    const hasPseudoStrike = (el) => {
      for (const pseudo of ["::before", "::after"]) {
        const pseudoStyle = window.getComputedStyle(el, pseudo);
        if ((pseudoStyle.textDecorationLine || "").includes("line-through")) {
          return true;
        }
        const borderTop = Number.parseFloat(pseudoStyle.borderTopWidth || "0");
        const borderBottom = Number.parseFloat(pseudoStyle.borderBottomWidth || "0");
        const positioned = ["absolute", "fixed", "sticky"].includes(pseudoStyle.position);
        if (positioned && (borderTop > 0 || borderBottom > 0)) {
          return true;
        }
      }
      return false;
    };

    const hasSvgStrike = (el, rect) => {
      const svgChildren = Array.from(el.querySelectorAll("svg, line, path")).slice(0, 8);
      for (const svgNode of svgChildren) {
        const svgRect = svgNode.getBoundingClientRect();
        if (svgRect.width <= 0 || svgRect.height <= 0) continue;
        const svgContainer = svgNode.closest("svg") || svgNode;
        const nodeStyle = window.getComputedStyle(svgNode);
        const containerStyle = window.getComputedStyle(svgContainer);
        const positioned =
          ["absolute", "fixed", "sticky"].includes(nodeStyle.position) ||
          ["absolute", "fixed", "sticky"].includes(containerStyle.position);
        const overlapsHorizontally = svgRect.left <= rect.right && svgRect.right >= rect.left;
        const crossesTextMidline =
          svgRect.top <= rect.top + rect.height * 0.65 &&
          svgRect.bottom >= rect.top + rect.height * 0.35;
        if (positioned && overlapsHorizontally && crossesTextMidline) {
          return true;
        }
      }
      return false;
    };

    const getComposedParent = (node) => {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const rootNode = node.getRootNode?.();
      return rootNode instanceof ShadowRoot ? rootNode.host : null;
    };

    const composedContains = (container, target) => {
      let current = target;
      while (current) {
        if (current === container) return true;
        current = getComposedParent(current);
      }
      return false;
    };

    const splitSelectorList = (selectorValue) => {
      if (!selectorValue || typeof selectorValue !== "string") return [];
      const parts = [];
      let current = "";
      let quote = null;
      let bracketDepth = 0;
      let parenDepth = 0;

      for (let index = 0; index < selectorValue.length; index += 1) {
        const char = selectorValue[index];
        if (quote) {
          current += char;
          if (char === "\\" && index + 1 < selectorValue.length) {
            current += selectorValue[index + 1];
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
    };

    const collectQueryRoots = (root = document) => {
      const roots = [];
      const seen = new Set();
      const queue = [root];

      while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        roots.push(current);

        if (current instanceof Element && current.shadowRoot) {
          queue.push(current.shadowRoot);
        }

        const walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          if (node.shadowRoot) {
            queue.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      }

      return roots;
    };

    const collectPiercingElements = (root, limit = Infinity) => {
      const elements = [];
      const seen = new Set();
      const queue = [root];

      while (queue.length && elements.length < limit) {
        const current = queue.shift();
        if (!current) continue;

        if (current instanceof Element) {
          if (!seen.has(current)) {
            seen.add(current);
            elements.push(current);
          }
          if (current.shadowRoot) {
            queue.push(current.shadowRoot);
          }
          queue.push(...Array.from(current.children || []));
          continue;
        }

        if (current instanceof Document) {
          if (current.documentElement) {
            queue.push(current.documentElement);
          }
          continue;
        }

        if (current instanceof ShadowRoot) {
          queue.push(...Array.from(current.children || []));
        }
      }

      return elements;
    };

    const parseTextSelectorValue = (selector) => {
      const raw = selector.replace(/^text=/i, "").trim();
      if (!raw) return "";
      try {
        return JSON.parse(raw);
      } catch (err) {
        if (
          (raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'"))
        ) {
          return raw.slice(1, -1);
        }
        return raw;
      }
    };

    const evaluateXPathSelector = (selector, root = document) => {
      const expression = selector.replace(/^xpath=/i, "").trim();
      if (!expression) return [];

      const doc = root instanceof Document ? root : root.ownerDocument || document;
      const contextRoot = root instanceof Document ? null : root instanceof ShadowRoot ? root.host : root;
      const results = [];
      const seen = new Set();
      const snapshot = doc.evaluate(
        expression,
        doc,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );

      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        const el =
          node instanceof Element
            ? node
            : node?.parentElement instanceof Element
              ? node.parentElement
              : null;
        if (!el || seen.has(el)) continue;
        if (
          contextRoot &&
          !(
            el === contextRoot ||
            composedContains(contextRoot, el) ||
            composedContains(el, contextRoot)
          )
        ) {
          continue;
        }
        seen.add(el);
        results.push(el);
      }

      return results;
    };

    const findTextSelectorElements = (selector, root = document) => {
      const expected = normalizeText(parseTextSelectorValue(selector));
      if (!expected) return [];

      const contextRoot = root instanceof Document ? null : root instanceof ShadowRoot ? root.host : root;
      const results = [];
      const seen = new Set();

      for (const queryRoot of collectQueryRoots(root)) {
        const walker = document.createTreeWalker(queryRoot, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const text = normalizeText(node.textContent || "");
            return text.includes(expected) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });

        let node = walker.nextNode();
        while (node) {
          const el = node.parentElement;
          if (
            el &&
            !seen.has(el) &&
            (!contextRoot ||
              el === contextRoot ||
              composedContains(contextRoot, el) ||
              composedContains(el, contextRoot))
          ) {
            seen.add(el);
            results.push(el);
          }
          node = walker.nextNode();
        }
      }

      return results;
    };

    const querySelectorAllPiercing = (selector, root = document) => {
      if (!selector || typeof selector !== "string") return [];
      if (/^xpath=/i.test(selector)) {
        return evaluateXPathSelector(selector, root);
      }
      if (/^text=/i.test(selector)) {
        return findTextSelectorElements(selector, root);
      }

      const results = [];
      const seen = new Set();
      for (const queryRoot of collectQueryRoots(root)) {
        if (queryRoot instanceof Element && queryRoot.matches(selector) && !seen.has(queryRoot)) {
          seen.add(queryRoot);
          results.push(queryRoot);
        }

        if (
          !(
            queryRoot instanceof Document ||
            queryRoot instanceof Element ||
            queryRoot instanceof ShadowRoot
          )
        ) {
          continue;
        }

        for (const match of Array.from(queryRoot.querySelectorAll(selector))) {
          if (seen.has(match)) continue;
          seen.add(match);
          results.push(match);
        }
      }
      return results;
    };

    const getSemanticText = (el) =>
      normalizeText(
        [
          el.id || "",
          Array.from(el.classList || []).join(" "),
          el.getAttribute("itemprop") || "",
          el.getAttribute("data-testid") || "",
          el.getAttribute("data-test") || "",
          el.getAttribute("data-automation-id") || "",
          el.getAttribute("data-qa") || "",
          el.getAttribute("data-selector") || "",
          el.getAttribute("data-price-type") || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("role") || "",
        ].join(" ")
      );

    const getElementMeta = (el) => {
      if (!(el instanceof Element)) return null;
      if (elementMetaCache.has(el)) {
        return elementMetaCache.get(el);
      }

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const text = normalizeText(el.textContent || "");
      const ownText = getOwnText(el);
      const semanticText = getSemanticText(el);
      let fontWeight = Number.parseInt(style.fontWeight, 10);
      if (!Number.isFinite(fontWeight)) {
        fontWeight = style.fontWeight === "bold" ? 700 : 400;
      }

      const meta = {
        tagName: el.tagName.toLowerCase(),
        text,
        ownText,
        semanticText,
        price: extractPriceFromText(text),
        ownPrice: extractPriceFromText(ownText),
        priceMatchCount: getPriceMatchCount(text),
        splitFragmentCount: countSplitPriceFragments(el),
        fontSize: Number.parseFloat(style.fontSize) || 0,
        fontWeight,
        rect,
        isVisible:
          rect.width >= 2 &&
          rect.height >= 2 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0.05,
        isStrikethrough: (style.textDecorationLine || "").includes("line-through"),
        hasPseudoStrike: hasPseudoStrike(el),
        hasSvgStrike: hasSvgStrike(el, rect),
        isMuted:
          isMutedColor(style.color) ||
          /muted|secondary|subdued|tertiary|ghost/i.test(semanticText),
        ariaHidden: el.getAttribute("aria-hidden") === "true",
        currencyHint:
          /US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹/i.test(text),
      };

      elementMetaCache.set(el, meta);
      return meta;
    };

    const ensureOriginalStyle = (el) => {
      if (!originalStyles.has(el)) {
        originalStyles.set(el, {
          outline: el.style.outline || "",
          backgroundColor: el.style.backgroundColor || "",
          cursor: el.style.cursor || "",
          boxShadow: el.style.boxShadow || "",
        });
      }
    };

    const restoreStyle = (el) => {
      if (!originalStyles.has(el)) return;
      const style = originalStyles.get(el);
      el.style.outline = style.outline;
      el.style.backgroundColor = style.backgroundColor;
      el.style.cursor = style.cursor;
      el.style.boxShadow = style.boxShadow;
    };

    const applyHoverStyle = (el, mode) => {
      const style = SELECTION_STYLES[mode];
      ensureOriginalStyle(el);
      el.style.outline = style.hoverOutline;
      el.style.backgroundColor = style.hoverBackground;
      el.style.boxShadow = "none";
      el.style.cursor = "crosshair";
    };

    const applySelectedStyle = (el, mode) => {
      const style = SELECTION_STYLES[mode];
      ensureOriginalStyle(el);
      el.style.outline = style.selectedOutline;
      el.style.backgroundColor = style.selectedBackground;
      el.style.boxShadow = "none";
      el.style.cursor = "crosshair";
    };

    const getCandidateForMode = (mode) => (mode === "original" ? originalCandidate : saleCandidate);

    const setCandidateForMode = (mode, candidate) => {
      if (mode === "original") {
        originalCandidate = candidate;
      } else {
        saleCandidate = candidate;
      }
    };

    const getTrackedInteractiveElements = () =>
      Array.from(
        new Set(
          [highlighted, saleCandidate?.element, originalCandidate?.element].filter(
            (el) => el instanceof Element
          )
        )
      );

    const renderElementState = (el) => {
      if (!(el instanceof Element)) return;
      const isSaleSelected = saleCandidate?.element === el;
      const isOriginalSelected = originalCandidate?.element === el;
      const isHovered = highlighted === el;

      if (!isSaleSelected && !isOriginalSelected && !isHovered) {
        restoreStyle(el);
        return;
      }

      restoreStyle(el);

      if (isSaleSelected && isOriginalSelected) {
        ensureOriginalStyle(el);
        el.style.outline = SELECTION_STYLES.sale.selectedOutline;
        el.style.backgroundColor = SELECTION_STYLES.original.hoverBackground;
        el.style.boxShadow = `0 0 0 3px ${SELECTION_STYLES.original.accent} inset`;
        el.style.cursor = "crosshair";
        return;
      }

      if (isSaleSelected) {
        applySelectedStyle(el, "sale");
        return;
      }

      if (isOriginalSelected) {
        applySelectedStyle(el, "original");
        return;
      }

      if (isHovered) {
        applyHoverStyle(el, selectionMode);
      }
    };

    const refreshInteractiveStyles = (elements = []) => {
      const all = new Set([...getTrackedInteractiveElements(), ...elements]);
      for (const el of all) {
        if (!(el instanceof Element)) continue;
        renderElementState(el);
      }
    };

    const setSelectionMode = (mode) => {
      if (mode !== "sale" && mode !== "original") return;
      if (selectionMode === mode) return;
      selectionMode = mode;
      refreshInteractiveStyles();
      updateModeButtons();
      updateBannerCopy();
      updateSaveButton();
    };

    const clearHighlight = () => {
      const previous = highlighted;
      highlighted = null;
      refreshInteractiveStyles([previous]);
    };

    const updateHighlight = (candidate) => {
      const previous = highlighted;
      highlighted = candidate?.element || null;
      refreshInteractiveStyles([previous, highlighted]);
    };

    const setModeCandidate = (mode, candidate) => {
      const previous = getCandidateForMode(mode)?.element || null;
      setCandidateForMode(mode, candidate);
      highlighted = candidate?.element || highlighted;
      refreshInteractiveStyles([previous, highlighted]);
      updateModeButtons();
      updateBannerCopy();
      updateSaveButton();
    };

    const getThresholdValue = () => {
      const raw = (thresholdInput.value || "").trim();
      if (!raw) return null;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return parsed;
    };

    const updateModeButtons = () => {
      for (const [mode, button] of [
        ["sale", saleModeButton],
        ["original", originalModeButton],
      ]) {
        const isActive = selectionMode === mode;
        const hasSelection = Boolean(getCandidateForMode(mode)?.element);
        const style = SELECTION_STYLES[mode];
        button.textContent = `${style.label}${hasSelection ? " ✓" : ""}`;
        button.style.background = isActive ? style.accentSoft : "rgba(255,255,255,0.1)";
        button.style.borderColor = isActive ? style.accent : "rgba(255,255,255,0.22)";
        button.style.boxShadow = isActive ? `0 0 0 1px ${style.accent} inset` : "none";
        button.style.transform = isActive ? "translateY(-1px)" : "none";
      }
    };

    const updateBannerCopy = () => {
      const hasSaleSelection = Boolean(saleCandidate?.element);
      const hasOriginalSelection = Boolean(originalCandidate?.element);
      bannerText.textContent =
        selectionMode === "sale" ? "Picking Sale Price" : "Picking Original Price";

      const primaryInstruction =
        selectionMode === "sale"
          ? "Click the live sale price (if any)."
          : "Click the original or compare-at price (if any).";
      const statusParts = [];
      if (hasSaleSelection) {
        statusParts.push("Sale selected");
      }
      if (hasOriginalSelection) {
        statusParts.push("Original selected");
      }
      if (!statusParts.length) {
        statusParts.push("Select at least one price");
      }
      bannerSubtext.textContent = `${primaryInstruction} ${statusParts.join(" • ")}.`;
    };

    const updateSaveButton = () => {
      const hasSaleSelection = Boolean(saleCandidate?.element);
      const hasOriginalSelection = Boolean(originalCandidate?.element);
      const hasAnySelection = hasSaleSelection || hasOriginalSelection;
      const hasThreshold = getThresholdValue() !== null;
      const hasFrequency = Boolean(frequencySelect.value);
      const canSave = hasAnySelection && hasThreshold && hasFrequency;

      let hint = "";
      if (!hasAnySelection) {
        hint = "Select at least one price";
      } else if (!hasThreshold) {
        hint = "Enter threshold greater than 0";
      } else if (!hasFrequency) {
        hint = "Choose a check frequency";
      }

      saveButton.disabled = !canSave;
      saveButton.style.background = canSave ? "#00BB77" : "#8d949c";
      saveButton.style.color = "#fff";
      saveButton.style.cursor = canSave ? "pointer" : "not-allowed";

      let buttonText = "Save Price";
      if (canSave) {
        if (hasSaleSelection && hasOriginalSelection) buttonText = "Save Both Prices";
        else if (hasSaleSelection) buttonText = "Save Sale Price";
        else if (hasOriginalSelection) buttonText = "Save Original Price";
      }
      saveButton.innerText = canSave ? buttonText : hint;
      saveButton.title = canSave ? buttonText : hint;
    };

    const collectAncestorChain = (el, maxDepth = 6) => {
      const chain = [];
      let current = el;
      let depth = 0;
      while (
        current instanceof Element &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < maxDepth
      ) {
        if (!banner.contains(current)) {
          chain.push(current);
        }
        current = getComposedParent(current);
        depth += 1;
      }
      return chain;
    };

    const choosePriceRegion = (anchor) => {
      const chain = collectAncestorChain(anchor, 7);
      let fallback = chain[0] || anchor;

      for (const candidate of chain) {
        const meta = getElementMeta(candidate);
        if (!meta?.isVisible) continue;

        const reasonableWidth = meta.rect.width <= Math.max(window.innerWidth * 0.92, 720);
        const reasonableHeight = meta.rect.height <= Math.max(window.innerHeight * 0.55, 260);
        if (!reasonableWidth || !reasonableHeight) continue;

        const hasPriceContext =
          meta.price !== null ||
          meta.ownPrice !== null ||
          meta.splitFragmentCount >= 2 ||
          meta.priceMatchCount >= 2;
        const hasPositiveSemantic = POSITIVE_SEMANTIC_RE.test(meta.semanticText);
        const hasNegativeSemantic = NEGATIVE_SEMANTIC_RE.test(meta.semanticText);

        if (hasPriceContext || hasPositiveSemantic || hasNegativeSemantic) {
          fallback = candidate;
          if (hasPositiveSemantic || meta.priceMatchCount >= 2 || meta.splitFragmentCount >= 2) {
            return candidate;
          }
        }
      }

      return fallback;
    };

    const addCandidateElement = (set, el) => {
      if (
        !(el instanceof Element) ||
        el === document.body ||
        el === document.documentElement ||
        banner.contains(el)
      ) {
        return;
      }
      set.add(el);
    };

    const collectCandidateElements = (anchor, clientX, clientY, mode) => {
      const region = choosePriceRegion(anchor);
      const candidates = new Set();

      addCandidateElement(candidates, anchor);
      for (const el of collectAncestorChain(anchor, 6)) {
        addCandidateElement(candidates, el);
      }

      const pointStack =
        Number.isFinite(clientX) && Number.isFinite(clientY)
          ? document.elementsFromPoint(clientX, clientY).slice(0, 6)
          : [anchor];
      for (const el of pointStack) {
        addCandidateElement(candidates, el);
        for (const ancestor of collectAncestorChain(el, 4)) {
          addCandidateElement(candidates, ancestor);
        }
      }

      if (region) {
        addCandidateElement(candidates, region);
        for (const ancestor of collectAncestorChain(region, 3)) {
          addCandidateElement(candidates, ancestor);
        }

        try {
          const semanticMatches = querySelectorAllPiercing(PRICE_CANDIDATE_SELECTOR, region).slice(
            0,
            mode === "hover" ? 12 : 30
          );
          for (const match of semanticMatches) {
            addCandidateElement(candidates, match);
          }
        } catch (err) {
          console.warn("[Traker] candidate query failed:", err);
        }

        if (mode !== "hover") {
          let traversed = 0;
          for (const next of collectPiercingElements(region, 41)) {
            if (next === region || banner.contains(next)) continue;
            const meta = getElementMeta(next);
            if (!meta?.isVisible) continue;
            if (
              meta.price !== null ||
              meta.ownPrice !== null ||
              meta.splitFragmentCount >= 2 ||
              POSITIVE_SEMANTIC_RE.test(meta.semanticText) ||
              NEGATIVE_SEMANTIC_RE.test(meta.semanticText)
            ) {
              addCandidateElement(candidates, next);
              traversed += 1;
            }
            if (traversed >= 40) break;
          }
        }
      }

      return { region, elements: Array.from(candidates) };
    };

    const scoreCandidate = (el, context) => {
      const meta = getElementMeta(el);
      if (!meta?.isVisible) return null;
      const currentMode = context?.mode || selectionMode;

      const hasPriceLike =
        meta.price !== null ||
        meta.ownPrice !== null ||
        (meta.splitFragmentCount >= 2 && meta.price !== null) ||
        POSITIVE_SEMANTIC_RE.test(meta.semanticText);
      if (!hasPriceLike) return null;

      let score = 0;
      const reasons = [];
      let positiveSignals = 0;
      const candidatePrice = meta.ownPrice ?? meta.price;
      const trueLdPrice = getJsonLdPrice();
      if (trueLdPrice != null && samePrice(candidatePrice, trueLdPrice)) {
        if (currentMode === "original") {
          // In original mode, matching the JSON-LD sale price is a negative signal.
          score -= 30;
          reasons.push("is-sale-price-via-json-ld");
        } else {
          score += 200;
          positiveSignals += 2;
          reasons.push("matches-hidden-json-ld");
        }
      }

      if (meta.price !== null) {
        score += 90;
        reasons.push("price-text");
      } else if (meta.ownPrice !== null) {
        score += 68;
        reasons.push("own-price");
      } else {
        score += 24;
        reasons.push("semantic-only");
      }

      if (meta.ownPrice !== null) {
        score += 18;
        reasons.push("direct-text");
      }
      if (meta.splitFragmentCount >= 2 && meta.price !== null) {
        score += 20;
        reasons.push("split-group");
      }
      if (meta.currencyHint) {
        score += 8;
      }
      if (POSITIVE_SEMANTIC_RE.test(meta.semanticText)) {
        score += 24;
        reasons.push("price-semantic");
      }
      if (CURRENT_HINT_RE.test(meta.semanticText) || CURRENT_HINT_RE.test(meta.text)) {
        if (currentMode === "original") {
          score -= 40;
        } else {
          score += 14;
          reasons.push("current-hint");
        }
      }
      if (meta.priceMatchCount === 1) {
        score += 12;
      } else if (meta.priceMatchCount > 1) {
        score -= Math.min(54, 14 * (meta.priceMatchCount - 1));
        reasons.push("multi-price");
      }

      if (meta.fontSize >= 28) {
        score += 18;
      } else if (meta.fontSize >= 22) {
        score += 12;
      } else if (meta.fontSize >= 18) {
        score += 7;
      }

      if (meta.fontWeight >= 700) {
        score += 10;
      } else if (meta.fontWeight >= 600) {
        score += 6;
      }

      if (
        meta.rect.width >= 28 &&
        meta.rect.width <= 520 &&
        meta.rect.height >= 12 &&
        meta.rect.height <= 150
      ) {
        score += 8;
      }
      if (meta.rect.width < 12 || meta.rect.height < 8) {
        score -= 24;
      }
      if (
        meta.rect.width > Math.max(window.innerWidth * 0.85, 700) ||
        meta.rect.height > Math.max(window.innerHeight * 0.45, 220)
      ) {
        score -= 18;
      }
      if (meta.text.length > 220) {
        score -= 22;
      }
      if (meta.ariaHidden) {
        score -= 18;
      }
      if (
        meta.isStrikethrough ||
        meta.hasPseudoStrike ||
        meta.hasSvgStrike ||
        /^(del|s|strike)$/i.test(meta.tagName)
      ) {
        if (currentMode === "original") {
          score += 60;
          reasons.push("is-strikethrough-original");
        } else if (meta.priceMatchCount <= 1) {
          score -= 500;
          reasons.push("strikethrough");
        } else {
          reasons.push("contains-strikethrough-waived");
        }
      }
      if (meta.isMuted) {
        score -= 10;
      }
      const textHasOld = OLD_PRICE_RE.test(meta.text) || OLD_PRICE_RE.test(meta.semanticText);
      if (textHasOld) {
        if (currentMode === "original") {
          score += 40;
          reasons.push("is-old-price-semantic");
        } else if (meta.priceMatchCount <= 1) {
          score -= 42;
          reasons.push("old-price");
        }
      }
      const textHasBadge = BADGE_RE.test(meta.text) || BADGE_RE.test(meta.semanticText);
      if (textHasBadge) {
        if (meta.priceMatchCount <= 1) {
          score -= 34;
          reasons.push("promo-badge");
        }
      }
      const textHasShipping =
        SHIPPING_RE.test(meta.text) || SHIPPING_RE.test(meta.semanticText);
      if (textHasShipping) {
        if (meta.priceMatchCount <= 1) {
          score -= 52;
          reasons.push("shipping-installment");
        }
      }
      if (/%/.test(meta.text)) {
        if (meta.priceMatchCount <= 1) {
          score -= 16;
        }
      }

      if (context.anchor != null && context.anchor === el) {
        // In original mode, trust the user's direct click more strongly.
        score += currentMode === "original" ? 40 : 24;
        reasons.push("direct-target");
      } else if (composedContains(el, context.anchor)) {
        score += 10;
        reasons.push("target-wrapper");
      } else if (composedContains(context.anchor, el)) {
        score += 4;
        reasons.push("target-child");
      }

      if (context.region != null && context.region === el) {
        score += 6;
      } else if (context.region instanceof Element && composedContains(context.region, el)) {
        score += 3;
      }

      if (context.price != null && meta.price != null) {
        if (samePrice(meta.price, context.price)) {
          if (currentMode === "original") {
            score -= 15;
          } else {
            score += 20;
          }
        } else {
          if (currentMode === "original" && meta.price > context.price) {
            score += 25;
            reasons.push("higher-than-sale");
          } else {
            score -= 22;
          }
        }
      }

      return { element: el, meta, score, reasons };
    };

    const compareCandidates = (a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.meta.priceMatchCount !== b.meta.priceMatchCount) {
        return a.meta.priceMatchCount - b.meta.priceMatchCount;
      }
      const areaA = a.meta.rect.width * a.meta.rect.height;
      const areaB = b.meta.rect.width * b.meta.rect.height;
      return areaA - areaB;
    };

    const findExactPriceElement = (root, price) => {
      if (!(root instanceof Element)) return null;
      const candidates = collectPiercingElements(root, 25);

      let best = null;
      let bestScore = -Infinity;
      for (const candidate of candidates) {
        const meta = getElementMeta(candidate);
        if (!meta?.isVisible) continue;
        const candidatePrice = meta.ownPrice ?? meta.price;
        if (!samePrice(candidatePrice, price)) continue;
        if (meta.priceMatchCount > 1) continue;

        let score = 0;
        if (meta.ownPrice != null) score += 16;
        if (candidate === root) score += 4;
        score -= (meta.rect.width * meta.rect.height) / 2000;
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      return best;
    };

    const resolveBestPriceCandidate = (anchor, clientX, clientY, mode) => {
      const { region, elements: rawElements } = collectCandidateElements(
        anchor,
        clientX,
        clientY,
        mode
      );

      // Exclude the already-selected element from the opposite mode so it doesn't
      // keep winning when the user is selecting the other price.
      const oppositeCandidate = selectionMode === "original" ? saleCandidate : originalCandidate;
      const elements = oppositeCandidate?.element
        ? rawElements.filter((el) => el !== oppositeCandidate.element)
        : rawElements;
      
      const firstPass = elements
        .map((el) => scoreCandidate(el, { anchor, region, mode: selectionMode, price: null }))
        .filter(Boolean)
        .sort(compareCandidates);

      if (!firstPass.length) return null;

      const seededPrice = firstPass[0].meta.price ?? firstPass[0].meta.ownPrice;
      if (seededPrice == null) return null;

      const secondPass = elements
        .map((el) => scoreCandidate(el, { anchor, region, mode: selectionMode, price: seededPrice }))
        .filter(Boolean)
        .sort(compareCandidates);
      const best = secondPass[0];
      if (!best || best.score < 40) return null;

      const finalPrice = best.meta.price ?? best.meta.ownPrice ?? seededPrice;
      const exactPriceElement = findExactPriceElement(best.element, finalPrice);
      const resolvedElement = exactPriceElement || best.element;

      return {
        element: resolvedElement,
        exactPriceElement,
        price: finalPrice,
        region,
        score: best.score,
        reasons: best.reasons,
      };
    };

    const isStableIdentifier = (value) =>
      typeof value === "string" &&
      value.length >= 2 &&
      value.length <= 80 &&
      !/^\d/.test(value) &&
      !PRICE_RE.test(value) &&
      !/\d{6,}/.test(value) &&
      !/^[A-F0-9_-]{8,}$/i.test(value);

    const isStableClassName = (value) =>
      isStableIdentifier(value) &&
      !/^(active|selected|focus|hover|disabled|hidden|visible|open)$/i.test(value) &&
      !/^(css|jsx|sc)-/i.test(value) &&
      !/_[a-z0-9]{5,}$/i.test(value) &&
      !/--[a-z0-9]{6,}$/i.test(value) &&
      !/sr-only|screen-reader|visually-hidden/i.test(value);

    const getStableClassNames = (el) =>
      Array.from(el.classList || [])
        .filter(isStableClassName)
        .sort((a, b) => {
          const score = (token) => {
            if (POSITIVE_SEMANTIC_RE.test(token)) return 3;
            if (CURRENT_HINT_RE.test(token)) return 2;
            return 1;
          };
          return score(b) - score(a) || a.length - b.length;
        });

    const escapeAttrValue = (value) => CSS.escape(value);

    const toXPathLiteral = (value) => {
      if (!value.includes("'")) {
        return `'${value}'`;
      }
      if (!value.includes('"')) {
        return `"${value}"`;
      }
      return `concat(${value
        .split("'")
        .map((part, index) => `${index > 0 ? `, "'", ` : ""}'${part}'`)
        .join("")})`;
    };

    const getNthOfType = (el) => {
      let index = 1;
      let current = el;
      while ((current = current.previousElementSibling)) {
        if (current.tagName === el.tagName) {
          index += 1;
        }
      }
      return index;
    };

    const buildElementSelectorVariants = (el) => {
      if (!(el instanceof Element)) return [];
      const tag = el.tagName.toLowerCase();
      const variants = [];

      if (isStableIdentifier(el.id || "")) {
        variants.push(`#${CSS.escape(el.id)}`);
      }

      for (const attr of SELECTOR_STABLE_ATTRS) {
        const value = (el.getAttribute(attr) || "").trim();
        if (!isStableIdentifier(value)) continue;
        variants.push(`${tag}[${attr}="${escapeAttrValue(value)}"]`);
      }

      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      if (isStableIdentifier(ariaLabel) && POSITIVE_SEMANTIC_RE.test(ariaLabel)) {
        variants.push(`${tag}[aria-label="${escapeAttrValue(ariaLabel)}"]`);
      }

      const classes = getStableClassNames(el);
      if (classes[0]) {
        variants.push(`${tag}.${CSS.escape(classes[0])}`);
      }
      if (classes[0] && classes[1]) {
        variants.push(`${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`);
      }

      return Array.from(new Set(variants));
    };

    const buildLocalSegment = (el) => {
      const directVariants = buildElementSelectorVariants(el);
      const tag = el.tagName.toLowerCase();
      const classes = getStableClassNames(el).slice(0, 2);
      let base = directVariants[0] || tag;
      if (!directVariants[0] && classes.length) {
        base += classes.map((name) => `.${CSS.escape(name)}`).join("");
      }

      if (!el.parentElement || base.startsWith("#") || base.includes("[")) {
        return base;
      }

      let siblingMatches = 0;
      for (const sibling of Array.from(el.parentElement.children)) {
        try {
          if (sibling.matches(base)) {
            siblingMatches += 1;
          }
        } catch (err) {
          if (sibling.tagName === el.tagName) {
            siblingMatches += 1;
          }
        }
      }

      if (siblingMatches > 1) {
        return `${base}:nth-of-type(${getNthOfType(el)})`;
      }
      return base;
    };

    const validateSelector = (selector, selectedEl, selectedPrice) => {
      try {
        const matched = querySelectorAllPiercing(selector).slice(0, 24);
        if (!matched.length) return null;

        const first = matched.find((match) => {
          const exactMatch = findExactPriceElement(match, selectedPrice);
          if (!exactMatch && !samePrice(extractPriceFromText(match.textContent || ""), selectedPrice)) {
            return false;
          }
          if (!selectedEl) return true;
          return (
            composedContains(match, selectedEl) ||
            composedContains(selectedEl, match) ||
            (exactMatch &&
              (composedContains(exactMatch, selectedEl) ||
                composedContains(selectedEl, exactMatch)))
          );
        });

        if (!first) return null;
        return { first, count: matched.length };
      } catch (err) {
        return null;
      }
    };

    const buildUniquePathSelector = (el) => {
      const segments = [];
      let current = el;
      let depth = 0;

      while (
        current instanceof Element &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < 5
      ) {
        segments.unshift(buildLocalSegment(current));
        const selector = segments.join(" > ");
        try {
          if (querySelectorAllPiercing(selector).length === 1) {
            return selector;
          }
        } catch (err) {
          // Ignore invalid intermediate selector strings and keep climbing.
        }
        current = current.parentElement;
        depth += 1;
      }

      return segments.join(" > ");
    };

    const collectSelectorElements = (candidate) => {
      const elements = [];
      const add = (el) => {
        if (!(el instanceof Element) || elements.includes(el)) return;
        elements.push(el);
      };

      add(candidate.element);
      add(candidate.exactPriceElement);

      let current = candidate.element.parentElement;
      let depth = 0;
      while (current && current !== document.body && depth < 3) {
        const meta = getElementMeta(current);
        if (meta && samePrice(meta.price, candidate.price) && meta.priceMatchCount <= 1) {
          add(current);
        }
        current = current.parentElement;
        depth += 1;
      }

      if (candidate.region instanceof Element) {
        const regionMeta = getElementMeta(candidate.region);
        if (
          regionMeta &&
          samePrice(regionMeta.price, candidate.price) &&
          regionMeta.priceMatchCount === 1
        ) {
          add(candidate.region);
        }
      }

      return elements;
    };

    const buildSelectorCandidatesForElement = (el) => {
      const selectors = [];
      selectors.push(...buildElementSelectorVariants(el));

      const localSegment = buildLocalSegment(el);
      let parent = el.parentElement;
      let depth = 0;
      while (parent && parent !== document.body && depth < 3) {
        const parentVariants = buildElementSelectorVariants(parent).slice(0, 2);
        for (const parentSelector of parentVariants) {
          selectors.push(`${parentSelector} > ${localSegment}`);
        }
        parent = parent.parentElement;
        depth += 1;
      }

      selectors.push(buildUniquePathSelector(el));
      return selectors.filter(Boolean);
    };

    const getXPathSegment = (el) => {
      const tag = el.tagName.toLowerCase();
      if (isStableIdentifier(el.id || "")) {
        return `*[@id=${toXPathLiteral(el.id)}]`;
      }

      for (const attr of SELECTOR_STABLE_ATTRS) {
        const value = (el.getAttribute(attr) || "").trim();
        if (isStableIdentifier(value)) {
          return `${tag}[@${attr}=${toXPathLiteral(value)}]`;
        }
      }

      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      if (isStableIdentifier(ariaLabel) && POSITIVE_SEMANTIC_RE.test(ariaLabel)) {
        return `${tag}[@aria-label=${toXPathLiteral(ariaLabel)}]`;
      }

      const classes = getStableClassNames(el);
      if (classes[0]) {
        return `${tag}[contains(concat(' ', normalize-space(@class), ' '), ${toXPathLiteral(` ${classes[0]} `)})]`;
      }

      return `${tag}[${getNthOfType(el)}]`;
    };

    const getXPathAnchorElement = (candidate) => {
      const preferred = [candidate.exactPriceElement, candidate.element, candidate.region];
      for (const base of preferred) {
        let current = base;
        let fallback = base;
        let depth = 0;
        while (current instanceof Element && depth < 6) {
          fallback = current;
          const rootNode = current.getRootNode?.();
          if (!(rootNode instanceof ShadowRoot)) {
            return current;
          }
          current = rootNode.host;
          depth += 1;
        }
        if (fallback instanceof Element) {
          return fallback;
        }
      }
      return null;
    };

    const buildXPathSelector = (candidate) => {
      const anchor = getXPathAnchorElement(candidate);
      if (!(anchor instanceof Element)) return null;

      const segments = [];
      let current = anchor;
      let depth = 0;
      while (
        current instanceof Element &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < 5
      ) {
        segments.unshift(getXPathSegment(current));
        if (isStableIdentifier(current.id || "")) {
          break;
        }
        current = getComposedParent(current);
        depth += 1;
      }

      return segments.length ? `xpath=//${segments.join("//")}` : null;
    };

    const getCandidatePriceText = (candidate) => {
      const displayPriceRe =
        /(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)\s*[\d.,]+|[\d.,]+\s*(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+[.,]\d{1,2}\b/i;
      const sources = [candidate.exactPriceElement, candidate.element];
      for (const source of sources) {
        if (!(source instanceof Element)) continue;
        for (const text of [getOwnText(source), normalizeText(source.textContent || "")]) {
          const match = text.match(displayPriceRe);
          if (!match) continue;
          if (samePrice(extractPriceFromText(match[0]), candidate.price)) {
            return normalizeText(match[0]);
          }
        }
      }
      if (Number.isFinite(candidate.price)) {
        return String(candidate.price);
      }
      return "";
    };

    const buildTextSelector = (candidate) => {
      const priceText = getCandidatePriceText(candidate);
      return priceText ? `text=${JSON.stringify(priceText)}` : null;
    };

    const scoreSelector = (selector, validation, candidate) => {
      let score = 0;
      if (validation.count === 1) {
        score += 45;
      } else if (validation.count === 2) {
        score += 8;
      } else {
        score -= 20;
      }

      if (validation.first === candidate.element) {
        score += 16;
      } else if (
        composedContains(validation.first, candidate.element) ||
        composedContains(candidate.element, validation.first)
      ) {
        score += 10;
      }

      if (/^#/.test(selector)) {
        score += 35;
      }
      if (
        /\[(?:itemprop|data-testid|data-test|data-automation-id|data-hb-id|data-component-type|data-cy|data-qa|data-selector|data-price-type)=/i.test(
          selector
        )
      ) {
        score += 28;
      }
      if (/(price|current|sale|final|member|deal|offer)/i.test(selector)) {
        score += 14;
      }
      if (/:nth-of-type\(/.test(selector)) {
        score -= 18;
      }

      const depthPenalty = (selector.match(/ > /g) || []).length;
      score += Math.max(0, 12 - depthPenalty * 3);
      score += Math.max(0, 18 - selector.length / 8);
      return score;
    };

    const buildSelectorList = (candidate) => {
      const rawSelectors = [];
      for (const el of collectSelectorElements(candidate)) {
        rawSelectors.push(...buildSelectorCandidatesForElement(el));
      }

      const ranked = [];
      for (const selector of Array.from(new Set(rawSelectors))) {
        const validation = validateSelector(selector, candidate.element, candidate.price);
        if (!validation) continue;
        ranked.push({
          selector,
          score: scoreSelector(selector, validation, candidate),
        });
      }

      ranked.sort((a, b) => b.score - a.score || a.selector.length - b.selector.length);

      const selectors = ranked.slice(0, MAX_SELECTOR_COUNT).map((entry) => entry.selector);
      for (const specialSelector of [buildXPathSelector(candidate), buildTextSelector(candidate)]) {
        if (
          specialSelector &&
          !selectors.includes(specialSelector) &&
          validateSelector(specialSelector, candidate.element, candidate.price)
        ) {
          selectors.push(specialSelector);
        }
      }
      if (!selectors.length) {
        const fallback = buildUniquePathSelector(candidate.element);
        if (fallback) selectors.push(fallback);
      }
      return Array.from(new Set(selectors));
    };

    // --- Cleanup ---
    const cleanup = () => {
      document.removeEventListener("mouseover", onHover, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("click", onClick, true);
      thresholdInput.removeEventListener("input", onThresholdChange, true);
      frequencySelect.removeEventListener("change", onFrequencyChange, true);
      saleModeButton.removeEventListener("click", onSaleModeClick, true);
      originalModeButton.removeEventListener("click", onOriginalModeClick, true);
      cancelButton.removeEventListener("click", onCancel, true);
      saveButton.removeEventListener("click", onSave, true);
      window.removeEventListener("resize", onResize, true);
      if (banner.parentNode) banner.parentNode.removeChild(banner);
      for (const el of getTrackedInteractiveElements()) {
        restoreStyle(el);
      }
      window.__trakerPickerActive = false;
    };

    // --- Event handlers ---
    const onHover = (event) => {
      const target =
        event.composedPath?.()[0] instanceof Element ? event.composedPath()[0] : event.target;
      if (!(target instanceof Element) || banner.contains(target)) return;
      const candidate = resolveBestPriceCandidate(
        target,
        event.clientX,
        event.clientY,
        "hover"
      );
      updateHighlight(candidate);
    };

    const onOut = (event) => {
      const related = event.relatedTarget;
      if (related instanceof Element && highlighted && composedContains(highlighted, related)) {
        return;
      }
      clearHighlight();
    };

    const onClick = (event) => {
      const target =
        event.composedPath?.()[0] instanceof Element ? event.composedPath()[0] : event.target;
      if (!(target instanceof Element)) return;
      if (target === saveButton || banner.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();

      const candidate = resolveBestPriceCandidate(
        target,
        event.clientX,
        event.clientY,
        "click"
      );
      if (!candidate) return;

      const currentCandidate = getCandidateForMode(selectionMode);
      if (currentCandidate?.element === candidate.element) {
        setModeCandidate(selectionMode, null);
      } else {
        setModeCandidate(selectionMode, candidate);
      }
    };

    const onThresholdChange = () => {
      updateSaveButton();
    };

    const onFrequencyChange = () => {
      updateSaveButton();
    };

    const onSaleModeClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectionMode("sale");
    };

    const onOriginalModeClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectionMode("original");
    };

    const onCancel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      chrome.runtime.sendMessage({
        action: "picker_cancelled",
        data: {
          url: window.location.href,
        },
      });
    };

    const showPickerToast = (message, type = "success") => {
      const background =
        type === "error" ? "#d62828" : type === "neutral" ? "#334155" : "#00BB77";
      const toast = document.createElement("div");
      Object.assign(toast.style, {
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        background,
        color: "#fff",
        padding: "10px 22px",
        borderRadius: "20px",
        fontSize: "14px",
        fontWeight: "700",
        zIndex: "2147483647",
        boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        transition: "opacity 0.4s",
        opacity: "1",
      });
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 400);
      }, 2600);
    };

    const onSave = (event) => {
      event.preventDefault();
      event.stopPropagation();

      const hasSaleSelection = Boolean(saleCandidate?.element);
      const hasOriginalSelection = Boolean(originalCandidate?.element);

      if (saveButton.disabled || (!hasSaleSelection && !hasOriginalSelection)) return;

      const selectedThreshold = getThresholdValue();
      const selectedFrequency = frequencySelect.value || "24h";
      if (selectedThreshold === null) return;

      let effectiveSaleCandidate = saleCandidate;
      let effectiveOriginalCandidate = originalCandidate;

      // If they ONLY picked an original price, promote it to be the main sale price.
      // We nullify the original candidate so the UI doesn't render the same value twice.
      if (!hasSaleSelection && hasOriginalSelection) {
        effectiveSaleCandidate = originalCandidate;
        effectiveOriginalCandidate = null;
      }

      const finalSelector = effectiveSaleCandidate?.element
        ? buildSelectorList(effectiveSaleCandidate).join(", ")
        : "";
      const finalOriginalSelector = effectiveOriginalCandidate?.element
        ? buildSelectorList(effectiveOriginalCandidate).join(", ")
        : "";

      if (!finalSelector) {
        console.warn("[Traker] no valid selectors generated.");
        return;
      }

      const extractedPrice = effectiveSaleCandidate?.price ?? null;
      const extractedOriginalPrice = effectiveOriginalCandidate?.price ?? null;
      const successMessage = hasOriginalSelection ? "✓ Prices saved!" : "✓ Sale price saved!";

      chrome.runtime.sendMessage(
        {
          action: "selector_picked",
          data: {
            url: window.location.href,
            selector: finalSelector,
            price: extractedPrice,
            original_selector: finalOriginalSelector || null,
            original_price: extractedOriginalPrice,
            name: document.title,
            site_name: getSiteName(),
            threshold: selectedThreshold,
            frequency: selectedFrequency,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            showPickerToast(
              chrome.runtime.lastError.message || "Failed to save price selection.",
              "error"
            );
            return;
          }
          if (!response?.ok) {
            showPickerToast(
              response?.error || "Failed to sync the tracked product with the backend.",
              "error"
            );
            return;
          }
          showPickerToast(successMessage, "success");
        }
      );
      cleanup();
    };

    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("click", onClick, true);
    thresholdInput.addEventListener("input", onThresholdChange, true);
    frequencySelect.addEventListener("change", onFrequencyChange, true);
    saleModeButton.addEventListener("click", onSaleModeClick, true);
    originalModeButton.addEventListener("click", onOriginalModeClick, true);
    cancelButton.addEventListener("click", onCancel, true);
    saveButton.addEventListener("click", onSave, true);
    window.addEventListener("resize", onResize, true);

    applyResponsiveLayout();

    // Smart Default: Scan the page to decide sale vs original mode.
    // Priority: structured data (fast, definitive) -> DOM visual signals (fallback).
    selectionMode = (() => {
      try {
        if (hasJsonLdSaleSignal()) {
          console.log("[Traker] preflight: sale detected via JSON-LD");
          return "sale";
        }
        if (hasMetaTagSaleSignal()) {
          console.log("[Traker] preflight: sale detected via meta tags");
          return "sale";
        }

        const vw = window.innerWidth || 1024;
        const vh = window.innerHeight || 800;

        const allCandidates = querySelectorAllPiercing(
          Array.isArray(PRICE_CANDIDATE_SELECTOR)
            ? PRICE_CANDIDATE_SELECTOR.join(", ")
            : PRICE_CANDIDATE_SELECTOR,
          document.body
        );

        const AD_CONTAINER_RE =
          /\b(sp_|sponsor|adHolder|ad-slot|a-carousel|sb-ad|promoted|banner-ad)\b/i;

        const isInsideAdContainer = (el) => {
          let current = el;
          for (let depth = 0; depth < 8 && current && current !== document.body; depth += 1) {
            const id = current.id || "";
            const cls = current.className?.toString?.() || "";
            const role = current.getAttribute?.("role") || "";
            if (
              AD_CONTAINER_RE.test(id) ||
              AD_CONTAINER_RE.test(cls) ||
              role === "complementary" ||
              current.tagName === "ASIDE" ||
              current.getAttribute?.("data-ad-slot") != null ||
              current.getAttribute?.("data-component-type")?.startsWith?.("s-") === true
            ) {
              return true;
            }
            current = current.parentElement;
          }
          return false;
        };

        // Filter out price fragments and promo copy that parse as tiny "prices".
        const isPlausibleSalePrice = (lower, higher) => {
          if (lower <= 0 || higher <= 0) return false;
          return lower >= higher * 0.1;
        };

        const candidates = allCandidates.filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          if (rect.top > vh * 0.75) return false;
          if (rect.left < 0) return false;
          if (isInsideAdContainer(el)) return false;
          return true;
        }).slice(0, 25);

        // Compare struck and non-struck prices so template strikethrough nodes
        // do not trigger false sales when they show the same price.
        const scoredCandidates = candidates
          .map((el) => {
            const scored = scoreCandidate(el, {
              mode: "original",
              anchor: null,
              region: null,
              price: null,
            });
            return scored ? { el, scored, meta: scored.meta } : null;
          })
          .filter(Boolean);

        const getNearbyNonStrikethroughPrices = (targetEl) => {
          const targetRect = targetEl.getBoundingClientRect();
          return scoredCandidates
            .filter(({ el, scored }) => {
              if (scored.reasons.includes("is-strikethrough-original")) return false;
              if (scored.reasons.includes("is-old-price-semantic")) return false;
              if (scored.meta.price == null) return false;
              const rect = el.getBoundingClientRect();
              return Math.abs(rect.top - targetRect.top) < 400;
            })
            .map(({ scored }) => scored.meta.price);
        };

        const allPrices = scoredCandidates
          .filter(({ scored }) => scored.meta.price != null)
          .map(({ scored }) => scored.meta.price);
        const uniquePrices = [...new Set(allPrices.map((price) => Math.round(price * 100)))];
        const allSamePrice = uniquePrices.length <= 1;
        console.log(
          "[Traker] preflight: %d geo-filtered, %d scored, allSamePrice=%s, prices=%s",
          candidates.length,
          scoredCandidates.length,
          allSamePrice,
          JSON.stringify([...new Set(allPrices)].sort((a, b) => a - b))
        );

        for (const { el, scored } of scoredCandidates) {
          if (scored.reasons.includes("is-strikethrough-original")) {
            if (allSamePrice) continue;
            const strikPrice = scored.meta.price;
            const nearbyPrices = getNearbyNonStrikethroughPrices(el);
            if (strikPrice != null && nearbyPrices.length > 0) {
              const hasLowerPrice = nearbyPrices.some(
                (price) =>
                  price < strikPrice &&
                  !samePrice(price, strikPrice) &&
                  isPlausibleSalePrice(price, strikPrice)
              );
              if (hasLowerPrice) {
                console.log(
                  "[Traker] preflight: sale via strikethrough diff -",
                  "strike:",
                  strikPrice,
                  "nearby:",
                  nearbyPrices,
                  "el:",
                  el.tagName,
                  el.className?.toString().slice(0, 60)
                );
                return "sale";
              }
              continue;
            }
            if (!allSamePrice) {
              console.log("[Traker] preflight: sale via strikethrough (no nearby comparison)");
              return "sale";
            }
            continue;
          }

          if (scored.reasons.includes("is-old-price-semantic")) {
            if (allSamePrice) continue;
            const oldPrice = scored.meta.price;
            const nearbyPrices = getNearbyNonStrikethroughPrices(el);
            if (oldPrice != null && nearbyPrices.length > 0) {
              const hasLowerPrice = nearbyPrices.some(
                (price) =>
                  price < oldPrice &&
                  !samePrice(price, oldPrice) &&
                  isPlausibleSalePrice(price, oldPrice)
              );
              if (hasLowerPrice) {
                console.log(
                  "[Traker] preflight: sale via old-price semantic -",
                  "old:",
                  oldPrice,
                  "nearby:",
                  nearbyPrices,
                  "el:",
                  el.tagName,
                  el.className?.toString().slice(0, 60)
                );
                return "sale";
              }
              continue;
            }
            if (!allSamePrice) {
              console.log("[Traker] preflight: sale via old-price semantic (no nearby comparison)");
              return "sale";
            }
            continue;
          }

          if (hasSaleBadgeNearPrice(el)) {
            console.log(
              "[Traker] preflight: sale via nearby badge -",
              el.tagName,
              el.className?.toString().slice(0, 60)
            );
            return "sale";
          }
        }

        if (scoredCandidates.length > 0) {
          console.log(
            "[Traker] preflight: %d candidates scored, prices: %s, reasons: %s",
            scoredCandidates.length,
            JSON.stringify(scoredCandidates.map(({ scored }) => scored.meta.price).filter(Boolean)),
            JSON.stringify(scoredCandidates.map(({ scored }) => scored.reasons).flat().filter(Boolean))
          );
        }
        console.log("[Traker] preflight: no sale signals found, defaulting to original mode");
        return "original";
      } catch (err) {
        console.warn("[Traker] Pre-flight scan failed, defaulting to original mode.", err);
        return "original";
      }
    })();

    updateModeButtons();
    updateBannerCopy();
    updateSaveButton();
  })();
}
