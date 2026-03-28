"""
Camoufox (Firefox) scraping broker.
Receives scrape requests via HTTP, launches Camoufox, returns rendered HTML.

CAMOUFOX_HEADLESS=true (default, production) / false (local dev, visible in VNC)
"""
import asyncio
import logging
import os
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger("camoufox-broker")
logging.basicConfig(level=logging.INFO)

HEADLESS = os.getenv("CAMOUFOX_HEADLESS", "true").lower() in ("true", "1", "yes")


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
    """Synchronous Camoufox scrape — runs in a thread."""
    from camoufox.sync_api import Camoufox

    proxy_config = None
    if proxy:
        from urllib.parse import urlparse
        parsed = urlparse(proxy)
        proxy_config = {
            "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}",
        }
        if parsed.username:
            proxy_config["username"] = parsed.username
        if parsed.password:
            proxy_config["password"] = parsed.password

    logger.info("Camoufox scrape: url=%s headless=%s proxy=%s", url[:80], HEADLESS, bool(proxy))
    start = time.time()

    with Camoufox(headless=HEADLESS, proxy=proxy_config) as browser:
        page = browser.new_page()
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_function(
                    "document.body && document.body.innerText.trim().length > 200",
                    timeout=15000,
                )
            except Exception:
                pass

            page.wait_for_timeout(2000)

            html = page.content()
            final_url = page.url
            status = response.status if response else 200

            logger.info(
                "Camoufox scrape complete: url=%s status=%d size=%d elapsed=%.1fs",
                url[:80], status, len(html), time.time() - start,
            )
            return {"html": html, "url": final_url, "status": status}
        finally:
            page.close()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "camoufox-broker", "headless": HEADLESS}