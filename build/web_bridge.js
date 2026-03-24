(() => {
  if (window.__TRAKER_WEB_BRIDGE_LOADED__) return;
  window.__TRAKER_WEB_BRIDGE_LOADED__ = true;

  const PAGE_SOURCE = "price-tracker-web";
  const EXT_SOURCE = "price-tracker-extension";
  const DEFAULT_FREQUENCY = "24h";
  const FREQUENCY_VALUES = new Set(["6h", "12h", "24h", "7d", "30d"]);
  let bridgeDisabled = false;

  function normalizeFrequency(value) {
    return FREQUENCY_VALUES.has(value) ? value : DEFAULT_FREQUENCY;
  }

  function isInvalidatedMessage(message) {
    return (
      typeof message === "string" &&
      message.toLowerCase().includes("extension context invalidated")
    );
  }

  function getRuntime() {
    try {
      if (bridgeDisabled) return null;
      if (typeof chrome === "undefined") return null;
      if (!chrome.runtime || !chrome.runtime.id) return null;
      return chrome.runtime;
    } catch (err) {
      console.warn("[Traker] web bridge runtime lookup failed:", err);
      bridgeDisabled = true;
      return null;
    }
  }

  function postInvalidatedError(requestId) {
    postToPage({
      type: "PT_PICK_ERROR",
      requestId,
      error:
        'Extension context was reloaded. Refresh this page, then try "Redo" again.',
    });
    bridgeDisabled = true;
  }

  function postToPage(message) {
    if (bridgeDisabled) return false;
    try {
      window.postMessage(
        {
          source: EXT_SOURCE,
          ...message,
        },
        window.location.origin
      );
      return true;
    } catch (err) {
      console.warn("[Traker] web bridge postMessage to page failed:", err);
      bridgeDisabled = true;
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    try {
      if (bridgeDisabled) return;
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;

      const msg = event.data;
      if (!msg || msg.source !== PAGE_SOURCE) return;
      if (msg.type === "PT_PING_EXT") {
        postToPage({ type: "PT_EXT_READY" });
        return;
      }
      if (msg.type !== "PT_START_PICK") return;

      const requestId = msg.requestId;
      const payload = msg.payload || {};
      const runtime = getRuntime();
      if (!runtime || typeof runtime.sendMessage !== "function") {
        postInvalidatedError(requestId);
        return;
      }

      runtime.sendMessage(
        {
          action: "start_pick_for_url",
          data: {
            requestId,
            url: payload.url,
            threshold: payload.threshold ?? "",
            frequency: normalizeFrequency(payload.frequency),
          },
        },
        (response) => {
          const currentRuntime = getRuntime();
          if (!currentRuntime) {
            postInvalidatedError(requestId);
            return;
          }
          if (currentRuntime.lastError) {
            if (isInvalidatedMessage(currentRuntime.lastError.message)) {
              postInvalidatedError(requestId);
              return;
            }
            postToPage({
              type: "PT_PICK_ERROR",
              requestId,
              error: currentRuntime.lastError.message,
            });
            return;
          }
          if (!response?.ok) {
            postToPage({
              type: "PT_PICK_ERROR",
              requestId,
              error: response?.error || "Failed to start extension picker.",
            });
            return;
          }
          if (!response?.accepted) {
            postToPage({
              type: "PT_PICK_ERROR",
              requestId,
              error: "Extension did not accept the picker request.",
            });
            return;
          }
          postToPage({
            type: "PT_PICK_ACCEPTED",
            requestId,
            alreadyInFlight: Boolean(response?.alreadyInFlight),
          });
        }
      );
    } catch (err) {
      console.warn("[Traker] web bridge PT_START_PICK handler failed:", err);
      if (isInvalidatedMessage(err?.message)) {
        postInvalidatedError(event?.data?.requestId);
        return;
      }
      const requestId = event?.data?.requestId;
      if (typeof requestId !== "undefined") {
        postInvalidatedError(requestId);
        return;
      }
      bridgeDisabled = true;
      void err;
    }
  });

  const runtime = getRuntime();
  if (runtime?.onMessage?.addListener) {
    runtime.onMessage.addListener((msg) => {
      try {
        if (bridgeDisabled) return;
        if (msg.action === "web_pick_result") {
          postToPage({
            type: "PT_PICK_RESULT",
            requestId: msg.requestId,
            payload: {
              ok: true,
              custom_selector: msg.data?.selector || "",
              validated_price: msg.data?.price ?? null,
              name: msg.data?.name || "",
              url: msg.data?.url || "",
              threshold: msg.data?.threshold ?? null,
              frequency: normalizeFrequency(msg.data?.frequency),
            },
          });
          return;
        }

        if (msg.action === "web_pick_started") {
          postToPage({
            type: "PT_PICK_STARTED",
            requestId: msg.requestId,
          });
          return;
        }

        if (msg.action === "web_pick_error") {
          postToPage({
            type: "PT_PICK_ERROR",
            requestId: msg.requestId,
            error: msg.error || "Price picker failed.",
          });
          return;
        }

        if (msg.action === "tracked_products_synced") {
          postToPage({
            type: "PT_TRACKED_PRODUCTS_SYNCED",
            payload: msg.data || {},
          });
        }
      } catch (err) {
        console.warn("[Traker] web bridge runtime message relay failed:", err);
        bridgeDisabled = true;
      }
    });
  } else {
    bridgeDisabled = true;
  }
})();
