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
- Product navigation uses same-origin referer after warmup (search referer if warmup skipped)
- Weighted Windows/macOS fingerprint mix
- Cookie banner dismissal
- Price element wait + scroll for lazy-load
- enable_cache for realistic browser caching behavior
- disable_coop for Cloudflare Turnstile iframe interaction

Environment:
  DISPLAY=:99 (set by Dockerfile) → headless=False on pre-started Xvfb (production)
  DISPLAY=:98 (set by docker-compose) → headless=False on VNC display (local dev)
  CAMOUFOX_HEADLESS=true (no DISPLAY) → headless="virtual" (fallback, Camoufox starts own Xvfb)
  CAMOUFOX_HEADLESS=false (no DISPLAY) → headless=False (needs a display to work)
"""
import asyncio
import logging
import os
import random
import re
import time
from urllib.parse import quote, urlparse

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger("camoufox-broker")
logging.basicConfig(level=logging.INFO)


def _sanitize_error(msg: str) -> str:
    """Remove proxy credentials from error messages."""
    return re.sub(r'://[^@]+@', '://***:***@', str(msg))

_HEADLESS_ENV = os.getenv("CAMOUFOX_HEADLESS", "true").lower()
if os.getenv("DISPLAY"):
    # Xvfb is pre-started (ACI production) — run headful on existing display
    HEADLESS_MODE = False
elif _HEADLESS_ENV in ("true", "1", "yes"):
    # No display available — let Camoufox start its own Xvfb
    HEADLESS_MODE = "virtual"
else:
    HEADLESS_MODE = False  # Visible browser window (local dev with VNC)

# API key for authenticating requests from the backend
BROKER_API_KEY = os.getenv("BROKER_API_KEY", "")


class ScrapeRequest(BaseModel):
    url: str
    proxy: Optional[str] = None  # http://user:pass@host:port
    timeout_ms: int = 90000
    wait_for_selector: Optional[str] = None  # CSS selector(s) — wait until a match contains price text


class ScrapeResponse(BaseModel):
    html: str
    url: str
    status: int


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape_page(req: ScrapeRequest, x_api_key: str = Header(default="")):
    """Launch Camoufox, navigate to URL, return rendered HTML."""
    if BROKER_API_KEY and x_api_key != BROKER_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _sync_scrape, req.url, req.proxy, req.timeout_ms, req.wait_for_selector,
        )
        return result
    except Exception as exc:
        logger.error("Camoufox scrape failed for %s: %s", req.url[:80], _sanitize_error(str(exc)))
        raise HTTPException(status_code=500, detail=_sanitize_error(str(exc)))


def _sync_scrape(url: str, proxy: Optional[str], timeout_ms: int,
                 wait_for_selector: Optional[str] = None) -> dict:
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
    # Traffic mix: mostly Windows desktop, some macOS (BrowserForge aligns fingerprints per OS).
    _os = random.choices(["windows", "macos", "linux"], weights=[5, 2, 1], k=1)[0]

    # When geoip=True, Camoufox derives timezone/language from the proxy IP.
    # Hardcoding locale="en-US" would conflict with a non-US proxy (e.g. JP proxy
    # sets timezone=Asia/Tokyo but locale stays en-US — instant bot signal).
    # Solution: omit locale when geoip is active so Camoufox auto-derives it;
    # only set locale explicitly when there's no proxy (direct Azure IP).
    _camoufox_kwargs = dict(
        headless=HEADLESS_MODE,
        proxy=proxy_config,
        humanize=round(random.uniform(1.5, 3.0), 1),
        os=_os,
        geoip=True if proxy_config else False,
        block_webrtc=True,
        enable_cache=True,
        disable_coop=True,
    )
    if not proxy_config:
        # No proxy = direct Azure datacenter IP, geoip won't help, set locale explicitly
        _camoufox_kwargs["locale"] = "en-US"

    with Camoufox(**_camoufox_kwargs) as browser:
        page = browser.new_page()
        try:
            # Dismiss any JS dialogs with human-like delay
            def _handle_dialog(dialog):
                time.sleep(random.uniform(0.3, 1.2))
                try:
                    dialog.dismiss()
                except Exception:
                    pass

            page.on("dialog", _handle_dialog)
            time.sleep(random.uniform(0.12, 0.42))

            # --- STEP 1: Homepage warmup ---
            # Real users arrive with session cookies from browsing the site.
            # Direct product URL with zero cookies = suspicious to anti-bots.
            parsed_url = urlparse(url)
            homepage = f"{parsed_url.scheme}://{parsed_url.netloc}/"
            path_only = parsed_url.path or "/"
            is_site_root_only = path_only.rstrip("/") in ("", "/") and not parsed_url.query

            warmup_ok = False
            if not is_site_root_only:
                try:
                    logger.info("Camoufox warmup: %s", parsed_url.netloc)
                    page.goto(homepage, wait_until="domcontentloaded", timeout=20000)
                    time.sleep(random.uniform(1.5, 3.0))
                    _dismiss_cookie_banner(page)
                    time.sleep(random.uniform(0.5, 1.0))
                    warmup_ok = True
                except Exception as exc:
                    logger.debug("Homepage warmup failed (continuing): %s", exc)

            # Same-origin referer after warmup matches in-site navigation; otherwise search referer.
            if warmup_ok:
                product_referer = homepage
            else:
                _domain_for_ref = parsed_url.netloc or "product"
                product_referer = random.choice(
                    (
                        f"https://www.google.com/search?q={quote(_domain_for_ref)}",
                        f"https://www.google.com/search?q={quote(_domain_for_ref)}+deals",
                        f"https://www.bing.com/search?q={quote(_domain_for_ref)}",
                        f"https://duckduckgo.com/?q={quote(_domain_for_ref)}",
                    )
                )

            # --- STEP 2: Navigate to product page ---
            # enable_cache=True means homepage assets are cached (realistic).
            try:
                page.goto(
                    url,
                    wait_until="load",
                    timeout=timeout_ms,
                    referer=product_referer,
                )
            except Exception:
                # Some SPAs never fire full load reliably — try networkidle then domcontentloaded
                try:
                    logger.debug("load wait timeout, trying networkidle")
                    page.goto(
                        url,
                        wait_until="networkidle",
                        timeout=timeout_ms,
                        referer=product_referer,
                    )
                except Exception:
                    logger.debug("networkidle timeout, falling back to domcontentloaded")
                    page.goto(
                        url,
                        wait_until="domcontentloaded",
                        timeout=timeout_ms,
                        referer=product_referer,
                    )

            # --- STEP 3: Dismiss cookie banners ASAP ---
            # Real users dismiss overlays within ~1s of them appearing.
            # Doing this before price wait also prevents overlays from
            # blocking visibility checks on price elements underneath.
            time.sleep(random.uniform(0.4, 0.9))  # Brief human reaction time
            _dismiss_cookie_banner(page)

            # --- STEP 4: Wait for price elements (now unobstructed) ---
            try:
                page.wait_for_selector(
                    '[itemprop="price"], [data-price], .a-price, '
                    '[class*="price"], [data-testid*="price"]',
                    timeout=10000,
                )
            except Exception:
                pass

            # Site-specific wait: ensure a matched element actually contains a price,
            # not just exists (Walmart's [itemprop="price"] is an empty placeholder
            # until JS hydrates). Falls through on timeout — extraction runs anyway.
            if wait_for_selector:
                try:
                    page.wait_for_function(
                        """(sel) => {
                            const els = document.querySelectorAll(sel);
                            for (const el of els) {
                                const txt = (el.innerText || el.textContent || '').trim();
                                if (/\\d[\\d.,]*[.,]\\d{2}/.test(txt)) return true;
                            }
                            return false;
                        }""",
                        arg=wait_for_selector,
                        timeout=15000,
                    )
                except Exception:
                    logger.debug("wait_for_selector content timeout: %s", wait_for_selector[:80])

            # Human reading delay (user scans the price area)
            time.sleep(random.uniform(0.8, 2.0))

            # --- STEP 5: Scroll for lazy-loaded content (enhanced) ---
            # humanize handles mouse movement at C++ level,
            # but scroll events and accompanying mouse position need explicit calls.
            try:
                vp = page.viewport_size or {"width": 1280, "height": 800}
                vp_w = vp.get("width", 1280)
                vp_h = vp.get("height", 800)

                # Move mouse to a visible area before scrolling (DataDome checks this)
                page.mouse.move(
                    random.randint(int(vp_w * 0.2), int(vp_w * 0.8)),
                    random.randint(int(vp_h * 0.3), int(vp_h * 0.7)),
                )
                time.sleep(random.uniform(0.1, 0.3))

                # Phase 1: Quick scroll down to find price area
                scroll_1 = random.randint(350, 700)
                _human_scroll(page, scroll_1, direction=1)
                time.sleep(random.uniform(0.2, 0.5))

                # Phase 2: Read pause
                time.sleep(random.uniform(0.5, 1.5))

                # Phase 3: Slow detail scroll (40% chance)
                if random.random() < 0.4:
                    for _ in range(random.randint(1, 3)):
                        page.mouse.move(
                            random.randint(int(vp_w * 0.15), int(vp_w * 0.85)),
                            random.randint(int(vp_h * 0.2), int(vp_h * 0.8)),
                        )
                        time.sleep(random.uniform(0.05, 0.15))
                        _human_scroll(page, random.randint(80, 250), direction=1)
                        time.sleep(random.uniform(0.3, 0.8))

                # Phase 4: Scroll back up toward price (65% chance)
                if random.random() < 0.65:
                    _human_scroll(page, random.randint(120, max(150, scroll_1 // 2)), direction=-1)
                    time.sleep(random.uniform(0.2, 0.5))

                # Phase 5: Small jitter (20% chance — reading adjustment)
                if random.random() < 0.2:
                    jitter = random.randint(20, 40)
                    _human_scroll(page, jitter, direction=random.choice([1, -1]))
                    time.sleep(random.uniform(0.1, 0.25))
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
    """Try to dismiss cookie consent banners with human-like interaction."""
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

    def _human_click(el):
        """Move mouse to element, brief pause, then click."""
        try:
            box = el.bounding_box()
            if box:
                x = box["x"] + random.uniform(box["width"] * 0.2, box["width"] * 0.8)
                y = box["y"] + random.uniform(box["height"] * 0.2, box["height"] * 0.8)
                page.mouse.move(x, y)
                time.sleep(random.uniform(0.08, 0.2))
            el.click()
        except Exception:
            try:
                el.click()
            except Exception:
                pass

    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                _human_click(el)
                time.sleep(random.uniform(0.3, 0.5))
                return
        except Exception:
            pass

    for text in reject_texts + accept_texts:
        try:
            el = page.query_selector(f"button:has-text('{text}')")
            if el and el.is_visible():
                _human_click(el)
                time.sleep(random.uniform(0.3, 0.5))
                return
        except Exception:
            pass


def _human_scroll(page, total_pixels: int, direction: int = 1) -> None:
    """Scroll in small increments like a real mouse wheel.
    direction: 1 = down, -1 = up
    """
    remaining = abs(total_pixels)
    while remaining > 0:
        # Each wheel tick is 30-80px (real mouse wheel delta)
        tick = min(remaining, random.randint(30, 80))
        try:
            page.mouse.wheel(0, tick * direction)
        except Exception:
            break
        remaining -= tick
        # Tiny gap between ticks (10-50ms) — real scroll wheel timing
        time.sleep(random.uniform(0.01, 0.05))
    # Brief settling pause after scroll completes
    time.sleep(random.uniform(0.05, 0.15))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "camoufox-broker",
        "headless_mode": str(HEADLESS_MODE),
    }
