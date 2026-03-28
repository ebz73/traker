"""
Camoufox (Firefox) scraping broker — maximum stealth configuration.

Built-in stealth (C++ level, handled by Camoufox — DON'T override):
- Fingerprint generation via BrowserForge (OS, screen, navigator, WebGL, fonts)
- Human-like cursor movement via C++ algorithm (humanize=True)
- GeoIP timezone/locale/language matching from proxy IP (geoip=True)
- WebRTC leak prevention (block_webrtc=True)
- uBlock Origin with privacy filters (bundled by default)
- Font anti-fingerprinting (random letter-spacing offsets)
- AudioContext, Battery API, voice spoofing
- Sandboxed Playwright — no JS injection detectable

Broker-level stealth (we handle):
- Virtual display mode (headless="virtual") — defeats headless detection
- Homepage warmup (establish session cookies before product page)
- Google referrer (look like organic search traffic)
- Cookie banner dismissal
- Price element wait + scroll for lazy-load
- enable_cache for realistic browser caching behavior
- disable_coop for Cloudflare Turnstile iframe interaction

Environment:
  CAMOUFOX_HEADLESS=true  → headless="virtual" (Xvfb, recommended for production)
  CAMOUFOX_HEADLESS=false → headless=False (visible browser, local dev with VNC)
"""
import asyncio
import logging
import os
import random
import time
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger("camoufox-broker")
logging.basicConfig(level=logging.INFO)

# When HEADLESS=true (production), use "virtual" display for maximum stealth.
# When HEADLESS=false (local dev), use False for visible browser in VNC.
_HEADLESS_ENV = os.getenv("CAMOUFOX_HEADLESS", "true").lower()
if _HEADLESS_ENV in ("true", "1", "yes"):
    HEADLESS_MODE = "virtual"  # Xvfb — headful inside virtual display
else:
    HEADLESS_MODE = False  # Visible browser window


class ScrapeRequest(BaseModel):
    url: str
    proxy: Optional[str] = None  # http://user:pass@host:port
    timeout_ms: int = 90000


class ScrapeResponse(BaseModel):
    html: str
    url: str
    status: int


app = FastAPI()


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape_page(req: ScrapeRequest):
    """Launch Camoufox, navigate to URL, return rendered HTML."""
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _sync_scrape, req.url, req.proxy, req.timeout_ms
        )
        return result
    except Exception as exc:
        logger.error("Camoufox scrape failed for %s: %s", req.url[:80], exc)
        raise HTTPException(status_code=500, detail=str(exc))


def _sync_scrape(url: str, proxy: Optional[str], timeout_ms: int) -> dict:
    """Synchronous Camoufox scrape using all available stealth features."""
    from camoufox.sync_api import Camoufox

    proxy_config = None
    if proxy:
        parsed = urlparse(proxy)
        proxy_config = {
            "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}",
        }
        if parsed.username:
            proxy_config["username"] = parsed.username
        if parsed.password:
            proxy_config["password"] = parsed.password

    logger.info(
        "Camoufox scrape: url=%s headless=%s proxy=%s",
        url[:80], HEADLESS_MODE, bool(proxy),
    )
    start = time.time()

    with Camoufox(
        # --- Headless mode ---
        # "virtual" = runs headful browser inside Xvfb virtual display.
        # Anti-bots that detect headless=True cannot detect this.
        # DataDome, CreepJS confirmed to miss virtual display mode.
        headless=HEADLESS_MODE,
        proxy=proxy_config,
        # --- Built-in C++ stealth ---
        humanize=True,              # C++ Bezier mouse curves, distance-aware
        os="windows",               # ~75% of real traffic is Windows
        geoip=True if proxy_config else False,  # Auto timezone/locale from proxy IP
        block_webrtc=True,          # Prevent real IP leak
        # --- Browser behavior ---
        enable_cache=True,          # Cache homepage assets during warmup (realistic)
        disable_coop=True,          # Allow Cloudflare Turnstile iframe interaction
        locale="en-US",             # Fallback locale (geoip overrides when proxy set)
        # DON'T set screen/viewport/window — BrowserForge auto-generates
        # consistent dimensions matching the OS/device fingerprint.
    ) as browser:
        page = browser.new_page()
        try:
            # Dismiss any JS dialogs
            page.on("dialog", lambda dialog: dialog.dismiss())

            # --- STEP 1: Homepage warmup ---
            # Real users arrive with session cookies from browsing the site.
            # Direct product URL with zero cookies = suspicious to anti-bots.
            parsed_url = urlparse(url)
            homepage = f"{parsed_url.scheme}://{parsed_url.netloc}/"
            try:
                logger.info("Camoufox warmup: %s", parsed_url.netloc)
                page.goto(homepage, wait_until="domcontentloaded", timeout=20000)
                time.sleep(random.uniform(1.5, 3.0))
                _dismiss_cookie_banner(page)
                time.sleep(random.uniform(0.5, 1.0))
            except Exception as exc:
                logger.debug("Homepage warmup failed (continuing): %s", exc)

            # --- STEP 2: Navigate to product page ---
            # Google referrer makes it look like organic search traffic.
            # enable_cache=True means homepage assets are cached (realistic).
            try:
                page.goto(
                    url,
                    wait_until="networkidle",
                    timeout=timeout_ms,
                    referer="https://www.google.com/",
                )
            except Exception:
                # Some sites never reach networkidle — fall back
                logger.debug("networkidle timeout, falling back to domcontentloaded")
                page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=timeout_ms,
                    referer="https://www.google.com/",
                )

            # --- STEP 3: Wait for price elements ---
            try:
                page.wait_for_selector(
                    '[itemprop="price"], [data-price], .a-price, '
                    '[class*="price"], [data-testid*="price"]',
                    timeout=10000,
                )
            except Exception:
                pass

            # Human reading delay
            time.sleep(random.uniform(1.0, 2.5))

            # --- STEP 4: Dismiss cookie banners ---
            _dismiss_cookie_banner(page)

            # --- STEP 5: Scroll for lazy-loaded content ---
            # humanize=True handles mouse movement at C++ level,
            # but scroll events need explicit calls.
            try:
                scroll_amount = random.randint(300, 600)
                page.mouse.wheel(0, scroll_amount)
                time.sleep(random.uniform(0.5, 1.0))
                page.mouse.wheel(0, -random.randint(100, scroll_amount // 2))
                time.sleep(random.uniform(0.3, 0.6))
            except Exception:
                pass

            # --- STEP 6: Wait for lazy-loaded content ---
            try:
                page.wait_for_function(
                    "document.body && document.body.innerText.trim().length > 200",
                    timeout=10000,
                )
            except Exception:
                pass

            # Final render wait
            time.sleep(random.uniform(0.5, 1.0))

            html = page.content()
            final_url = page.url

            logger.info(
                "Camoufox scrape complete: url=%s size=%d elapsed=%.1fs",
                url[:80], len(html), time.time() - start,
            )
            return {"html": html, "url": final_url, "status": 200}
        finally:
            page.close()


def _dismiss_cookie_banner(page) -> None:
    """Try to dismiss cookie consent banners."""
    selectors = [
        "#onetrust-accept-btn-handler",
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "button[id*='cookie' i][id*='accept' i]",
        "button[id*='cookie' i][id*='close' i]",
        "button[class*='cookie' i][class*='accept' i]",
        "button[id*='consent' i][id*='accept' i]",
        "[data-testid*='cookie' i] button",
        "button[aria-label*='Accept all' i]",
        "button[aria-label*='accept' i][aria-label*='cookie' i]",
    ]
    reject_texts = [
        "Reject All", "Reject all", "Decline All", "Only Necessary",
    ]
    accept_texts = [
        "Accept All", "Accept all", "Accept Cookies", "Allow All",
        "I Accept", "Got it", "OK", "I Agree",
    ]

    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click()
                time.sleep(random.uniform(0.3, 0.5))
                return
        except Exception:
            pass

    for text in reject_texts + accept_texts:
        try:
            el = page.query_selector(f"button:has-text('{text}')")
            if el and el.is_visible():
                el.click()
                time.sleep(random.uniform(0.3, 0.5))
                return
        except Exception:
            pass


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "camoufox-broker",
        "headless_mode": str(HEADLESS_MODE),
    }