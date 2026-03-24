// content_scraper.js
// Injected by background.js into a hidden tab to extract prices using CSS selectors.
// The selectors are expected to be set on window.__trakerSelector and
// window.__trakerOriginalSelector before this file runs.

(function () {
  const selector = window.__trakerSelector || "";
  const originalSelector = window.__trakerOriginalSelector || "";
  if (!selector && !originalSelector) {
    window.__trakerResult = null;
    return;
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

  function getMetaCurrencyCode() {
    const candidates = [
      'meta[itemprop="priceCurrency"]',
      'meta[property="product:price:currency"]',
      'meta[property="og:price:currency"]',
    ];
    for (const candidate of candidates) {
      const node = document.querySelector(candidate);
      const value = (node?.getAttribute("content") || "").trim().toUpperCase();
      if (value) return value;
    }
    return null;
  }

  function inferCurrencyCode(text) {
    const sample = (text || "").toUpperCase();
    if (!sample) return null;
    if (/NZD|NZ\$/i.test(sample)) return "NZD";
    if (/AUD|A\$/i.test(sample)) return "AUD";
    if (/CAD|C\$/i.test(sample)) return "CAD";
    if (/HKD|HK\$/i.test(sample)) return "HKD";
    if (/SGD|S\$/i.test(sample)) return "SGD";
    if (/EUR|€/i.test(sample)) return "EUR";
    if (/GBP|£/i.test(sample)) return "GBP";
    if (/JPY|¥/i.test(sample)) return "JPY";
    if (/INR|₹|RS/i.test(sample)) return "INR";
    if (/CNY|RMB|CN¥/i.test(sample)) return "CNY";
    if (/CHF/i.test(sample)) return "CHF";
    if (/USD|US\$|\$/i.test(sample)) return "USD";
    return null;
  }

  function extractPriceFromMetaTags() {
    const metaSelectors = [
      'meta[property="og:price:amount"]',
      'meta[property="product:price:amount"]',
      'meta[itemprop="price"]',
      'meta[property="product:sale_price:amount"]',
      'meta[name="twitter:data1"]',
    ];
    for (const sel of metaSelectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const raw = (node.getAttribute("content") || "").trim();
      if (!raw) continue;
      const price = parseFloat(raw.replace(/[^\d.,-]/g, "").replace(",", "."));
      if (Number.isFinite(price) && price > 0 && price < 1000000) {
        return price;
      }
    }
    return null;
  }

  function extractPriceFromJsonLd() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const raw = (script.textContent || "").trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        const price = findOfferPrice(data);
        if (price != null) return price;
      } catch {
        // Ignore invalid JSON-LD
      }
    }
    return null;

    function findOfferPrice(node) {
      if (!node) return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const p = findOfferPrice(item);
          if (p != null) return p;
        }
        return null;
      }
      if (typeof node !== "object") return null;
      const typeValue = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
      if (typeof typeValue === "string" && /\b(?:Offer|AggregateOffer)\b/i.test(typeValue)) {
        for (const key of ["price", "lowPrice", "highPrice"]) {
          if (node[key] == null) continue;
          const val = Number(node[key]);
          if (Number.isFinite(val) && val > 0 && val < 1000000) return val;
          // Try parsing as text with currency symbols
          const cleaned = String(node[key]).replace(/[^\d.,-]/g, "").replace(",", ".");
          const parsed = parseFloat(cleaned);
          if (Number.isFinite(parsed) && parsed > 0 && parsed < 1000000) return parsed;
        }
      }
      for (const value of Object.values(node)) {
        if (typeof value === "object" && value !== null) {
          const p = findOfferPrice(value);
          if (p != null) return p;
        }
      }
      return null;
    }
  }

  function extractFallbackPrice() {
    // Try structured data first (most reliable)
    const jsonLdPrice = extractPriceFromJsonLd();
    if (jsonLdPrice != null) return { price: jsonLdPrice, source: "json-ld" };

    const metaPrice = extractPriceFromMetaTags();
    if (metaPrice != null) return { price: metaPrice, source: "meta-tag" };

    return null;
  }

  // Keep this matched-region ranking logic mirrored with the extension's
  // scraping heuristics so downstream scrape paths agree.
  function buildMatchedRegionPriceExtractor() {
    const PRICE_RE =
      /(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)\s*[\d,]+\.?\d{0,2}|[\d,]+\.\d{2}/i;
    const SPLIT_PRICE_FRAGMENT_RE =
      /^(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹|[\d,]+|[.,]\d{1,2})$/i;
    const POSITIVE_SEMANTIC_RE =
      /(price|current|sale|final|member|deal|offer|buy.?box|amount|value|subtotal|now)/i;
    const CURRENT_HINT_RE = /\b(current|sale|now|today|our|final|live|deal|member)\b/i;
    const OLD_PRICE_RE =
      /\b(was|compare(?:\s+at)?|original|msrp|list\s?price|regular(?:\s?price)?|old\s?price|before|normally|typical)\b/i;
    const BADGE_RE = /\b(off|save|discount|coupon|promo|promotion|rebate|markdown)\b/i;
    const SHIPPING_RE =
      /\b(shipping|delivery|pickup|installment|monthly|per month|\/mo\b|pay in|pay later|klarna|afterpay|affirm|zip)\b/i;
    const NEGATIVE_SEMANTIC_RE =
      /\b(compare|original|msrp|list|regular|old|was|strike|strikethrough|discount|coupon|promo|shipping|delivery|installment|klarna|afterpay|affirm|save|off)\b/i;
    const MAX_MATCHES_PER_SELECTOR = 4;
    const MAX_REGION_ELEMENTS = 120;
    const elementMetaCache = new WeakMap();

    function normalizeText(value) {
      return (value || "").replace(/\s+/g, " ").trim();
    }

    function mergeText(primary, secondary) {
      const first = normalizeText(primary);
      const second = normalizeText(secondary);
      if (!second || first.includes(second)) return first;
      if (!first) return second;
      return `${first} ${second}`;
    }

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

    let cachedJsonLdPrice = undefined;

    function getJsonLdPrice() {
      if (cachedJsonLdPrice !== undefined) return cachedJsonLdPrice;
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      let foundPrice = null;

      function findOfferPrice(node) {
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
      }

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

    function samePrice(a, b) {
      return a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.009;
    }

    function parseRgb(color) {
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
    }

    function isMutedColor(color) {
      const rgb = parseRgb(color);
      if (!rgb) return false;
      const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
      const average = (rgb.r + rgb.g + rgb.b) / 3;
      return spread < 18 && average > 80 && average < 190 && rgb.a > 0.35;
    }

    function hasPseudoStrike(el) {
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
    }

    function hasSvgStrike(el, rect) {
      const elRect = rect || el.getBoundingClientRect();
      const svgElements = el.querySelectorAll("svg, line, path");
      for (const svg of Array.from(svgElements)) {
        try {
          const svgStyle = window.getComputedStyle(svg);
          if (svgStyle.position !== "absolute") continue;
          const svgRect = svg.getBoundingClientRect();
          if (svgRect.width > elRect.width * 0.5 && svgRect.height < elRect.height * 0.4) {
            return true;
          }
        } catch (e) {
          // Ignore SVG nodes we cannot measure reliably.
        }
      }
      return false;
    }

    function getComposedParent(node) {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const rootNode = node.getRootNode?.();
      return rootNode instanceof ShadowRoot ? rootNode.host : null;
    }

    function composedContains(container, target) {
      let current = target;
      while (current) {
        if (current === container) return true;
        current = getComposedParent(current);
      }
      return false;
    }

    function splitSafeSelectors(selectorStr) {
      if (!selectorStr || typeof selectorStr !== "string") return [];
      const parts = [];
      let current = "";
      let inQuotes = false;
      let quoteChar = "";
      let brackets = 0;
      for (let index = 0; index < selectorStr.length; index += 1) {
        const char = selectorStr[index];
        if ((char === '"' || char === "'") && selectorStr[index - 1] !== "\\") {
          if (!inQuotes) {
            inQuotes = true;
            quoteChar = char;
          } else if (quoteChar === char) {
            inQuotes = false;
          }
        }
        if (!inQuotes) {
          if (char === "[") brackets += 1;
          if (char === "]") brackets -= 1;
          if (char === "," && brackets === 0) {
            if (current.trim()) parts.push(current.trim());
            current = "";
            continue;
          }
        }
        current += char;
      }
      if (current.trim()) parts.push(current.trim());
      return parts;
    }

    function tryExtract(selectorValue, mode = "sale") {
      const parts = splitSafeSelectors(selectorValue);
      for (const part of parts) {
        let matched = [];
        try {
          matched = querySelectorAllPiercing(part).slice(0, MAX_MATCHES_PER_SELECTOR);
        } catch (err) {
          console.warn("[Traker] content scraper selector extraction failed:", err);
          continue;
        }

        let best = null;
        for (const root of matched) {
          const extracted = extractFromMatchedArea(root, mode);
          if (!extracted) continue;
          if (!best || extracted.score > best.score) {
            best = extracted;
          }
        }

        if (best) {
          return best;
        }
      }
      return null;
    }

    function collectQueryRoots(root = document) {
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
    }

    function collectPiercingElements(root, limit = Infinity) {
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
    }

    function parseTextSelectorValue(selector) {
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
    }

    function evaluateXPathSelector(selector, root = document) {
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
    }

    function findTextSelectorElements(selector, root = document) {
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
    }

    function querySelectorAllPiercing(selector, root = document) {
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
    }

    function getOwnText(el) {
      return normalizeText(
        Array.from(el.childNodes || [])
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
      );
    }

    function getPriceMatchCount(text) {
      const matches = normalizeText(text).match(new RegExp(PRICE_RE.source, "ig"));
      return matches ? matches.length : 0;
    }

    function countSplitPriceFragments(el) {
      let count = 0;
      for (const node of Array.from(el.childNodes || []).slice(0, 10)) {
        const text = normalizeText(node.textContent || "");
        if (!text || text.length > 18) continue;
        if (SPLIT_PRICE_FRAGMENT_RE.test(text)) {
          count += 1;
        }
      }
      return count;
    }

    function getSemanticText(el) {
      return normalizeText(
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
    }

    function getElementMeta(el) {
      if (!(el instanceof Element)) return null;
      if (elementMetaCache.has(el)) {
        return elementMetaCache.get(el);
      }

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const ariaLabel = el.getAttribute("aria-label") || "";
      const text = mergeText(el.textContent || "", ariaLabel);
      const ownText = mergeText(getOwnText(el), ariaLabel);
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
    }

    function addCandidate(target, seen, el) {
      if (!(el instanceof Element) || seen.has(el)) return;
      seen.add(el);
      target.push(el);
    }

    function collectCandidateElements(root) {
      const elements = [];
      const seen = new Set();
      addCandidate(elements, seen, root);

      let traversed = 0;
      for (const next of collectPiercingElements(root, MAX_REGION_ELEMENTS + 1)) {
        if (next === root) continue;
        const meta = getElementMeta(next);
        if (!meta?.isVisible) continue;
        if (
          meta.price !== null ||
          meta.ownPrice !== null ||
          meta.splitFragmentCount >= 2 ||
          POSITIVE_SEMANTIC_RE.test(meta.semanticText) ||
          NEGATIVE_SEMANTIC_RE.test(meta.semanticText)
        ) {
          addCandidate(elements, seen, next);
          traversed += 1;
        }
        if (traversed >= MAX_REGION_ELEMENTS) {
          break;
        }
      }
      return elements;
    }

    function scoreCandidate(el, root, mode = "sale") {
      const meta = getElementMeta(el);
      if (!meta?.isVisible) return null;

      const price = meta.ownPrice ?? meta.price;
      const hasPriceLike =
        price !== null ||
        (meta.splitFragmentCount >= 2 && meta.price !== null) ||
        POSITIVE_SEMANTIC_RE.test(meta.semanticText);
      if (!hasPriceLike) return null;

      let score = 0;
      let blocked = false;
      let positiveSignals = 0;
      const reasons = [];
      const trueLdPrice = getJsonLdPrice();
      if (trueLdPrice != null && samePrice(price, trueLdPrice)) {
        score += 200;
        positiveSignals += 2;
        reasons.push("matches-hidden-json-ld");
      }

      if (price !== null) {
        score += 92;
        positiveSignals += 1;
      } else {
        score += 20;
      }

      if (meta.ownPrice !== null) {
        score += 20;
        positiveSignals += 1;
        reasons.push("direct-price");
      }
      if (meta.splitFragmentCount >= 2 && meta.price !== null) {
        score += 18;
        positiveSignals += 1;
        reasons.push("split-group");
      }
      if (meta.currencyHint) {
        score += 8;
        positiveSignals += 1;
      }
      if (POSITIVE_SEMANTIC_RE.test(meta.semanticText)) {
        score += 24;
        positiveSignals += 1;
        reasons.push("price-semantic");
      }
      if (CURRENT_HINT_RE.test(meta.semanticText) || CURRENT_HINT_RE.test(meta.text)) {
        if (mode === "original") {
          score -= 40;
        } else {
          score += 16;
          positiveSignals += 1;
          reasons.push("current-hint");
        }
      }
      if (meta.priceMatchCount === 1) {
        score += 12;
      } else if (meta.priceMatchCount > 1) {
        score -= Math.min(30, 10 * (meta.priceMatchCount - 1));
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
        meta.rect.width >= 24 &&
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
        if (mode === "original") {
          score += 60;
          reasons.push("is-strikethrough-original");
        } else {
          score -= 500;
          blocked = true;
          reasons.push("strikethrough");
        }
      }
      if (meta.isMuted) {
        score -= 10;
      }
      const textHasOld = OLD_PRICE_RE.test(meta.text) || OLD_PRICE_RE.test(meta.semanticText);
      if (textHasOld) {
        if (mode === "original") {
          score += 40;
          reasons.push("is-old-price-semantic");
        } else {
          score -= 55;
          blocked = true;
          reasons.push("old-price");
        }
      }
      if (BADGE_RE.test(meta.text) || BADGE_RE.test(meta.semanticText)) {
        score -= 72;
        blocked = true;
        reasons.push("promo-badge");
      }
      if (SHIPPING_RE.test(meta.text) || SHIPPING_RE.test(meta.semanticText)) {
        score -= 80;
        blocked = true;
        reasons.push("shipping-installment");
      }
      if (/%/.test(meta.text)) {
        score -= 18;
      }

      if (el === root) {
        score += 8;
      } else if (composedContains(root, el)) {
        score += 6;
      }

      return { element: el, meta, price, score, blocked, positiveSignals, reasons };
    }

    function compareCandidates(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.meta.priceMatchCount !== b.meta.priceMatchCount) {
        return a.meta.priceMatchCount - b.meta.priceMatchCount;
      }
      const areaA = a.meta.rect.width * a.meta.rect.height;
      const areaB = b.meta.rect.width * b.meta.rect.height;
      return areaA - areaB;
    }

    function extractFromMatchedArea(root, mode) {
      if (!(root instanceof Element)) return null;
      const candidates = collectCandidateElements(root)
        .map((el) => scoreCandidate(el, root, mode))
        .filter((entry) => entry && entry.price != null)
        .sort(compareCandidates);

      if (!candidates.length) return null;

      const best = candidates[0];
      const runnerUp = candidates.find(
        (entry, index) => index > 0 && !samePrice(entry.price, best.price)
      );

      if (best.blocked) return null;
      if (best.score < 92) return null;
      if (best.positiveSignals < 2 && best.score < 108) return null;
      if (runnerUp && runnerUp.score >= best.score - 8 && best.score < 118) {
        return null;
      }

      return {
        price: best.price,
        text: best.meta.text,
        regionText: normalizeText(root.textContent || ""),
        score: best.score,
      };
    }

    return { tryExtract };
  }

  const extractor = buildMatchedRegionPriceExtractor();

  function tryExtract(selectorValue, mode = "sale") {
    if (!selectorValue) return null;
    const extracted = extractor.tryExtract(selectorValue, mode);
    if (!extracted) return null;
    const currencySample = `${extracted.text || ""} ${extracted.regionText || ""}`;
    return {
      price: extracted.price,
      text: extracted.text || "",
      regionText: extracted.regionText || "",
      name: document.title,
      site_name: getSiteName(),
      currency_code: getMetaCurrencyCode() || inferCurrencyCode(currencySample),
    };
  }

  const maxWait = 10000;
  const interval = 500;
  let elapsed = 0;

  function poll() {
    const saleResult = selector ? tryExtract(selector, "sale") : null;
    const originalResult = originalSelector
      ? tryExtract(originalSelector, "original")
      : null;
    const hasSaleResult = !selector || saleResult !== null;
    const hasOriginalResult = !originalSelector || originalResult !== null;

    if (hasSaleResult && hasOriginalResult) {
      // Selectors worked - use selector-based results
      window.__trakerResult = buildResult(saleResult, originalResult, false);
      return;
    }

    elapsed += interval;
    if (elapsed >= maxWait) {
      // Timeout - try fallback if selector failed
      let finalSalePrice = saleResult?.price ?? null;
      let fallbackUsed = false;

      if (finalSalePrice === null && selector) {
        // Selector failed - try structured data fallback
        const fallback = extractFallbackPrice();
        if (fallback) {
          console.log("[Traker] selector failed, fallback found price via %s: %s", fallback.source, fallback.price);
          finalSalePrice = fallback.price;
          fallbackUsed = true;
        }
      }

      window.__trakerResult = {
        price: finalSalePrice,
        original_price: originalResult?.price ?? null,
        name: document.title,
        site_name: getSiteName(),
        currency_code: getMetaCurrencyCode() || inferCurrencyCode(
          `${saleResult?.text || ""} ${saleResult?.regionText || ""} ` +
          `${originalResult?.text || ""} ${originalResult?.regionText || ""}`
        ),
        selector_fallback: fallbackUsed,
      };
    } else {
      setTimeout(poll, interval);
    }
  }

  function buildResult(saleResult, originalResult, fallbackUsed) {
    return {
      price: saleResult?.price ?? null,
      original_price: originalResult?.price ?? null,
      name: document.title,
      site_name: getSiteName(),
      currency_code: getMetaCurrencyCode() || inferCurrencyCode(
        `${saleResult?.text || ""} ${saleResult?.regionText || ""} ` +
        `${originalResult?.text || ""} ${originalResult?.regionText || ""}`
      ),
      selector_fallback: fallbackUsed,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", poll);
  } else {
    poll();
  }
})();
