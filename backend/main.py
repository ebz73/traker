# ──────────────────────────────────────────────────────────
# Required env vars:
#   JWT_SECRET            - Secret for signing JWTs (CHANGE IN PROD)
#   DATABASE_URL          - PostgreSQL connection string
#   ALLOWED_ORIGINS       - Comma-separated CORS origins
#   AUTO_CREATE_SCHEMA    - "true" for dev, "false" for prod (use Alembic)
#   ACCESS_TOKEN_MINUTES  - JWT expiry in minutes (default 60)
#
# Test commands:
#   Register:
#     curl -X POST http://localhost:8000/auth/register \
#       -H "Content-Type: application/json" \
#       -d '{"email":"test@example.com","password":"password123"}'
#
#   Login:
#     curl -X POST http://localhost:8000/auth/login \
#       -H "Content-Type: application/x-www-form-urlencoded" \
#       -d "username=test@example.com&password=password123"
#
#   Protected endpoint:
#     curl http://localhost:8000/tracked-products \
#       -H "Authorization: Bearer <token>"
# ──────────────────────────────────────────────────────────

import datetime
import copy
import ipaddress
import json
import logging
import os
import random
import re
import secrets
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlsplit, urlunsplit

import httpx
try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None

# Azure SDK for on-demand Chrome container management
try:
    from azure.identity import DefaultAzureCredential
    from azure.mgmt.containerinstance import ContainerInstanceManagementClient
    _AZURE_SDK_AVAILABLE = True
except ImportError:
    _AZURE_SDK_AVAILABLE = False

# Resend email API
try:
    import resend
    _RESEND_AVAILABLE = True
except ImportError:
    _RESEND_AVAILABLE = False

from bs4 import BeautifulSoup
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from playwright.sync_api import Locator
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel
from sqlalchemy import Boolean, Column, DateTime, Float, Index, Integer, String, create_engine, func, inspect, or_, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# Extra auth dependencies (install with pip):
#   python-jose[cryptography]
#   passlib[bcrypt]

_US_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]

# --- SITE SPECIFIC CONFIGURATION ---
SITE_SELECTORS = {
    # ── Original sites (improved) ─────────────────────────────────────────────
    'walmart.com':        {'price': ['[itemprop="price"]', '[data-automation-id="product-price"]', '[data-automation-id="price-price-amount"]', '.price-characteristic', '.w_iB3b', '[class*="PriceDisplay"]']},
    'amazon.com':         {'price': ['.a-price-whole', '.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice', '.a-color-price', '#corePrice_feature_div .a-price', '[data-a-color="price"] .a-offscreen']},
    'target.com':         {'price': ['[data-test="product-price"]', '[data-test="current-price"]', 'span[data-test="price"]']},
    'bestbuy.com':        {'price': ['.priceView-customer-price span', '.priceView-price-validate', '[data-testid="customer-price"] span']},
    'ebay.com':           {'price': ['#prcIsum', '.x-price-primary', '[itemprop="price"]', '.x-bin-price__content .x-price-primary', '#binPrice', '.vi-price .notranslate']},
    'costco.com':         {'price': ['[data-test="product-price"]', '.value', '.your-price .value', '[automation-id="productDetailSalePrice"]']},
    'nike.com':           {'price': ['[data-test="product-price"]', '.product-price', '[data-test="sale-price"]', '[class*="ProductPrice"]']},
    'hm.com':             {'price': ['.price-value', '#product-price', '.product-item-price', '[class*="ProductPrice"]']},
    'homedepot.com':      {'price': ['[data-testid="price-format-dollars"]', '.price-format__main-price', '[class*="price-format__large"]', '.u__text--success']},
    'lowes.com':          {'price': ['[data-selector="add-to-cart-price"]', '.art-pd-price', '[class*="main-price"]', 'div[itemprop="price"]']},
    'wayfair.com':        {'price': ['[data-hb-id="pip-sale-price"]', '.BasePriceBlock__Price', '[class*="Price-module"]', '[data-testid="price"]']},
    'etsy.com':           {'price': ['[data-buy-box-region="price"] .wt-text-title-larger', 'p[class*="price-only"] .currency-value', '[data-selector="price-only"]', '.wt-text-title-03.wt-mr-xs-1']},
    'zappos.com':         {'price': ['#price', '[itemprop="price"]', '.Price-module', '[class*="salePrice"]']},
    # ── Fashion / Apparel ─────────────────────────────────────────────────────
    'adidas.com':         {'price': ['[data-auto-id="gl-price-item"]', '.gl-price-item', '[class*="gl-price"]', '[data-testid="product-price"]']},
    'gap.com':            {'price': ['.product-pricing .gap-price', '[class*="SalePrice"]', '[itemprop="price"]', '.priceSection [class*="price"]']},
    'oldnavy.com':        {'price': ['.product-pricing .gap-price', '[class*="SalePrice"]', '[itemprop="price"]']},
    'bananarepublic.com': {'price': ['.product-pricing .gap-price', '[class*="SalePrice"]', '[itemprop="price"]']},
    'zara.com':           {'price': ['[class*="price-current"]', '._price', 'span.price', '[data-qa-label="product-price"]']},
    'uniqlo.com':         {'price': ['[data-testid="product-price"]', '.ProductPrice', '[class*="ProductPrice_price"]', '.fr-ec-price-box__regular-price']},
    'forever21.com':      {'price': ['.product-price', '[class*="ProductPrice"]', '.price-container span', '[data-qa="product-price"]']},
    'asos.com':           {'price': ['[data-testid="current-price"]', '[class*="current-price"]', '.current-price span', '[class*="ProductPrice"]']},
    'nordstrom.com':      {'price': ['[itemprop="price"]', '[data-element="sale-price"]', '[class*="Price__StyledPrice"]', '.current-price']},
    'nordstromrack.com':  {'price': ['.current-price', '[itemprop="price"]', '[class*="current-price"]']},
    'macys.com':          {'price': ['.lowest-sale-price', '[data-auto="product-price-section"] .price-display-block', '[class*="price-display"]', '#priceSection [class*="price"]']},
    'kohls.com':          {'price': ['.pdp-price-content .price', '[class*="pdp-price"]', '[data-testid="product-price"]', '.product-price-regular']},
    'bloomingdales.com':  {'price': ['.lowest-sale-price', '[data-testid="product-price"]', '[class*="price-display"]']},
    'anthropologie.com':  {'price': ['[class*="ProductPrice"]', '.product-price', 'span[data-auto-id="sale-price"]']},
    'urbanoutfitters.com':{'price': ['[class*="ProductPrice"]', '.product-price', 'span[data-auto-id="sale-price"]']},
    'lululemon.com':      {'price': ['[data-testid="price"]', '[class*="ProductPrice"]', '.price__sale', '.price-text']},
    'patagonia.com':      {'price': ['.price', '[data-ui="price-display"]', '[itemprop="price"]', '.product__price']},
    'ralphlauren.com':    {'price': ['[class*="sale-price"]', '.product-sale-price', '[itemprop="price"]', '[class*="ProductPrice"]']},
    # ── Electronics / Tech ────────────────────────────────────────────────────
    'newegg.com':         {'price': ['.price-current', '.price-current strong', '[itemprop="price"]', '.product-price']},
    'bhphotovideo.com':   {'price': ['[data-selenium="pricingPrice"]', '.price-USD', '[class*="price_price"]', '.price']},
    'adorama.com':        {'price': ['.our-price', '[data-price]', '[itemprop="price"]', '.product-price']},
    'microcenter.com':    {'price': ['#price', '.product-price', '[itemprop="price"]']},
    'apple.com':          {'price': ['[class*="currentPrice"]', '.pd-price', '.product-price', 'span[aria-label*="price"]']},
    'samsung.com':        {'price': ['.price-now', '[data-pdp-price]', '[class*="priceNow"]', '.price__wrap .price-now']},
    'dell.com':           {'price': ['[data-testid="intl-price"]', '#dellProductPrice', '.dell-price', '[class*="ps-price"]']},
    'lenovo.com':         {'price': ['.js-initial-price', '.price-discount', '[class*="priceBreakdown"]', '.product-price--main']},
    # ── Home / Furniture ──────────────────────────────────────────────────────
    'ikea.com':           {'price': ['[class*="pip-price"]', '.pip-price__integer', '[data-testid="pip-price-module-wrapper"] span']},
    'overstock.com':      {'price': ['[class*="ProductPrice"]', '.product-price', '[data-testid="product-price"]']},
    'crateandbarrel.com': {'price': ['[class*="PriceDisplay"]', '.price-ui-value', '.price', '[data-testid="product-price"]']},
    'potterybarn.com':    {'price': ['.product-price', '[class*="price"]', '.price-box .price']},
    'williams-sonoma.com':{'price': ['.product-price', '[class*="price"]', '.price-box .price']},
    'cb2.com':            {'price': ['[class*="PriceDisplay"]', '.price', '[data-testid="product-price"]']},
    'westelm.com':        {'price': ['.product-price', '[class*="Price"]', 'span[data-auto-id="sale-price"]']},
    'ruggable.com':       {'price': ['[class*="Price"]', '.product__price', '[data-testid="price"]']},
    # ── Sports / Outdoors ─────────────────────────────────────────────────────
    'rei.com':                 {'price': ['[data-ui="sale-price"]', '.price-value', '[class*="product-price"]', '#buy-box [class*="price"]']},
    'dickssportinggoods.com':  {'price': ['[class*="product-price"]', '.product-price', '[data-testid="product-price"]', '.final-price']},
    'academy.com':             {'price': ['.product-price', '[class*="price"]', '[data-auid="productDetailSalePrice"]']},
    'cabelas.com':             {'price': ['[class*="price-display"]', '.rs-price', '[itemprop="price"]']},
    'basspro.com':             {'price': ['[class*="price-display"]', '.rs-price', '[itemprop="price"]']},
    # ── Beauty / Health ───────────────────────────────────────────────────────
    'sephora.com':        {'price': ['[data-comp="Price"]', '[class*="Price-module"]', '.css-1ggrp4c', '[data-testid="price"]']},
    'ulta.com':           {'price': ['[data-test="product-price"]', '.product__price', '[class*="ProductPrice"]']},
    # ── Resale / Marketplaces ─────────────────────────────────────────────────
    'poshmark.com':       {'price': ['.listing-price', '[itemprop="price"]', '[class*="price"]']},
    'mercari.com':        {'price': ['[data-testid="price"]', '[class*="ItemPrice"]', '.item-price']},
    'depop.com':          {'price': ['[class*="Price"]', 'div[data-testid="product-price"]', '.buyerPrice']},
    'grailed.com':        {'price': ['[class*="price"]', '.price', '[data-testid="listing-price"]']},
    'stockx.com':         {'price': ['[class*="lowest-ask"]', '.lowest-ask', '[data-testid="buy-bar-lowest-ask"]', '.LowestAsk-module']},
    'goat.com':           {'price': ['[class*="ProductPrice"]', '.product-price', '[data-qa="product-condition-price"]']},
    # ── Grocery / Wholesale ───────────────────────────────────────────────────
    'samsclub.com':       {'price': ['[itemprop="price"]', '.Price-module', '[data-testid="item-price"]', '.display-price']},
    # ── International ─────────────────────────────────────────────────────────
    'amazon.co.uk':       {'price': ['.a-price .a-offscreen', '.a-price-whole', '#priceblock_ourprice', '#corePrice_feature_div .a-price']},
    'amazon.de':          {'price': ['.a-price .a-offscreen', '.a-price-whole', '#priceblock_ourprice']},
    'amazon.co.jp':       {'price': ['.a-price .a-offscreen', '#priceblock_ourprice', '#price_inside_buybox']},
    'amazon.in':          {'price': ['.a-price .a-offscreen', '#priceblock_ourprice', '#corePrice_feature_div .a-price']},
    'flipkart.com':       {'price': ['._30jeq3', '._16Jk6d', '[class*="_30jeq3"]', '[data-id="finalPrice"]']},
    'myntra.com':         {'price': ['.pdp-price strong', '[class*="pdp-price"]', '.price-box .price']},
    'otto.de':            {'price': ['[data-qa="prd-price-offer"]', '.price__normal', '[class*="Price"]']},
    'zalando.de':         {'price': ['[data-testid="product-price"]', '._0Qm8W1', '[class*="Price"]']},
}

# --- STEALTH SETUP ---
apply_stealth = lambda page: None

try:
    from playwright_stealth import Stealth
    _stealth = Stealth()
    apply_stealth = _stealth.apply_stealth_sync
except ImportError:
    try:
        from playwright_stealth import stealth_sync as _stealth_sync
        apply_stealth = _stealth_sync
    except ImportError:
        pass


def _inject_manual_stealth(page) -> None:
    """Inject essential anti-detection patches that playwright_stealth might miss."""
    try:
        page.add_init_script("""
            // Hide webdriver flag
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Fake plugins (headless Chrome has 0 plugins)
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin' },
                ],
            });

            // Fake languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

            // Consistent platform (must match User-Agent)
            Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });

            // Hide automation indicators
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

            // Fake chrome.runtime (missing in headless)
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

            // Override permissions query
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Fix iframe contentWindow
            const originalContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: function() {
                    const result = originalContentWindow.get.call(this);
                    if (result) {
                        try {
                            Object.defineProperty(result.navigator, 'webdriver', { get: () => undefined });
                        } catch(e) {}
                    }
                    return result;
                }
            });

            // Fix screen dimensions (headless reports wrong values)
            Object.defineProperty(screen, 'width', { get: () => 1920 });
            Object.defineProperty(screen, 'height', { get: () => 1080 });
            Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
            Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
            Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

            // Fix window outer dimensions (headless reports 0)
            if (window.outerWidth === 0) {
                Object.defineProperty(window, 'outerWidth', { get: () => 1920 });
                Object.defineProperty(window, 'outerHeight', { get: () => 1040 });
            }

            // Consistent hardware concurrency (headless sometimes reports wrong)
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

            // Consistent device memory
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

            // Fix WebGL vendor/renderer (headless reports "Google Inc. (Google)" which is a known headless tell)
            const getParameterProxyHandler = {
                apply: function(target, thisArg, args) {
                    const param = args[0];
                    const UNMASKED_VENDOR_WEBGL = 0x9245;
                    const UNMASKED_RENDERER_WEBGL = 0x9246;
                    if (param === UNMASKED_VENDOR_WEBGL) return 'Google Inc. (NVIDIA)';
                    if (param === UNMASKED_RENDERER_WEBGL) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return target.apply(thisArg, args);
                }
            };
            try {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                    if (debugInfo) {
                        WebGLRenderingContext.prototype.getParameter = new Proxy(
                            WebGLRenderingContext.prototype.getParameter, getParameterProxyHandler
                        );
                    }
                }
                // Also patch WebGL2
                const gl2 = canvas.getContext('webgl2');
                if (gl2) {
                    const debugInfo2 = gl2.getExtension('WEBGL_debug_renderer_info');
                    if (debugInfo2) {
                        WebGL2RenderingContext.prototype.getParameter = new Proxy(
                            WebGL2RenderingContext.prototype.getParameter, getParameterProxyHandler
                        );
                    }
                }
            } catch(e) {}

            // Connection type (headless has no connection info)
            if (navigator.connection === undefined) {
                Object.defineProperty(navigator, 'connection', {
                    get: () => ({
                        effectiveType: '4g',
                        rtt: 50,
                        downlink: 10,
                        saveData: false,
                    })
                });
            }

            // Battery API (return realistic values)
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 0.97,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                });
            }

            // Add subtle noise to canvas fingerprinting
            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(type) {
                if (this.width === 0 || this.height === 0) return originalToDataURL.apply(this, arguments);
                const ctx = this.getContext('2d');
                if (ctx) {
                    // Add invisible noise pixel
                    const imageData = ctx.getImageData(0, 0, 1, 1);
                    imageData.data[3] = imageData.data[3] === 0 ? 0 : (imageData.data[3] ^ 1);
                    ctx.putImageData(imageData, 0, 0);
                }
                return originalToDataURL.apply(this, arguments);
            };

            const originalToBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
                if (this.width === 0 || this.height === 0) return originalToBlob.apply(this, arguments);
                const ctx = this.getContext('2d');
                if (ctx) {
                    const imageData = ctx.getImageData(0, 0, 1, 1);
                    imageData.data[3] = imageData.data[3] === 0 ? 0 : (imageData.data[3] ^ 1);
                    ctx.putImageData(imageData, 0, 0);
                }
                return originalToBlob.apply(this, arguments);
            };

            // chrome.loadTimes and chrome.csi — present in real Chrome, missing in headless
            if (window.chrome) {
                if (!window.chrome.loadTimes) {
                    window.chrome.loadTimes = function() {
                        return {
                            commitLoadTime: Date.now() / 1000 - 0.3,
                            connectionInfo: 'h2',
                            finishDocumentLoadTime: Date.now() / 1000 - 0.1,
                            finishLoadTime: Date.now() / 1000,
                            firstPaintAfterLoadTime: Date.now() / 1000 + 0.05,
                            firstPaintTime: Date.now() / 1000 - 0.2,
                            navigationType: 'Other',
                            npnNegotiatedProtocol: 'h2',
                            requestTime: Date.now() / 1000 - 0.5,
                            startLoadTime: Date.now() / 1000 - 0.4,
                            wasAlternateProtocolAvailable: false,
                            wasFetchedViaSpdy: true,
                            wasNpnNegotiated: true,
                        };
                    };
                }
                if (!window.chrome.csi) {
                    window.chrome.csi = function() {
                        return {
                            onloadT: Date.now(),
                            startE: Date.now() - 500,
                            pageT: 500 + Math.random() * 200,
                            tran: 15,
                        };
                    };
                }
            }

            // Notification.permission — headless returns 'default', real browsers vary
            try {
                Object.defineProperty(Notification, 'permission', {
                    get: () => 'denied'
                });
            } catch(e) {}

            // history.length — headless starts at 1, real browsers usually have more
            try {
                Object.defineProperty(window.history, 'length', { get: () => 3 + Math.floor(Math.random() * 5) });
            } catch(e) {}

            // maxTouchPoints — must be 0 for non-touch Linux desktop
            try {
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
            } catch(e) {}
        """)
    except Exception as exc:
        logger.debug("Manual stealth injection failed: %s", exc)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-in-production")
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "60"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "30"))
AUTO_CREATE_SCHEMA = os.getenv("AUTO_CREATE_SCHEMA", "true").lower() in ("true", "1", "yes")
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")
    if o.strip()
]
ENV_NAME = (
    os.getenv("ENV")
    or os.getenv("APP_ENV")
    or os.getenv("FASTAPI_ENV")
    or os.getenv("PYTHON_ENV")
    or "dev"
).strip().lower()
IS_DEV_CONTEXT = ENV_NAME in {"dev", "development", "local", "test", "testing"}

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

UI_CHANGED_ERROR_CODE = "UI_CHANGED"
DEFAULT_FREQUENCY = "24h"
VALID_FREQUENCIES = {"6h", "12h", "24h", "7d", "30d"}
HISTORY_RETENTION_DAYS = 120
DEFAULT_CURRENCY_CODE = "USD"
EXTENSION_HEARTBEAT_TTL_SECONDS = 180.0
EXTENSION_JOB_RETENTION_SECONDS = 300
EXTENSION_JOB_STALE_SECONDS = 120  # Reset in_progress jobs older than this back to pending
EXTENSION_JOB_MAX_ATTEMPTS = int(os.getenv("EXTENSION_JOB_MAX_ATTEMPTS", "2"))
CDP_SCRAPE_MAX_WALL_SECONDS = float(os.getenv("CDP_SCRAPE_MAX_WALL_SECONDS", "120"))
# --- Azure Container Instance (on-demand Chrome) ---
ACI_RESOURCE_GROUP = os.getenv("ACI_RESOURCE_GROUP", "traker-rg")
ACI_CONTAINER_GROUP_NAME = os.getenv("ACI_CONTAINER_GROUP_NAME", "traker-chrome")
ACI_SUBSCRIPTION_ID = os.getenv("ACI_SUBSCRIPTION_ID", "")
ACI_LOCATION = os.getenv("ACI_LOCATION", "eastus")
ACI_IMAGE = os.getenv("ACI_IMAGE", "browserless/chromium")
ACI_CPU = float(os.getenv("ACI_CPU", "1"))
ACI_MEMORY_GB = float(os.getenv("ACI_MEMORY_GB", "2"))
ACI_IDLE_TIMEOUT_SECONDS = int(os.getenv("ACI_IDLE_TIMEOUT_SECONDS", "600"))  # 10 min
ACI_START_TIMEOUT_SECONDS = int(os.getenv("ACI_START_TIMEOUT_SECONDS", "120"))  # Max wait for container start
ACI_HEALTH_POLL_INTERVAL = float(os.getenv("ACI_HEALTH_POLL_INTERVAL", "5"))  # Seconds between health checks during startup
ENABLE_ACI_AUTO_START = os.getenv("ENABLE_ACI_AUTO_START", "true").lower() in ("true", "1", "yes")

# --- Residential proxy for CDP scraping (dual-proxy with failover) ---
# Primary proxy (DataImpulse — cheap at $1/GB, try first)
# Fallback proxy (IPRoyal — more reliable at $7/GB, try if primary fails)
# Format: http://username:password@proxy-host:port
# Leave both empty to disable (Chrome will use the container's Azure datacenter IP directly).
CDP_PROXY_PRIMARY_URL = os.getenv("CDP_PROXY_PRIMARY_URL", "")  # DataImpulse
CDP_PROXY_FALLBACK_URL = os.getenv("CDP_PROXY_FALLBACK_URL", "")  # IPRoyal
CDP_PROXY_ENABLED = bool(CDP_PROXY_PRIMARY_URL.strip()) or bool(CDP_PROXY_FALLBACK_URL.strip())

# --- ACI Container Management ---
_ACI_CLIENT: Optional[Any] = None
_ACI_CLIENT_LOCK = threading.Lock()
_ACI_LAST_CDP_REQUEST: float = 0.0  # Timestamp of last CDP scrape request
_ACI_LAST_CDP_REQUEST_LOCK = threading.Lock()
_ACI_IDLE_TIMER: Optional[threading.Timer] = None
_ACI_IDLE_TIMER_LOCK = threading.Lock()
_ACI_STARTING = False  # Prevents concurrent start attempts
_ACI_STARTING_LOCK = threading.Lock()
# Sleep multiplier: 1.0 for production, 0.0 for CI/testing, 0.5 for faster dev runs
SLEEP_MULTIPLIER = float(os.getenv("SLEEP_MULTIPLIER", "1.0"))


def _get_aci_client():
    """Get or create Azure Container Instance management client (singleton)."""
    global _ACI_CLIENT
    if not _AZURE_SDK_AVAILABLE:
        return None
    if not ACI_SUBSCRIPTION_ID:
        logger.warning("ACI_SUBSCRIPTION_ID not set — cannot manage Chrome container")
        return None
    with _ACI_CLIENT_LOCK:
        if _ACI_CLIENT is None:
            credential = DefaultAzureCredential()
            _ACI_CLIENT = ContainerInstanceManagementClient(credential, ACI_SUBSCRIPTION_ID)
        return _ACI_CLIENT


def _get_aci_container_state() -> dict:
    """Check the current state of the Chrome ACI container group.
    Returns {"provisioning_state": str, "container_state": str, "ip": str|None}
    """
    client = _get_aci_client()
    if not client:
        return {"provisioning_state": "unknown", "container_state": "unknown", "ip": None}
    try:
        group = client.container_groups.get(ACI_RESOURCE_GROUP, ACI_CONTAINER_GROUP_NAME)
        ip = None
        if group.ip_address:
            ip = group.ip_address.ip
        container_state = "unknown"
        if group.containers and group.containers[0].instance_view:
            current = group.containers[0].instance_view.current_state
            if current:
                container_state = current.state or "unknown"
        return {
            "provisioning_state": group.provisioning_state or "unknown",
            "container_state": container_state,
            "ip": ip,
        }
    except Exception as exc:
        if "ResourceNotFound" in str(exc) or "404" in str(exc):
            return {"provisioning_state": "not_found", "container_state": "not_found", "ip": None}
        logger.warning("Failed to check ACI container state: %s", exc)
        return {"provisioning_state": "error", "container_state": "error", "ip": None}


def _start_aci_container() -> bool:
    """Start the Chrome ACI container and wait until CDP is healthy.
    Returns True if container is running and CDP endpoint is reachable.
    """
    global _ACI_STARTING

    # Check-and-set under the lock, then RELEASE before any blocking work
    with _ACI_STARTING_LOCK:
        if _ACI_STARTING:
            already_starting = True
        else:
            already_starting = False
            _ACI_STARTING = True

    # If another thread is already starting, wait OUTSIDE the lock
    if already_starting:
        logger.info("ACI container start already in progress, waiting...")
        for _ in range(ACI_START_TIMEOUT_SECONDS):
            time.sleep(1)
            if not _ACI_STARTING:
                break
        return _cdp_endpoint_healthy(ttl_seconds=0.0)

    try:
        client = _get_aci_client()
        if not client:
            logger.warning("Cannot start ACI container — Azure SDK not available")
            return False

        state = _get_aci_container_state()
        logger.info("ACI container current state: %s", state)

        if state["container_state"] == "Running" and state["ip"]:
            _update_cdp_url(state["ip"])
            logger.info("ACI container already running at %s", state["ip"])
            return _wait_for_cdp_healthy()

        if state["provisioning_state"] == "not_found":
            logger.info("Creating new ACI container group '%s'...", ACI_CONTAINER_GROUP_NAME)
            _create_aci_container_group(client)
        else:
            logger.info("Starting existing ACI container group '%s'...", ACI_CONTAINER_GROUP_NAME)
            try:
                client.container_groups.begin_start(ACI_RESOURCE_GROUP, ACI_CONTAINER_GROUP_NAME)
            except Exception as exc:
                logger.warning("ACI start failed, trying re-create: %s", exc)
                _create_aci_container_group(client)

        return _wait_for_aci_running_and_healthy(client)
    except Exception as exc:
        logger.exception("Failed to start ACI container: %s", exc)
        return False
    finally:
        with _ACI_STARTING_LOCK:
            _ACI_STARTING = False


def _create_aci_container_group(client):
    """Create or replace the ACI container group with browserless/chromium."""
    from azure.mgmt.containerinstance.models import (
        Container,
        ContainerGroup,
        ContainerGroupRestartPolicy,
        ContainerPort,
        IpAddress,
        OperatingSystemTypes,
        Port,
        ResourceRequests,
        ResourceRequirements,
    )

    container = Container(
        name="chrome",
        image=ACI_IMAGE,
        resources=ResourceRequirements(
            requests=ResourceRequests(cpu=ACI_CPU, memory_in_gb=ACI_MEMORY_GB)
        ),
        ports=[ContainerPort(port=3000)],
    )

    group = ContainerGroup(
        location=ACI_LOCATION,
        containers=[container],
        os_type=OperatingSystemTypes.linux,
        restart_policy=ContainerGroupRestartPolicy.NEVER,
        ip_address=IpAddress(
            ports=[Port(protocol="TCP", port=3000)],
            type="Public",
        ),
    )

    client.container_groups.begin_create_or_update(
        ACI_RESOURCE_GROUP, ACI_CONTAINER_GROUP_NAME, group
    )
    logger.info("ACI create/update initiated for '%s'", ACI_CONTAINER_GROUP_NAME)


def _wait_for_aci_running_and_healthy(client) -> bool:
    """Poll ACI until container is running and CDP endpoint responds."""
    deadline = time.time() + ACI_START_TIMEOUT_SECONDS

    while time.time() < deadline:
        state = _get_aci_container_state()
        logger.info(
            "Waiting for ACI... provisioning=%s container=%s ip=%s",
            state["provisioning_state"],
            state["container_state"],
            state["ip"],
        )

        if state["container_state"] == "Running" and state["ip"]:
            _update_cdp_url(state["ip"])
            if _wait_for_cdp_healthy():
                return True

        if state["provisioning_state"] in ("Failed",):
            logger.error("ACI container provisioning failed")
            return False

        time.sleep(ACI_HEALTH_POLL_INTERVAL)

    logger.warning("ACI container did not become healthy within %ds", ACI_START_TIMEOUT_SECONDS)
    return False


def _wait_for_cdp_healthy(timeout: float = 30.0) -> bool:
    """Poll the CDP /json/version endpoint until it responds."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _cdp_endpoint_healthy(ttl_seconds=0.0):
            logger.info("CDP endpoint is healthy")
            return True
        time.sleep(2)
    return False


def _update_cdp_url(ip: str):
    """Update the global CHROME_CDP_URL with the container's IP address."""
    global CHROME_CDP_URL
    new_url = f"http://{ip}:3000"
    if CHROME_CDP_URL != new_url:
        logger.info("Updating CHROME_CDP_URL: %s → %s", CHROME_CDP_URL, new_url)
        CHROME_CDP_URL = new_url
        with _CDP_HEALTH_LOCK:
            _CDP_HEALTH_CACHE["value"] = None
            _CDP_HEALTH_CACHE["checked_at"] = 0.0
            _CDP_HEALTH_CACHE["forced_unhealthy_until"] = 0.0
            _CDP_HEALTH_CACHE["ws_endpoint"] = None
            _CDP_HEALTH_CACHE["headers"] = {}


def _stop_aci_container():
    """Stop the ACI container group (does not delete — faster restart next time)."""
    client = _get_aci_client()
    if not client:
        return
    try:
        logger.info("Stopping ACI container group '%s' (idle timeout)...", ACI_CONTAINER_GROUP_NAME)
        client.container_groups.stop(ACI_RESOURCE_GROUP, ACI_CONTAINER_GROUP_NAME)
        logger.info("ACI container group '%s' stopped successfully", ACI_CONTAINER_GROUP_NAME)
        with _CDP_HEALTH_LOCK:
            _CDP_HEALTH_CACHE["value"] = False
            _CDP_HEALTH_CACHE["checked_at"] = time.time()
            _CDP_HEALTH_CACHE["ws_endpoint"] = None
            _CDP_HEALTH_CACHE["headers"] = {}
    except Exception as exc:
        logger.warning("Failed to stop ACI container: %s", exc)


def _touch_aci_idle_timer():
    """Reset the ACI idle timer. Call on every CDP scrape request."""
    global _ACI_IDLE_TIMER, _ACI_LAST_CDP_REQUEST
    with _ACI_LAST_CDP_REQUEST_LOCK:
        _ACI_LAST_CDP_REQUEST = time.time()
    with _ACI_IDLE_TIMER_LOCK:
        if _ACI_IDLE_TIMER is not None:
            _ACI_IDLE_TIMER.cancel()
        _ACI_IDLE_TIMER = threading.Timer(ACI_IDLE_TIMEOUT_SECONDS, _stop_aci_container)
        _ACI_IDLE_TIMER.daemon = True
        _ACI_IDLE_TIMER.start()
        logger.debug("ACI idle timer reset — will stop in %ds if no CDP requests", ACI_IDLE_TIMEOUT_SECONDS)

# --- Email alert configuration ---
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", "onboarding@resend.dev")
EMAIL_ALERTS_ENABLED = os.getenv("EMAIL_ALERTS_ENABLED", "true").lower() in ("true", "1", "yes")
ALERT_DIGEST_INTERVAL_HOURS = int(os.getenv("ALERT_DIGEST_INTERVAL_HOURS", "6"))

if _RESEND_AVAILABLE and RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY

# Lightweight in-memory denylist for revoked refresh tokens.
# Only needs to last until access tokens issued alongside them expire (ACCESS_TOKEN_MINUTES).
# Cleared on server restart, which is acceptable because:
#   - Access tokens are short-lived (60 min)
#   - After restart, old access tokens expire naturally
#   - Entra ID migration will replace this entirely
_REVOKED_REFRESH_TOKENS: Dict[str, float] = {}  # jti -> revoked_at timestamp
_REVOKED_REFRESH_LOCK = threading.Lock()
_REVOKED_REFRESH_MAX_AGE = 60 * 60 * 2  # Keep entries for 2 hours then auto-purge


def _anti_bot_sleep(low: float, high: float) -> None:
    """Sleep for a random duration scaled by SLEEP_MULTIPLIER. Set to 0 in CI."""
    if SLEEP_MULTIPLIER <= 0:
        return
    time.sleep(random.uniform(low * SLEEP_MULTIPLIER, high * SLEEP_MULTIPLIER))

CURRENCY_CODE_TO_SYMBOL = {
    "USD": "$",
    "EUR": "€",
    "JPY": "¥",
    "INR": "₹",
    "GBP": "£",
    "AUD": "A$",
    "CAD": "C$",
    "NZD": "NZ$",
    "CHF": "CHF",
    "CNY": "CN¥",
    "HKD": "HK$",
    "SGD": "S$",
}

CURRENCY_TOKEN_TO_CODE = {
    "$": "USD",
    "US$": "USD",
    "USD": "USD",
    "€": "EUR",
    "EUR": "EUR",
    "¥": "JPY",
    "JPY": "JPY",
    "₹": "INR",
    "INR": "INR",
    "RS": "INR",
    "GBP": "GBP",
    "£": "GBP",
    "AUD": "AUD",
    "A$": "AUD",
    "CAD": "CAD",
    "C$": "CAD",
    "NZD": "NZD",
    "NZ$": "NZD",
    "CHF": "CHF",
    "CNY": "CNY",
    "RMB": "CNY",
    "HKD": "HKD",
    "HK$": "HKD",
    "SGD": "SGD",
    "S$": "SGD",
}

DOMAIN_CURRENCY_HINTS = {
    "amazon.co.jp": "JPY",
    "rakuten.co.jp": "JPY",
    "flipkart.com": "INR",
    "myntra.com": "INR",
    "ajio.com": "INR",
    "amazon.co.uk": "GBP",
}

TLD_CURRENCY_HINTS = {
    ".jp": "JPY",
    ".in": "INR",
    ".uk": "GBP",
    ".de": "EUR",
    ".fr": "EUR",
    ".es": "EUR",
    ".it": "EUR",
    ".nl": "EUR",
    ".be": "EUR",
    ".ie": "EUR",
}

PRICE_PATTERN = re.compile(
    r"(?:[$£€¥]\s*)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*[$£€¥])?"
)
PRICE_TOKEN_PATTERN = re.compile(
    r"(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)\s*[\d.,]+|"
    r"[\d.,]+\s*(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)?"
)
OLD_PRICE_FRAGMENT_PATTERN = re.compile(
    r"(?i)(?:was|list\s*price|msrp|original|compare\s*at|regular\s*price|old\s*price|before|normally|typical)"
    r"[^\d\n]*(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹)?\s*[\d.,]+"
    r"(?:\s*(?:US\$|USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|HKD|SGD|\$|€|£|¥|₹))?"
)
POSITIVE_PRICE_HINTS = ("price", "current", "now", "sale", "our", "buy")
NEGATIVE_PRICE_HINTS = ("rating", "review", "sold", "save", "was", "unit", "count")
PERMANENT_ERROR_CODES = {400, 401, 403, 404, 410}
# --- SCRAPER TIER TOGGLES (set to False to skip a tier during testing) ---
ENABLE_TIER_1_HTTP = True   # httpx HTTP-first scraper
ENABLE_TIER_2_CFFI = os.getenv("ENABLE_TIER_2_CFFI", "true").lower() in ("true", "1", "yes")   # curl_cffi TLS-impersonation scraper
ENABLE_TIER_3_EXTENSION = True  # Extension-based scraping via job queue
CFFI_IMPERSONATIONS = ["chrome", "safari", "chrome131", "chrome124"]

HTTP_FIRST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
}
USER_AGENTS = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
]
HTTP_FIRST_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
HTTP_FIRST_CLIENT_HTTP2 = httpx.Client(
    headers=HTTP_FIRST_HEADERS,
    timeout=HTTP_FIRST_TIMEOUT,
    follow_redirects=True,
    http2=True,
    limits=httpx.Limits(max_connections=20, keepalive_expiry=30),
)
HTTP_FIRST_CLIENT_HTTP1 = httpx.Client(
    headers=HTTP_FIRST_HEADERS,
    timeout=HTTP_FIRST_TIMEOUT,
    follow_redirects=True,
    http2=False,
    limits=httpx.Limits(max_connections=20, keepalive_expiry=30),
)


def normalize_frequency(value: Optional[str]) -> str:
    if value is None:
        return DEFAULT_FREQUENCY
    raw = str(value).strip()
    if not raw:
        return DEFAULT_FREQUENCY
    return raw if raw in VALID_FREQUENCIES else DEFAULT_FREQUENCY


def _normalize_selector_value(value: Optional[str]) -> Optional[str]:
    raw = (value or "").strip()
    return raw or None


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(user_id: int) -> str:
    expire = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=ACCESS_TOKEN_MINUTES)
    return jwt.encode({"sub": str(user_id), "exp": expire}, JWT_SECRET, algorithm="HS256")


def decode_access_token(token: str) -> Optional[int]:
    """Returns user_id (int) or None."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        sub = payload.get("sub")
        return int(sub) if sub is not None else None
    except (JWTError, ValueError):
        return None


def create_refresh_token(user_id: int) -> str:
    """
    Create a long-lived JWT refresh token.
    Contains type="refresh" claim to distinguish from access tokens.
    Uses a unique jti (JWT ID) for revocation tracking.

    NOTE (Azure migration): This function will be replaced by Entra ID's
    OAuth2 token issuance. The extension-side code that stores/sends
    refresh tokens will remain unchanged.
    """
    jti = secrets.token_urlsafe(32)
    expire = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=REFRESH_TOKEN_DAYS)
    return jwt.encode(
        {"sub": str(user_id), "exp": expire, "type": "refresh", "jti": jti},
        JWT_SECRET,
        algorithm="HS256",
    )


def decode_refresh_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Decode and validate a refresh token JWT. Returns the payload dict if valid,
    or None if invalid/expired/wrong type/revoked.
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except (JWTError, ValueError):
        return None

    if payload.get("type") != "refresh":
        return None

    jti = payload.get("jti")
    if not jti:
        return None

    # Check in-memory denylist
    with _REVOKED_REFRESH_LOCK:
        if jti in _REVOKED_REFRESH_TOKENS:
            return None

    return payload


def _revoke_refresh_jti(jti: str) -> None:
    """Add a refresh token's jti to the in-memory denylist."""
    if not jti:
        return
    now = time.time()
    with _REVOKED_REFRESH_LOCK:
        _REVOKED_REFRESH_TOKENS[jti] = now
        # Purge old entries to prevent unbounded growth
        if len(_REVOKED_REFRESH_TOKENS) > 500:
            cutoff = now - _REVOKED_REFRESH_MAX_AGE
            stale = [k for k, v in _REVOKED_REFRESH_TOKENS.items() if v < cutoff]
            for k in stale:
                del _REVOKED_REFRESH_TOKENS[k]


def revoke_refresh_token(raw_token: str) -> bool:
    """Revoke a refresh token by adding its jti to the denylist."""
    if not raw_token:
        return False
    try:
        # Decode WITHOUT checking denylist - we need the jti even if already revoked
        payload = jwt.decode(raw_token, JWT_SECRET, algorithms=["HS256"])
    except (JWTError, ValueError):
        return False
    jti = payload.get("jti")
    if not jti:
        return False
    _revoke_refresh_jti(jti)
    return True


def _currency_code_from_token(raw_token: Optional[str]) -> Optional[str]:
    if not raw_token:
        return None
    token = str(raw_token).strip()
    if not token:
        return None

    normalized_token = token.upper().replace(" ", "")
    if normalized_token in CURRENCY_TOKEN_TO_CODE:
        return CURRENCY_TOKEN_TO_CODE[normalized_token]

    if token in CURRENCY_TOKEN_TO_CODE:
        return CURRENCY_TOKEN_TO_CODE[token]

    symbol_only = re.sub(r"[A-Z0-9]", "", normalized_token)
    if symbol_only in CURRENCY_TOKEN_TO_CODE:
        return CURRENCY_TOKEN_TO_CODE[symbol_only]

    letters_only = re.sub(r"[^A-Z]", "", normalized_token)
    if letters_only in CURRENCY_TOKEN_TO_CODE:
        return CURRENCY_TOKEN_TO_CODE[letters_only]

    return None


def normalize_currency_code(value: Optional[str]) -> str:
    code = _currency_code_from_token(value)
    if code:
        return code
    return DEFAULT_CURRENCY_CODE


def _currency_symbol_from_code(currency_code: Optional[str]) -> str:
    code = normalize_currency_code(currency_code)
    return CURRENCY_CODE_TO_SYMBOL.get(code, "$")


def _format_display_price(price: float, currency_code: Optional[str]) -> str:
    symbol = _currency_symbol_from_code(currency_code)
    if symbol.isalpha():
        return f"{symbol} {price:.2f}"
    return f"{symbol}{price:.2f}"


def _guess_currency_code_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return DEFAULT_CURRENCY_CODE

    for domain_hint, code in DOMAIN_CURRENCY_HINTS.items():
        if domain_hint in host:
            return code

    for suffix, code in TLD_CURRENCY_HINTS.items():
        if host.endswith(suffix):
            return code

    return DEFAULT_CURRENCY_CODE


def _guess_locale_hint_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return ""
    if host.endswith(".de"):
        return "de"
    if host.endswith(".it"):
        return "it"
    if host.endswith(".nl"):
        return "nl"
    if host.endswith(".pt"):
        return "pt"
    return ""


def _canonical_url(url: Optional[str]) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except Exception as exc:
        logger.warning("Failed to canonicalize URL '%s': %s", raw, exc)
        return raw.rstrip("/")

    scheme = (parsed.scheme or "").lower()
    netloc = (parsed.netloc or "").lower()
    path = parsed.path or ""
    if path != "/":
        path = path.rstrip("/")

    query_pairs = parse_qsl(parsed.query or "", keep_blank_values=True)
    query_pairs.sort(key=lambda item: (item[0], item[1]))
    query = urlencode(query_pairs, doseq=True)

    return urlunsplit((scheme, netloc, path, query, ""))


def _normalized_host(url: Optional[str]) -> str:
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().strip()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def _urls_equivalent(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    return _canonical_url(a) == _canonical_url(b)


def _find_tracked_product_by_url(db, url: str, user_id: Optional[str] = None) -> Optional["TrackedProduct"]:
    direct_query = db.query(TrackedProduct).filter(TrackedProduct.url == url)
    if user_id is not None:
        direct_query = direct_query.filter(TrackedProduct.user_id == user_id)
    direct = direct_query.first()
    if direct:
        return direct

    canonical = _canonical_url(url)
    if canonical:
        canonical_query = db.query(TrackedProduct).filter(TrackedProduct.canonical_url == canonical)
        if user_id is not None:
            canonical_query = canonical_query.filter(TrackedProduct.user_id == user_id)
        by_canonical = canonical_query.first()
        if by_canonical:
            return by_canonical

    if not canonical:
        return None

    input_host = _normalized_host(canonical)

    # Exact normalized hostname matching is safer and more predictable than fuzzy substring matching.
    if input_host:
        candidates_query = db.query(TrackedProduct).filter(TrackedProduct.normalized_host == input_host)
    else:
        candidates_query = db.query(TrackedProduct)

    if user_id is not None:
        candidates_query = candidates_query.filter(TrackedProduct.user_id == user_id)
    candidates = candidates_query.all()

    for product in candidates:
        if _urls_equivalent(product.url, canonical):
            return product
    return None


def _walk_json(data, visitor_fn, key_hint="", depth=0, max_depth=6):
    """Recursively walk JSON data, collecting visitor_fn(key, value, key_hint) results."""
    if depth > max_depth:
        return []

    results = []
    if isinstance(data, dict):
        for key, value in data.items():
            lowered_key = str(key).lower()
            combined_hint = f"{key_hint} {lowered_key}".strip()
            results.extend(visitor_fn(key, value, combined_hint))
            results.extend(_walk_json(value, visitor_fn, combined_hint, depth + 1, max_depth))
    elif isinstance(data, list):
        for item in data:
            results.extend(_walk_json(item, visitor_fn, key_hint, depth + 1, max_depth))
    else:
        results.extend(visitor_fn(None, data, key_hint))
    return results


def _collect_currency_codes_from_json(
    data: Any,
    depth: int = 0,
    max_depth: int = 6,
    key_hint: str = "",
) -> List[str]:
    def _currency_visitor(key: Optional[str], value: Any, combined_hint: str) -> List[str]:
        results: List[str] = []
        lowered_key = str(key).lower() if key is not None else ""
        if key is not None and lowered_key in {"pricecurrency", "currency", "currencycode"}:
            maybe_code = _currency_code_from_token(str(value))
            if maybe_code:
                results.append(maybe_code)
        if key is None and isinstance(value, str) and "currency" in combined_hint:
            maybe_code = _currency_code_from_token(value)
            if maybe_code:
                results.append(maybe_code)
        return results

    return _walk_json(data, _currency_visitor, key_hint=key_hint, depth=depth, max_depth=max_depth)


def _extract_currency_code_from_soup(soup: "BeautifulSoup", url: str) -> str:
    currency_selectors = [
        ('meta[itemprop="priceCurrency"]', "content"),
        ('meta[property="product:price:currency"]', "content"),
        ('meta[property="og:price:currency"]', "content"),
    ]
    for selector, attr in currency_selectors:
        node = soup.select_one(selector)
        if not node:
            continue
        maybe_code = _currency_code_from_token(node.get(attr))
        if maybe_code:
            return maybe_code

    for script in soup.select('script[type="application/ld+json"]'):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            logger.warning("Failed to parse JSON-LD currency block in HTML: %s", exc)
            continue
        codes = _collect_currency_codes_from_json(parsed)
        if codes:
            return codes[0]

    return _guess_currency_code_from_url(url)


def _extract_site_name_from_soup(soup: "BeautifulSoup", url: str) -> Optional[str]:
    """Extract the site's official name from og:site_name or related metadata."""
    if not soup:
        return None

    selectors = [
        ('meta[property="og:site_name"]', "content"),
        ('meta[name="application-name"]', "content"),
        ('meta[name="publisher"]', "content"),
    ]
    for css, attr in selectors:
        tag = soup.select_one(css)
        if tag:
            value = (tag.get(attr) or "").strip()
            if value and len(value) < 100:
                return value
    return None


def _extract_currency_code_from_html(html: str, url: str, *, soup: Optional["BeautifulSoup"] = None) -> str:
    if soup is None:
        soup = BeautifulSoup(html or "", "lxml")
    return _extract_currency_code_from_soup(soup, url)


def _extract_currency_code_from_page(page, url: str) -> str:
    selectors = [
        ('meta[itemprop="priceCurrency"]', "content"),
        ('meta[property="product:price:currency"]', "content"),
        ('meta[property="og:price:currency"]', "content"),
    ]
    for selector, attr in selectors:
        try:
            locator = page.locator(selector)
            if locator.count() > 0:
                maybe_code = _currency_code_from_token(locator.first.get_attribute(attr) or "")
                if maybe_code:
                    return maybe_code
        except Exception as exc:
            logger.warning("Failed to inspect page currency selector '%s': %s", selector, exc)
            continue

    try:
        json_ld_nodes = page.locator('script[type="application/ld+json"]')
        for i in range(json_ld_nodes.count()):
            raw = json_ld_nodes.nth(i).text_content() or ""
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except Exception as exc:
                logger.warning("Failed to parse page JSON-LD for currency code: %s", exc)
                continue
            codes = _collect_currency_codes_from_json(parsed)
            if codes:
                return codes[0]
    except Exception as exc:
        logger.warning("Failed to inspect page JSON-LD currency nodes: %s", exc)

    return _guess_currency_code_from_url(url)

# --- DATABASE SETUP ---
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://user:password@localhost:5432/pricetracker")
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class PriceHistory(Base):
    __tablename__ = "price_history"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, nullable=True, index=True)
    product_name = Column(String)
    url = Column(String)
    price = Column(Float, nullable=True)
    original_price = Column(Float, nullable=True)
    currency_code = Column(String(8), nullable=True)
    custom_selector = Column(String, nullable=True)
    original_price_selector = Column(String, nullable=True)
    ui_changed = Column(Boolean, default=False)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    __table_args__ = (
        Index("ix_price_history_url_timestamp", "url", "timestamp"),
        Index("ix_price_history_user_url_timestamp", "user_id", "url", "timestamp"),
    )


class TrackedProduct(Base):
    __tablename__ = "tracked_products"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, nullable=True, index=True)
    url = Column(String, nullable=False)
    canonical_url = Column(String, index=True, nullable=True)
    normalized_host = Column(String, index=True)
    product_name = Column(String, default="Unknown Product")
    site_name = Column(String, nullable=True)
    custom_selector = Column(String, nullable=True)
    current_price = Column(Float, nullable=True)
    original_price = Column(Float, nullable=True)
    original_price_selector = Column(String, nullable=True)
    currency_code = Column(String(8), nullable=True)
    threshold = Column(Float, nullable=True)
    frequency = Column(String, default=DEFAULT_FREQUENCY)
    last_checked = Column(DateTime, nullable=True)
    ui_changed = Column(Boolean, default=False)
    selector_fail_count = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    __table_args__ = (
        Index("ix_tracked_products_user_host", "user_id", "normalized_host"),
        Index("ix_tracked_products_user_url", "user_id", "url", unique=True),
    )


class ExtensionJob(Base):
    __tablename__ = "extension_jobs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, nullable=True, index=True)
    url = Column(String, nullable=False)
    normalized_host = Column(String, nullable=True, index=True)
    custom_selector = Column(String, nullable=True)
    original_price_selector = Column(String, nullable=True)
    status = Column(String, default="pending", nullable=False)
    result_price = Column(Float, nullable=True)
    result_original_price = Column(Float, nullable=True)
    result_name = Column(String, nullable=True)
    result_site_name = Column(String, nullable=True)
    result_currency = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    claimed_at = Column(DateTime, nullable=True)
    error_reason = Column(String, nullable=True)
    attempts = Column(Integer, default=0, nullable=False)
    __table_args__ = (
        Index("ix_extension_jobs_status_created", "status", "created_at"),
    )


class EmailAlertSettings(Base):
    __tablename__ = "email_alert_settings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, nullable=False, index=True)
    enabled = Column(Boolean, default=True, nullable=False)
    recipients = Column(String, default="", nullable=False)  # Comma-separated emails
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)


class PriceAlert(Base):
    __tablename__ = "price_alerts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, nullable=False, index=True)
    url = Column(String, nullable=False)
    product_name = Column(String, nullable=True)
    old_price = Column(Float, nullable=True)
    new_price = Column(Float, nullable=False)
    threshold = Column(Float, nullable=False)
    currency_code = Column(String(8), nullable=True)
    sent = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    sent_at = Column(DateTime, nullable=True)


def get_current_user(token: Optional[str] = Depends(oauth2_scheme)) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        db.expunge(user)
        return user


@asynccontextmanager
async def lifespan(app: FastAPI):
    if JWT_SECRET == "dev-secret-change-in-production" and not IS_DEV_CONTEXT:
        logger.warning("JWT_SECRET is using the default value in a non-dev context. Set a secure production secret.")
    try:
        if AUTO_CREATE_SCHEMA:
            Base.metadata.create_all(bind=engine)
            _ensure_schema_columns()
            with SessionLocal() as db:
                _backfill_normalized_hosts(db)
                _cleanup_extension_jobs(db)
                db.commit()
    except SQLAlchemyError as exc:
        logger.exception("Database initialization failed: %s", exc)

    try:
        yield
    finally:
        HTTP_FIRST_CLIENT_HTTP2.close()
        HTTP_FIRST_CLIENT_HTTP1.close()
        with _ACI_IDLE_TIMER_LOCK:
            if _ACI_IDLE_TIMER is not None:
                _ACI_IDLE_TIMER.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)
# Per-user heartbeat tracking: maps user_id (str) -> last_seen (float timestamp)
_EXTENSION_HEARTBEATS: Dict[str, float] = {}
_EXTENSION_HEARTBEAT_LOCK = threading.Lock()


class ProductRequest(BaseModel):
    url: str
    custom_selector: Optional[str] = None
    original_price_selector: Optional[str] = None
    original_price: Optional[float] = None
    skip_extension: Optional[bool] = False


class TrackedProductRequest(BaseModel):
    url: str
    product_name: Optional[str] = "Unknown Product"
    site_name: Optional[str] = None
    custom_selector: Optional[str] = None
    current_price: Optional[float] = None
    original_price: Optional[float] = None
    original_price_selector: Optional[str] = None
    currency_code: Optional[str] = None
    threshold: Optional[float] = None
    frequency: Optional[str] = None


class ExtensionPriceReport(BaseModel):
    url: str
    price: float
    original_price: Optional[float] = None
    name: Optional[str] = None
    site_name: Optional[str] = None
    currency_code: Optional[str] = None
    selector: Optional[str] = None
    original_selector: Optional[str] = None
    selector_fallback: Optional[bool] = False


class ExtensionHeartbeatPayload(BaseModel):
    active: Optional[bool] = True


class ExtensionJobCompleteRequest(BaseModel):
    url: str
    price: Optional[float] = None
    original_price: Optional[float] = None
    name: Optional[str] = None
    site_name: Optional[str] = None
    currency_code: Optional[str] = None
    selector: Optional[str] = None
    original_selector: Optional[str] = None
    selector_fallback: Optional[bool] = False
    failed: Optional[bool] = False
    error_reason: Optional[str] = None


class EmailAlertSettingsRequest(BaseModel):
    enabled: Optional[bool] = True
    recipients: Optional[List[str]] = []


class EmailAlertSettingsResponse(BaseModel):
    enabled: bool
    recipients: List[str]
    primary_email: str


class AuthRegisterRequest(BaseModel):
    email: str
    password: str


class AuthTokenResponse(BaseModel):
    access_token: str
    refresh_token: Optional[str] = None
    token_type: str = "bearer"


class RefreshTokenRequest(BaseModel):
    refresh_token: str


@app.post("/auth/register")
def auth_register(payload: AuthRegisterRequest):
    email = (payload.email or "").strip().lower()
    password = payload.password or ""
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    try:
        with SessionLocal() as db:
            existing = db.query(User).filter(User.email == email).first()
            if existing:
                raise HTTPException(status_code=409, detail="Email already registered")
            user = User(email=email, password_hash=hash_password(password))
            db.add(user)
            db.commit()
            db.refresh(user)
            return {"id": user.id, "email": user.email}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to register user: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to register user")


@app.post("/auth/login", response_model=AuthTokenResponse)
def auth_login(form_data: OAuth2PasswordRequestForm = Depends()):
    email = (form_data.username or "").strip().lower()
    password = form_data.password or ""
    try:
        with SessionLocal() as db:
            user = db.query(User).filter(User.email == email).first()
            if not user or not verify_password(password, user.password_hash):
                logger.info("auth_login_failed email=%s", email)
                raise HTTPException(status_code=401, detail="Invalid email or password")
            logger.info("auth_login_success user_id=%d email=%s", user.id, email)
            return AuthTokenResponse(
                access_token=create_access_token(user.id),
                refresh_token=create_refresh_token(user.id),
            )
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to login: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to login")


@app.get("/auth/me")
def auth_me(user: User = Depends(get_current_user)):
    return {"id": user.id, "email": user.email}


@app.post("/auth/refresh", response_model=AuthTokenResponse)
def auth_refresh(payload: RefreshTokenRequest):
    """
    Exchange a valid refresh token for a new access token + rotated refresh token.
    The old refresh token is revoked (single-use rotation).

    NOTE (Azure migration): This endpoint will be replaced by Entra ID's
    /oauth2/v2.0/token endpoint. The extension calls this URL, so update
    the extension's API_BASE_URL + path or add a proxy route.
    """
    raw_refresh = (payload.refresh_token or "").strip()
    if not raw_refresh:
        raise HTTPException(status_code=401, detail="Refresh token is required")

    token_payload = decode_refresh_token(raw_refresh)
    if not token_payload:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    user_id_str = token_payload.get("sub")
    try:
        user_id = int(user_id_str) if user_id_str is not None else None
    except (TypeError, ValueError):
        user_id = None
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid refresh token payload")

    # Verify user still exists
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            revoke_refresh_token(raw_refresh)
            raise HTTPException(status_code=401, detail="User not found")

    # Rotate: revoke old, issue new pair
    revoke_refresh_token(raw_refresh)

    logger.info("auth_refresh_success user_id=%s", user_id_str)
    return AuthTokenResponse(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id),
    )


@app.post("/auth/logout")
def auth_logout(payload: RefreshTokenRequest):
    """
    Revoke the refresh token on explicit logout.
    Intentionally lenient - returns 200 even if token is already invalid.
    """
    raw_refresh = (payload.refresh_token or "").strip()
    if raw_refresh:
        revoke_refresh_token(raw_refresh)
    logger.info("auth_logout")
    return {"ok": True}


@app.delete("/auth/account")
def delete_account(caller: User = Depends(get_current_user)):
    """Permanently delete the user's account and all associated data."""
    caller_user_id = str(caller.id)
    logger.info("account_delete_start user=%s email=%s", caller_user_id, caller.email)
    try:
        with SessionLocal() as db:
            # Delete all user data from every table
            db.query(PriceAlert).filter(PriceAlert.user_id == caller_user_id).delete(synchronize_session=False)
            db.query(EmailAlertSettings).filter(EmailAlertSettings.user_id == caller_user_id).delete(synchronize_session=False)
            db.query(ExtensionJob).filter(ExtensionJob.user_id == caller_user_id).delete(synchronize_session=False)
            db.query(PriceHistory).filter(PriceHistory.user_id == caller_user_id).delete(synchronize_session=False)
            db.query(TrackedProduct).filter(TrackedProduct.user_id == caller_user_id).delete(synchronize_session=False)
            db.query(User).filter(User.id == caller.id).delete(synchronize_session=False)
            db.commit()
        logger.info("account_delete_success user=%s", caller_user_id)
        return {"ok": True, "message": "Account and all associated data have been permanently deleted."}
    except SQLAlchemyError as exc:
        logger.exception("account_delete_failed user=%s: %s", caller_user_id, exc)
        raise HTTPException(status_code=500, detail="Failed to delete account. Please try again or contact support.")


_FUEL_CONTEXT_PATTERN = re.compile(
    r"(?i)(/\s*gal\b|\bper\s+gallon\b|\bgallon\b|\bgal\b|/\s*l\b|\bper\s+lit(?:er|re)\b|\blit(?:er|re)\b|\bl\b)"
)
_DOT_THOUSANDS_LOCALE_PREFIXES = {"de", "it", "nl", "pt"}


def _locale_uses_dot_thousands(locale_hint: str) -> bool:
    raw = (locale_hint or "").strip().lower()
    if not raw:
        return False
    prefix = re.split(r"[-_ ]", raw, maxsplit=1)[0]
    return prefix in _DOT_THOUSANDS_LOCALE_PREFIXES


def _is_clear_thousands_grouping(value: str, separator: str) -> bool:
    return bool(re.fullmatch(rf"\d{{1,3}}(?:{re.escape(separator)}\d{{3}})+", value))


def _is_fuel_or_measurement_context(text: str) -> bool:
    return bool(_FUEL_CONTEXT_PATTERN.search(text or ""))


def _normalize_price(
    raw: str,
    *,
    context: str = "",
    locale_hint: str = "",
    currency_hint: str = "",
) -> Optional[float]:
    if not raw:
        return None

    raw_text = str(raw)
    cleaned_text = OLD_PRICE_FRAGMENT_PATTERN.sub(" ", raw_text)
    match = PRICE_TOKEN_PATTERN.search(cleaned_text)
    if not match:
        match = PRICE_TOKEN_PATTERN.search(raw_text)
    if not match:
        return None

    candidate_text = match.group(0)
    cleaned = re.sub(r"[^\d.,]", "", candidate_text)
    if not cleaned:
        return None

    normalized = cleaned
    combined_context = f"{raw_text} {context}".lower()

    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            normalized = cleaned.replace(".", "").replace(",", ".")
        else:
            normalized = cleaned.replace(",", "")
    elif "," in cleaned:
        parts = cleaned.split(",")
        if cleaned.count(",") == 1 and 1 <= len(parts[-1]) <= 2:
            normalized = cleaned.replace(",", ".")
        elif cleaned.count(",") > 1 or _is_clear_thousands_grouping(cleaned, ","):
            normalized = cleaned.replace(",", "")
        else:
            normalized = cleaned.replace(",", ".")
    elif "." in cleaned:
        if _is_fuel_or_measurement_context(combined_context):
            normalized = cleaned
        elif _locale_uses_dot_thousands(locale_hint) and _is_clear_thousands_grouping(cleaned, "."):
            normalized = cleaned.replace(".", "")
        else:
            normalized = cleaned

    try:
        value = float(normalized)
    except ValueError:
        return None

    allow_high_value = value > 1_000_000 and (
        (_locale_uses_dot_thousands(locale_hint) and _is_clear_thousands_grouping(cleaned, "."))
        or _is_clear_thousands_grouping(cleaned, ",")
    )
    if value <= 0 or value > 1_000_000:
        if not allow_high_value:
            return None
    return value


def _best_price_candidate_from_text(
    text: str,
    base_score: int = 0,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
    is_original_mode: bool = False,
) -> Optional[Tuple[float, int]]:
    lowered = text.lower()
    best: Optional[Tuple[float, int]] = None

    for match in PRICE_PATTERN.finditer(text):
        raw = match.group(0)
        start = max(0, match.start() - 40)
        end = min(len(lowered), match.end() + 40)
        context = lowered[start:end]
        value = _normalize_price(
            raw,
            context=context,
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )
        if value is None:
            continue

        score = base_score
        if "." in raw:
            score += 3
        if "$" in raw:
            score += 4

        if is_original_mode:
            if any(hint in context for hint in NEGATIVE_PRICE_HINTS):
                score += 6
            if any(hint in context for hint in POSITIVE_PRICE_HINTS):
                score -= 8
        else:
            if any(hint in context for hint in POSITIVE_PRICE_HINTS):
                score += 6
            if any(hint in context for hint in NEGATIVE_PRICE_HINTS):
                score -= 8

        if best is None or score > best[1]:
            best = (value, score)

    return best


def _extract_price_from_text(
    text: str,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
    is_original_mode: bool = False,
) -> Optional[float]:
    if not text:
        return None
    best = _best_price_candidate_from_text(
        text,
        locale_hint=locale_hint,
        currency_hint=currency_hint,
        is_original_mode=is_original_mode,
    )
    return best[0] if best else None


def _collect_price_values_from_json(
    data: Any,
    key_hint: str = "",
    depth: int = 0,
    max_depth: int = 6,
    locale_hint: str = "",
    currency_hint: str = "",
) -> List[Tuple[float, int]]:
    bad_keys = (
        "shipping",
        "old",
        "original",
        "compare",
        "was",
        "related",
        "recommended",
        "installments",
        "regular",
    )
    good_keys = ("sale", "current", "now", "offer", "display")
    price_keys = {"price", "lowprice", "highprice", "saleprice", "priceamount", "currentprice"}

    def _price_visitor(key: Optional[str], value: Any, combined_hint: str) -> List[Tuple[float, int]]:
        results: List[Tuple[float, int]] = []
        if key is not None:
            lowered_key = str(key).lower()
            if lowered_key in price_keys:
                val = _normalize_price(
                    str(value),
                    context=combined_hint,
                    locale_hint=locale_hint,
                    currency_hint=currency_hint,
                )
                if val is not None:
                    score = 70
                    if "offer" in combined_hint:
                        score += 8
                    if "pricespecification" in combined_hint:
                        score += 4
                    if any(k in combined_hint for k in bad_keys):
                        score -= 40
                    if any(k in combined_hint for k in good_keys):
                        score += 20
                    results.append((val, score))
            return results

        if isinstance(value, (str, int, float)) and "price" in combined_hint:
            val = _normalize_price(
                str(value),
                context=combined_hint,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
            if val is not None:
                score = 62
                if any(k in combined_hint for k in bad_keys):
                    score -= 40
                if any(k in combined_hint for k in good_keys):
                    score += 20
                results.append((val, score))
        return results

    return _walk_json(data, _price_visitor, key_hint=key_hint, depth=depth, max_depth=max_depth)


def _dedupe_candidates(candidates: List[Tuple[float, int]]) -> List[Tuple[float, int]]:
    """Keep only the highest-scored entry per unique price value."""
    seen: Dict[float, int] = {}
    for value, score in candidates:
        key = round(value, 2)
        if key not in seen or score > seen[key]:
            seen[key] = score
    return list(seen.items())


def _pick_best_candidate(candidates: List[Tuple[float, int]]) -> Optional[float]:
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[1], reverse=True)
    return candidates[0][0]


def _is_offer_type(type_val: Any) -> bool:
    """Return True if a JSON-LD @type value represents an Offer or AggregateOffer.

    @type can be a string OR a list (e.g. ["Product", "Thing"]), so both
    forms need to be handled.
    """
    offer_types = {"Offer", "AggregateOffer"}
    if isinstance(type_val, str):
        return type_val in offer_types
    if isinstance(type_val, list):
        return any(t in offer_types for t in type_val)
    return False


def _offer_price(
    offer: dict,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
) -> Optional[float]:
    """Extract the best price from a JSON-LD Offer or AggregateOffer dict.

    AggregateOffer uses lowPrice instead of price.
    """
    raw = offer.get("price") or offer.get("lowPrice") or ""
    return _normalize_price(
        str(raw),
        context=str(offer),
        locale_hint=locale_hint,
        currency_hint=currency_hint,
    )


def _price_candidates_from_ld_json(
    raw: str,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
) -> List[Tuple[float, int]]:
    payload = (raw or "").strip()
    if not payload:
        return []

    try:
        parsed = json.loads(payload)
    except Exception as exc:
        logger.warning("Failed to parse JSON-LD payload for price candidates: %s", exc)
        return []

    if isinstance(parsed, dict) and "@graph" in parsed:
        items = parsed["@graph"]
    elif isinstance(parsed, list):
        items = parsed
    else:
        items = [parsed]

    candidates: List[Tuple[float, int]] = []
    for item in items:
        if not isinstance(item, dict):
            candidates.extend(
                _collect_price_values_from_json(
                    item,
                    locale_hint=locale_hint,
                    currency_hint=currency_hint,
                )
            )
            continue

        offer_checked = False

        if _is_offer_type(item.get("@type")):
            offer_checked = True
            direct_price = _offer_price(
                item,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
            if direct_price is not None:
                candidates.append((direct_price, 100))

        offers = item.get("offers")
        if isinstance(offers, dict) and _is_offer_type(offers.get("@type")):
            offer_checked = True
            direct_price = _offer_price(
                offers,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
            if direct_price is not None:
                candidates.append((direct_price, 100))
        elif isinstance(offers, list):
            for offer in offers:
                if isinstance(offer, dict) and _is_offer_type(offer.get("@type")):
                    offer_checked = True
                    direct_price = _offer_price(
                        offer,
                        locale_hint=locale_hint,
                        currency_hint=currency_hint,
                    )
                    if direct_price is not None:
                        candidates.append((direct_price, 100))

        if not offer_checked:
            candidates.extend(
                _collect_price_values_from_json(
                    item,
                    locale_hint=locale_hint,
                    currency_hint=currency_hint,
                )
            )

    return candidates


def _retry_sleep(attempt: int) -> None:
    wait = min(30, (2 ** attempt) + random.uniform(0, 1))
    time.sleep(wait)


def split_safe_selectors(selector_str: str) -> List[str]:
    """Safely split a comma-separated selector string while respecting quotes."""
    if not selector_str:
        return []

    parts: List[str] = []
    current: List[str] = []
    in_quotes = False
    quote_char = ""

    for index, char in enumerate(selector_str):
        if char in ("'", '"') and (index == 0 or selector_str[index - 1] != "\\"):
            if not in_quotes:
                in_quotes = True
                quote_char = char
            elif quote_char == char:
                in_quotes = False

        if char == "," and not in_quotes:
            part = "".join(current).strip()
            if part:
                parts.append(part)
            current = []
        else:
            current.append(char)

    if current:
        part = "".join(current).strip()
        if part:
            parts.append(part)

    return parts


def _split_selectors(selector: str) -> List[str]:
    return split_safe_selectors(selector)


def _looks_blocked_html(html: str) -> bool:
    t = (html or "").lower()
    return any(marker in t for marker in _BLOCKED_PAGE_MARKERS)


def _extract_with_custom_selector_from_soup(
    soup: "BeautifulSoup",
    selector: str,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
    is_original_mode: bool = False,
) -> Optional[float]:
    normalized_selector = _normalize_selector_value(selector)
    if not normalized_selector:
        return None

    for sel in _split_selectors(normalized_selector):
        parts: List[str] = []
        nodes = []

        try:
            nodes = soup.select(sel)
        except Exception as exc:
            logger.warning("Custom selector strict soup.select failed for '%s': %s", sel, exc)
            nodes = []

        if not nodes:
            parts = [part.strip() for part in sel.split(">") if part.strip()]
            if parts:
                try:
                    nodes = soup.select(parts[-1])
                except Exception as exc:
                    logger.warning("Custom selector fallback soup.select failed for '%s': %s", parts[-1], exc)
                    nodes = []

        target_sel = parts[-1] if parts else sel
        if not nodes and "[" in target_sel and "]" in target_sel:
            attr_match = re.search(
                r"([a-zA-Z][\w-]*)?\[\s*([^\]=~\^\$\*\|\s]+)\s*=\s*['\"]?([^'\"\]]+)['\"]?\s*\]",
                target_sel,
            )
            if attr_match:
                tag = attr_match.group(1)
                key = attr_match.group(2)
                value = attr_match.group(3)
                if tag:
                    nodes.extend(soup.find_all(tag, attrs={key: value}))
                else:
                    nodes.extend(soup.find_all(attrs={key: value}))

        if not nodes and "[" in target_sel:
            attr_match = re.search(r'\[([^\]=]+)=["\']?([^"\'\]]+)', target_sel)
            if attr_match:
                key, value = attr_match.group(1), attr_match.group(2)
                nodes = soup.find_all(attrs={key: re.compile(re.escape(value))})

        sel_candidates: List[float] = []
        for node in nodes:
            text_price = _extract_price_from_text(
                node.get_text(" ", strip=True),
                locale_hint=locale_hint,
                currency_hint=currency_hint,
                is_original_mode=is_original_mode,
            )
            if text_price is not None:
                sel_candidates.append(text_price)
            for attr in ("content", "data-price", "aria-label"):
                raw_attr = node.get(attr)
                if raw_attr:
                    attr_price = _extract_price_from_text(
                        str(raw_attr),
                        locale_hint=locale_hint,
                        currency_hint=currency_hint,
                        is_original_mode=is_original_mode,
                    )
                    if attr_price is not None:
                        sel_candidates.append(attr_price)

        if sel_candidates:
            return sel_candidates[0]

    return None


def _extract_fallback_price_from_soup(
    soup: "BeautifulSoup",
    url: str,
    *,
    locale_hint: str = "",
    currency_hint: str = "",
) -> Optional[float]:
    candidates: List[Tuple[float, int]] = []

    # Tier 1: Site-specific selectors (contribute to shared candidates, don't return early)
    for domain, selectors in SITE_SELECTORS.items():
        if domain in url:
            for selector in selectors["price"]:
                for node in soup.select(selector)[:3]:
                    best = _best_price_candidate_from_text(
                        node.get_text(" ", strip=True),
                        base_score=95,
                        locale_hint=locale_hint,
                        currency_hint=currency_hint,
                    )
                    if best:
                        candidates.append(best)
                    for attr in ("content", "data-price", "aria-label"):
                        raw_attr = node.get(attr)
                        if raw_attr:
                            attr_best = _best_price_candidate_from_text(
                                str(raw_attr),
                                base_score=97,
                                locale_hint=locale_hint,
                                currency_hint=currency_hint,
                            )
                            if attr_best:
                                candidates.append(attr_best)
            break

    # Tier 2: Structured metadata
    og_price = soup.select_one('meta[property="og:price:amount"]')
    if og_price and og_price.get("content"):
        p = _normalize_price(
            og_price["content"],
            context='meta[property="og:price:amount"]',
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )
        if p is not None:
            candidates.append((p, 98))

    meta_price = soup.select_one('meta[itemprop="price"]')
    if meta_price and meta_price.get("content"):
        p = _normalize_price(
            meta_price["content"],
            context='meta[itemprop="price"]',
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )
        if p is not None:
            candidates.append((p, 88))

    # Facebook product OG
    fb_price = soup.select_one('meta[property="product:price:amount"]')
    if fb_price and fb_price.get("content"):
        p = _normalize_price(
            fb_price["content"],
            context='meta[property="product:price:amount"]',
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )
        if p is not None:
            candidates.append((p, 96))

    # Twitter card
    twitter_price = soup.select_one('meta[name="twitter:data1"]')
    if twitter_price and twitter_price.get("content"):
        p = _normalize_price(
            twitter_price["content"],
            context='meta[name="twitter:data1"]',
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )
        if p is not None:
            candidates.append((p, 85))

    for script in soup.select('script[type="application/ld+json"]'):
        raw = (script.string or script.get_text() or "").strip()
        candidates.extend(
            _price_candidates_from_ld_json(
                raw,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
        )

    
    # Tier 3: Semantic selectors with scoring
    generic_selectors = {
        '[itemprop="price"]': 90,
        '[data-automation-id="price-price-amount"]': 90,
        '[data-testid="price-wrap"]': 82,
        '[data-testid="price-current"]': 86,
        '[class*="price"]': 74,
        '[id*="price"]': 72,
        '[data-price]': 88,
        '[aria-label*="price"]': 80,
        '.product-price': 78,
        '.sale-price': 82,
    }
    for sel, base_score in generic_selectors.items():
        for node in soup.select(sel)[:5]:
            txt = node.get_text(" ", strip=True)
            best = _best_price_candidate_from_text(
                txt,
                base_score=base_score,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
            if best:
                candidates.append(best)

            for attr in ("content", "data-price", "aria-label"):
                raw_attr = node.get(attr)
                if raw_attr:
                    attr_best = _best_price_candidate_from_text(
                        str(raw_attr),
                        base_score=base_score + 2,
                        locale_hint=locale_hint,
                        currency_hint=currency_hint,
                    )
                    if attr_best:
                        candidates.append(attr_best)


    # Tier 4: Sliding-window body text fallback
    if not candidates:
        try:
            fallback_soup = copy.copy(soup)
        except Exception as exc:
            logger.warning("Failed to clone soup for fallback text extraction: %s", exc)
            fallback_soup = soup
        for tag in fallback_soup(["script", "style", "noscript", "header", "footer", "nav", "aside"]):
            tag.extract()
        for tag in fallback_soup.select('[class*="related"], [class*="recommend"], [class*="review"], [class*="breadcrumb"]'):
            tag.extract()
        body_text = fallback_soup.get_text(" ", strip=True)
        window_size = 3000
        step = 1500
        for window_start in range(0, max(1, len(body_text) - window_size + 1), step):
            window = body_text[window_start: window_start + 3000]
            body_best = _best_price_candidate_from_text(
                window,
                base_score=25,
                locale_hint=locale_hint,
                currency_hint=currency_hint,
            )
            if body_best:
                candidates.append(body_best)

    return _pick_best_candidate(_dedupe_candidates(candidates))


def _extract_prices_from_html(
    html: str,
    url: str,
    custom_selector: Optional[str] = None,
    original_price_selector: Optional[str] = None,
    *,
    soup: Optional["BeautifulSoup"] = None,
) -> Dict[str, Any]:
    if not html and soup is None:
        return {"price": None, "original_price": None, "selector_worked": False}

    if soup is None:
        soup = BeautifulSoup(html, "lxml")
    locale_hint = _guess_locale_hint_from_url(url)
    currency_hint = _guess_currency_code_from_url(url)

    normalized_custom_selector = _normalize_selector_value(custom_selector)
    normalized_original_selector = _normalize_selector_value(original_price_selector)

    price = _extract_with_custom_selector_from_soup(
        soup,
        normalized_custom_selector or "",
        locale_hint=locale_hint,
        currency_hint=currency_hint,
    )
    selector_worked = price is not None
    original_price = _extract_with_custom_selector_from_soup(
        soup,
        normalized_original_selector or "",
        locale_hint=locale_hint,
        currency_hint=currency_hint,
        is_original_mode=True,
    )

    if price is None:
        price = _extract_fallback_price_from_soup(
            soup,
            url,
            locale_hint=locale_hint,
            currency_hint=currency_hint,
        )

    return {"price": price, "original_price": original_price, "selector_worked": selector_worked}


def _extract_price_from_html(
    html: str,
    url: str,
    custom_selector: Optional[str] = None,
    *,
    soup: Optional["BeautifulSoup"] = None,
) -> Optional[float]:
    return _extract_prices_from_html(
        html,
        url,
        custom_selector=custom_selector,
        soup=soup,
    )["price"]


def try_http_first(
    url: str,
    custom_selector: Optional[str] = None,
    original_price_selector: Optional[str] = None,
) -> Dict[str, Any]:
    max_attempts = int(os.getenv("HTTP_FIRST_MAX_ATTEMPTS", "3"))
    transient_codes = {429, 500, 502, 503, 504}
    host = (urlparse(url).hostname or "").lower()
    use_http2 = host not in HTTP1_DOMAINS

    try:
        last_reason = "unknown"
        for attempt in range(max_attempts):
            try:
                attempt_headers = dict(HTTP_FIRST_HEADERS)
                attempt_headers["User-Agent"] = random.choice(USER_AGENTS)
                client = HTTP_FIRST_CLIENT_HTTP2 if use_http2 else HTTP_FIRST_CLIENT_HTTP1
                response = client.get(url, headers=attempt_headers)
            except httpx.HTTPError as exc:
                last_reason = f"HTTP-first network error: {exc}"
                if attempt < max_attempts - 1:
                    _retry_sleep(attempt)
                    continue
                return {"ok": False, "reason": last_reason}

            html = response.text or ""
            status_code = response.status_code

            if status_code in PERMANENT_ERROR_CODES:
                return {"ok": False, "reason": f"HTTP status {status_code}"}

            if status_code in transient_codes:
                last_reason = f"Transient HTTP status {status_code}"
                if attempt < max_attempts - 1:
                    _retry_sleep(attempt)
                    continue
                return {"ok": False, "reason": last_reason}

            if status_code >= 400:
                return {"ok": False, "reason": f"HTTP status {status_code}"}

            if _looks_blocked_html(html):
                return {"ok": False, "reason": "Blocked/challenge HTML detected"}

            soup = BeautifulSoup(html, "lxml")
            title = (soup.title.get_text(strip=True) if soup.title else "") or "Unknown Product"
            site_name = _extract_site_name_from_soup(soup, url)
            extracted_prices = _extract_prices_from_html(
                html,
                url,
                custom_selector=custom_selector,
                original_price_selector=original_price_selector,
                soup=soup,
            )
            price = extracted_prices.get("price")
            if price is None:
                return {"ok": False, "reason": "Price not found in raw HTML"}

            currency_code = _extract_currency_code_from_soup(soup, url)
            return {
                "ok": True,
                "name": title,
                "site_name": site_name,
                "price": price,
                "original_price": extracted_prices.get("original_price"),
                "currency_code": currency_code,
                "selector_worked": extracted_prices.get("selector_worked"),
            }

        return {"ok": False, "reason": f"HTTP-first exhausted retries: {last_reason}"}

    except Exception as exc:
        return {"ok": False, "reason": f"HTTP-first failed: {exc}"}


def _extract_prices_from_page(
    page,
    url: str,
    custom_selector: Optional[str] = None,
    original_price_selector: Optional[str] = None,
) -> Dict[str, Any]:
    normalized_custom_selector = _normalize_selector_value(custom_selector)
    normalized_original_selector = _normalize_selector_value(original_price_selector)

    price: Optional[float] = None
    original_price: Optional[float] = None

    if normalized_custom_selector:
        try:
            price = _extract_with_custom_selector(page, normalized_custom_selector)
        except PlaywrightTimeoutError:
            pass
        except Exception as exc:
            logger.warning("Custom selector extraction failed on page: %s", exc)
    playwright_selector_worked = price is not None

    if normalized_original_selector:
        try:
            original_price = _extract_with_custom_selector(
                page,
                normalized_original_selector,
                is_original_mode=True,
            )
        except PlaywrightTimeoutError:
            pass
        except Exception as exc:
            logger.warning("Original price selector extraction failed on page: %s", exc)

    needs_price_html = price is None
    needs_original_html = normalized_original_selector is not None and original_price is None
    if not needs_price_html and not needs_original_html:
        return {"price": price, "original_price": original_price, "selector_worked": True}

    try:
        html = page.content()
    except Exception as exc:
        logger.warning("Failed to read page HTML content: %s", exc)
        return {"price": price, "original_price": original_price, "selector_worked": playwright_selector_worked}

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as exc:
        logger.warning("Failed to parse page HTML with BeautifulSoup: %s", exc)
        return {"price": price, "original_price": original_price, "selector_worked": playwright_selector_worked}

    extracted_prices = _extract_prices_from_html(
        "",
        url,
        custom_selector=normalized_custom_selector if needs_price_html else None,
        original_price_selector=normalized_original_selector if needs_original_html else None,
        soup=soup,
    )
    if price is None:
        price = extracted_prices.get("price")
    if original_price is None:
        original_price = extracted_prices.get("original_price")

    return {"price": price, "original_price": original_price, "selector_worked": playwright_selector_worked}


def _ensure_schema_columns():
    try:
        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())
        user_columns = {c["name"] for c in inspector.get_columns("users")} if "users" in table_names else set()
        history_columns = {c["name"] for c in inspector.get_columns("price_history")} if "price_history" in table_names else set()
        tracked_columns = {c["name"] for c in inspector.get_columns("tracked_products")} if "tracked_products" in table_names else set()
        ext_job_columns = {c["name"] for c in inspector.get_columns("extension_jobs")} if "extension_jobs" in table_names else set()
        with engine.begin() as conn:
            if "users" in table_names and "email" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR"))
            if "users" in table_names and "password_hash" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR"))
            if "users" in table_names and "created_at" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN created_at TIMESTAMP"))
            if "users" in table_names:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)"))

            if "price_history" in table_names and "custom_selector" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN custom_selector VARCHAR"))
            if "price_history" in table_names and "original_price" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN original_price FLOAT"))
            if "price_history" in table_names and "original_price_selector" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN original_price_selector VARCHAR"))
            if "price_history" in table_names and "ui_changed" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN ui_changed BOOLEAN DEFAULT FALSE"))
            if "price_history" in table_names and "currency_code" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN currency_code VARCHAR"))
            if "price_history" in table_names and "user_id" not in history_columns:
                conn.execute(text("ALTER TABLE price_history ADD COLUMN user_id VARCHAR"))

            if "tracked_products" in table_names and "currency_code" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN currency_code VARCHAR"))
            if "tracked_products" in table_names and "original_price" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN original_price FLOAT"))
            if "tracked_products" in table_names and "original_price_selector" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN original_price_selector VARCHAR"))
            if "tracked_products" in table_names and "normalized_host" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN normalized_host VARCHAR"))
            if "tracked_products" in table_names and "canonical_url" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN canonical_url VARCHAR"))
            if "tracked_products" in table_names and "user_id" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN user_id VARCHAR"))
            if "tracked_products" in table_names and "site_name" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN site_name VARCHAR"))
            if "tracked_products" in table_names and "selector_fail_count" not in tracked_columns:
                conn.execute(text("ALTER TABLE tracked_products ADD COLUMN selector_fail_count INTEGER DEFAULT 0"))

            if "extension_jobs" in table_names and "user_id" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN user_id VARCHAR"))
            if "extension_jobs" in table_names and "original_price_selector" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN original_price_selector VARCHAR"))
            if "extension_jobs" in table_names and "result_original_price" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN result_original_price FLOAT"))
            if "extension_jobs" in table_names and "result_site_name" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN result_site_name VARCHAR"))
            if "extension_jobs" in table_names and "claimed_at" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN claimed_at TIMESTAMP"))
            if "extension_jobs" in table_names and "error_reason" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN error_reason VARCHAR"))
            if "extension_jobs" in table_names and "attempts" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN attempts INTEGER DEFAULT 0"))
            if "extension_jobs" in table_names and "normalized_host" not in ext_job_columns:
                conn.execute(text("ALTER TABLE extension_jobs ADD COLUMN normalized_host VARCHAR"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_extension_jobs_normalized_host ON extension_jobs (normalized_host)"))

            # Email alert settings and price alerts tables
            alert_settings_columns = {
                c["name"] for c in inspector.get_columns("email_alert_settings")
            } if "email_alert_settings" in table_names else set()
            if "email_alert_settings" in table_names and "updated_at" not in alert_settings_columns:
                conn.execute(text("ALTER TABLE email_alert_settings ADD COLUMN updated_at TIMESTAMP"))

            price_alert_columns = {
                c["name"] for c in inspector.get_columns("price_alerts")
            } if "price_alerts" in table_names else set()
            if "price_alerts" in table_names and "sent_at" not in price_alert_columns:
                conn.execute(text("ALTER TABLE price_alerts ADD COLUMN sent_at TIMESTAMP"))

            if "price_history" in table_names:
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_price_history_url_timestamp ON price_history (url, timestamp)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_price_history_user_url_timestamp ON price_history (user_id, url, timestamp)"))
            if "tracked_products" in table_names:
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tracked_products_user_host ON tracked_products (user_id, normalized_host)"))
                try:
                    conn.execute(text("DROP INDEX IF EXISTS ix_tracked_products_url"))
                except Exception:
                    pass
                try:
                    conn.execute(text("ALTER TABLE tracked_products DROP CONSTRAINT IF EXISTS tracked_products_url_key"))
                except Exception:
                    pass
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_tracked_products_user_url ON tracked_products (user_id, url)"))
            if "extension_jobs" in table_names:
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_extension_jobs_status_created ON extension_jobs (status, created_at)"))
    except SQLAlchemyError as exc:
        logger.exception("Schema auto-migration failed: %s", exc)


def _backfill_normalized_hosts(db: Session) -> None:
    products = db.query(TrackedProduct).all()
    changed = False
    for product in products:
        normalized = _normalized_host(product.url)
        if product.normalized_host != normalized:
            product.normalized_host = normalized
            changed = True
        canonical = _canonical_url(product.url)
        if product.canonical_url != canonical:
            product.canonical_url = canonical
            changed = True
    if changed:
        db.commit()


def _prune_old_history(db, *, url: Optional[str] = None):
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=HISTORY_RETENTION_DAYS)
    query = db.query(PriceHistory).filter(PriceHistory.timestamp < cutoff)
    if url:
        query = query.filter(PriceHistory.url == url)
    query.delete(synchronize_session=False)


def _cleanup_extension_jobs(db):
    now = datetime.datetime.now(datetime.timezone.utc)
    # Delete old completed/failed jobs
    retention_cutoff = now - datetime.timedelta(seconds=EXTENSION_JOB_RETENTION_SECONDS)
    db.query(ExtensionJob).filter(
        ExtensionJob.status.in_(["done", "failed"]),
        ExtensionJob.created_at < retention_cutoff,
    ).delete(synchronize_session=False)
    # Reset stale in_progress jobs back to pending (extension crashed or timed out)
    stale_cutoff = now - datetime.timedelta(seconds=EXTENSION_JOB_STALE_SECONDS)
    db.query(ExtensionJob).filter(
        ExtensionJob.status == "in_progress",
        ExtensionJob.claimed_at < stale_cutoff,
    ).update({"status": "pending", "claimed_at": None}, synchronize_session=False)
    # Delete very old pending jobs that were never picked up
    old_pending_cutoff = now - datetime.timedelta(seconds=EXTENSION_JOB_RETENTION_SECONDS)
    db.query(ExtensionJob).filter(
        ExtensionJob.status == "pending",
        ExtensionJob.created_at < old_pending_cutoff,
    ).delete(synchronize_session=False)


def _ui_changed_http_exception(message: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "error_code": UI_CHANGED_ERROR_CODE,
            "error": message,
        },
    )


def _save_price_history(
    product_name: str,
    url: str,
    price: Optional[float],
    original_price: Optional[float] = None,
    currency_code: Optional[str] = None,
    custom_selector: Optional[str] = None,
    original_price_selector: Optional[str] = None,
    ui_changed: bool = False,
    user_id: Optional[str] = None,
):
    if price is not None and price <= 0:
        return

    try:
        with SessionLocal() as db:
            db.add(
                PriceHistory(
                    product_name=product_name,
                    url=url,
                    price=price,
                    original_price=original_price,
                    user_id=user_id,
                    currency_code=normalize_currency_code(currency_code),
                    custom_selector=custom_selector,
                    original_price_selector=original_price_selector,
                    ui_changed=ui_changed,
                )
            )
            _prune_old_history(db)
            db.commit()
    except SQLAlchemyError as exc:
        logger.exception("Failed to save price history: %s", exc)


def _get_latest_selector_for_url(url: str, user_id: Optional[str] = None) -> Optional[str]:
    latest = _get_latest_selectors_for_url(url, user_id=user_id)
    return latest.get("custom_selector")


def _get_latest_selectors_for_url(url: str, user_id: Optional[str] = None) -> Dict[str, Optional[str]]:
    try:
        with SessionLocal() as db:
            query = db.query(PriceHistory).filter(
                PriceHistory.url == url,
                or_(
                    PriceHistory.custom_selector.isnot(None),
                    PriceHistory.original_price_selector.isnot(None),
                ),
            )
            if user_id is not None:
                query = query.filter(PriceHistory.user_id == user_id)
            row = query.order_by(PriceHistory.timestamp.desc()).first()
            return {
                "custom_selector": row.custom_selector if row and row.custom_selector else None,
                "original_price_selector": row.original_price_selector if row and row.original_price_selector else None,
            }
    except SQLAlchemyError as exc:
        logger.exception("Failed reading selectors for %s: %s", url, exc)
        return {"custom_selector": None, "original_price_selector": None}


def _set_ui_changed_for_url(url: str, is_changed: bool, user_id: Optional[str] = None):
    try:
        with SessionLocal() as db:
            query = db.query(PriceHistory).filter(PriceHistory.url == url)
            if user_id is not None:
                query = query.filter(PriceHistory.user_id == user_id)
            updated = query.update(
                {"ui_changed": is_changed}, synchronize_session=False
            )
            if updated == 0:
                db.add(
                    PriceHistory(
                        product_name="Unknown Product",
                        url=url,
                        price=None,
                        user_id=user_id,
                        currency_code=_guess_currency_code_from_url(url),
                        custom_selector=None,
                        ui_changed=is_changed,
                    )
                )
            db.commit()
    except SQLAlchemyError as exc:
        logger.exception("Failed updating ui_changed for %s: %s", url, exc)


def _upsert_selector_for_url(
    url: str,
    selector: Optional[str] = None,
    user_id: Optional[str] = None,
    original_price_selector: Optional[str] = None,
):
    try:
        with SessionLocal() as db:
            query = db.query(PriceHistory).filter(PriceHistory.url == url)
            if user_id is not None:
                query = query.filter(PriceHistory.user_id == user_id)
            row = query.order_by(PriceHistory.timestamp.desc()).first()
            normalized_selector = _normalize_selector_value(selector)
            normalized_original_selector = _normalize_selector_value(original_price_selector)
            if row:
                if normalized_selector is not None:
                    row.custom_selector = normalized_selector
                if normalized_original_selector is not None:
                    row.original_price_selector = normalized_original_selector
                row.ui_changed = False
            else:
                db.add(
                    PriceHistory(
                        product_name="Unknown Product",
                        url=url,
                        price=None,
                        user_id=user_id,
                        currency_code=_guess_currency_code_from_url(url),
                        custom_selector=normalized_selector,
                        original_price_selector=normalized_original_selector,
                        ui_changed=False,
                    )
                )
            db.commit()
    except SQLAlchemyError as exc:
        logger.exception("Failed storing selector for %s: %s", url, exc)


def _extract_with_custom_selector(
    page,
    selector: str,
    *,
    is_original_mode: bool = False,
) -> Optional[float]:
    for sel in split_safe_selectors(selector):
        sel = (sel or "").strip()
        if not sel:
            continue

        try:
            locator = page.locator(sel)
            count = locator.count()
        except Exception as exc:
            logger.warning("Selector fallback failed for '%s': %s", sel, exc)
            continue

        if count == 0:
            continue

        for i in range(count):
            node = locator.nth(i)
            try:
                if not node.is_visible():
                    continue
            except Exception as exc:
                logger.warning("Visibility check failed for selector '%s' match %s: %s", sel, i, exc)
                continue

            try:
                text = (node.inner_text() or "").strip()
            except Exception as exc:
                logger.warning("Failed to read text for selector '%s' match %s: %s", sel, i, exc)
                text = ""

            if text:
                text_price = _normalize_price(text, context=text)
                if text_price is None:
                    text_price = _extract_price_from_text(
                        text,
                        is_original_mode=is_original_mode,
                    )
                if text_price is not None:
                    return text_price

            for attr in ("content", "data-price", "aria-label"):
                try:
                    raw_attr = (node.get_attribute(attr) or "").strip()
                except Exception as exc:
                    logger.warning(
                        "Failed to read attribute '%s' for selector '%s' match %s: %s",
                        attr,
                        sel,
                        i,
                        exc,
                    )
                    raw_attr = ""
                if not raw_attr:
                    continue

                attr_price = _normalize_price(raw_attr, context=raw_attr)
                if attr_price is None:
                    attr_price = _extract_price_from_text(
                        raw_attr,
                        is_original_mode=is_original_mode,
                    )
                if attr_price is not None:
                    return attr_price

    return None


HTTP1_DOMAINS = {"www.bestbuy.com", "bestbuy.com"}
BOT_AGGRESSIVE_DOMAINS = {"walmart.com", "target.com", "bestbuy.com", "nike.com", "homedepot.com"}
_BLOCKED_PAGE_MARKERS = [
    "verify you are human",
    "robot or human",
    "press & hold",
    "perimeterx",
    "px-captcha",
    "sorry, you have been blocked",
    "your ip address has been blocked",
]
BOT_TITLE_MARKERS = [
    "cloudflare",
    "captcha",
    "security check",
    "security verification",
    "security challenge",
    "robot",
    "access denied",
    "just a moment",
]

# ── Cookie banner: named-framework selectors (reject/necessary-only first) ─
_COOKIE_FRAMEWORK_SELECTORS = [
    "#onetrust-reject-all-handler",
    "button#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "a#CybotCookiebotDialogBodyButtonDecline",
    ".truste_overlay .pdynamicbutton a.call",
    ".truste_popframe .required",
    ".qc-cmp2-summary-buttons button:first-child",
    "#didomi-notice-disagree-button",
    ".osano-cm-deny",
    ".termly-popup .t-declineButton",
    ".cmplz-btn.cmplz-deny",
    ".cn-refuse",
    ".cky-btn-reject",
    ".iubenda-cs-reject-btn",
    "[data-testid='uc-deny-all-button']",
    "#axeptio_btn_dismiss",
    "#tarteaucitronAllDenied2",
    ".cc-deny",
    "#cookiescript_reject",
    ".js-cookie-consent-reject",
    "[data-cookiefirst-action='reject']",
    "#consent-reject",
    ".evidon-banner-declinebutton",
    "#gdpr-cookie-reject",
    ".fc-cta-do-not-consent",
]
_COOKIE_REJECT_CSS = [
    "button[aria-label*='Reject' i]",
    "button[aria-label*='Decline' i]",
    "button[aria-label*='Necessary' i]",
    "button[aria-label*='Essential' i]",
    "[data-action='reject-all']",
    "[data-action='decline']",
    "[data-testid*='reject' i]",
    "[data-testid*='decline' i]",
    "[data-testid*='necessary' i]",
    "button[id*='reject' i]",
    "button[id*='decline' i]",
    "button[class*='reject' i]",
    "button[class*='decline' i]",
    "button[class*='refuse' i]",
    "button[class*='necessary' i]",
    "button[class*='deny' i]",
    "a[class*='reject' i]",
    "[data-gdpr-action='reject']",
]
_COOKIE_REJECT_TEXTS = [
    "reject all", "decline all", "refuse all", "necessary only",
    "only necessary", "essential only", "only essential", "required only",
    "deny all", "reject cookies", "decline cookies",
    "only required cookies", "continue without accepting",
    "use necessary cookies only",
    "alle ablehnen", "nur notwendige", "nur erforderliche cookies", "ablehnen",
    "tout refuser", "refuser tout", "refuser", "cookies nécessaires uniquement",
    "rechazar todo", "rechazar todas", "solo necesarias",
    "rifiuta tutto", "rifiuta tutti", "solo necessari",
    "alles weigeren", "alleen noodzakelijke",
]
_COOKIE_SETTINGS_SELECTORS = [
    "#onetrust-pc-btn-handler",
    "button#onetrust-pc-btn-handler",
    "#CybotCookiebotDialogBodyButtonDetails",
    "a#CybotCookiebotDialogBodyButtonDetails",
    ".qc-cmp2-link",
    ".qc-cmp2-footer-links button",
    "#didomi-notice-learn-more-button",
    ".osano-cm-manage",
    ".termly-styles-manage-preferences-button",
    ".termly-display-preferences",
    ".cmplz-btn.cmplz-view-preferences",
    ".cky-btn-customize",
    ".iubenda-cs-customize-btn",
    "[data-testid='uc-more-button']",
    "[data-testid='uc-manage-all-button']",
    "[data-testid='uc-manage-options-button']",
    "#axeptio_btn_configure",
    "#cookiescript_manage",
    "[data-cookiefirst-action='settings']",
    ".fc-manage-preferences",
    ".cc-link",
]
_COOKIE_SETTINGS_TEXTS = [
    "manage preferences", "manage options", "manage settings", "cookie settings",
    "privacy settings", "customize", "customise", "preferences", "more options",
    "settings", "show purposes", "manage choices",
    "einstellungen", "einstellungen verwalten",
    "paramètres", "gérer les préférences",
    "configuración", "gestionar preferencias",
    "impostazioni", "gestisci preferenze",
    "instellingen", "voorkeuren beheren",
]
_COOKIE_SAVE_SELECTORS = [
    "#onetrust-confirm-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection",
    ".qc-cmp2-footer button:last-child",
    "#didomi-save-button",
    "[data-testid='didomi-save-button']",
    ".osano-cm-save",
    ".cmplz-btn.cmplz-save-preferences",
    ".cky-btn-preferences",
    "[data-testid='uc-save-button']",
    "#cookiescript_save",
    "[data-cookiefirst-action='save']",
    ".fc-confirm-choices",
]
_COOKIE_SAVE_TEXTS = [
    "save", "save preferences", "confirm choices", "save and exit",
    "confirm my choices", "save settings", "apply selection", "continue",
    "save and continue",
    "auswahl speichern", "einstellungen speichern",
    "enregistrer", "enregistrer les préférences",
    "guardar", "guardar preferencias",
    "salva", "salva preferenze",
    "opslaan", "voorkeuren opslaan",
]
_COOKIE_ACCEPT_FRAMEWORK = [
    "#sp-cc-accept",
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#didomi-notice-agree-button",
    ".osano-cm-accept",
    ".cky-btn-accept",
    ".iubenda-cs-accept-btn",
    "[data-testid='uc-accept-all-button']",
    "#axeptio_btn_acceptAll",
    "button[id*='accept-all' i]",
    "button[class*='accept-all' i]",
    "button[id*='acceptAll' i]",
    "button[class*='acceptAll' i]",
    "#tarteaucitronAllAllowed2",
    "#cookiescript_accept",
    "[data-cookiefirst-action='accept']",
    ".fc-cta-consent",
    ".evidon-banner-acceptbutton",
]
_COOKIE_ACCEPT_TEXTS = [
    "accept all", "accept all cookies", "allow all", "allow all cookies",
    "i accept", "i agree", "agree and continue", "agree to all", "got it", "ok",
    "accept cookies", "accept & continue", "yes, i agree",
    "acknowledge", "understood",
    "alle akzeptieren", "alle annehmen", "alle zulassen", "akzeptieren",
    "tout accepter", "accepter tout", "accepter",
    "aceptar todo", "aceptar todas",
    "accetta tutto", "accetta tutti",
    "alles accepteren", "alles toestaan",
]
_COOKIE_CONTAINER_SELECTORS = [
    "#sp-cc", ".sp-cc-banner",
    "#onetrust-banner-sdk", "#onetrust-consent-sdk", "#CybotCookiebotDialog",
    ".truste_overlay", ".qc-cmp2-container", "#didomi-popup", ".osano-cm-dialog",
    "#usercentrics-root", "[data-testid='uc-banner-content']",
    ".cky-consent-container", ".cky-modal",
    ".cmplz-cookiebanner", "#cookie-notice", ".cookie-notice", ".cookie-banner",
    ".cookie-consent", "#cookie-banner", "#cookie-consent", "#cookieBanner",
    "#cookieConsent", ".cc-banner", ".cc-window",
    "[id*='cookie-bar']", "[class*='cookie-bar']", "[class*='gdpr-banner']",
    "[aria-label*='cookie' i]", "[aria-label*='consent' i]",
    "#tarteaucitronRoot",
    ".fc-consent-root",
    "#cookiescript_injected",
    "[class*='CookieConsent']",
    "[id*='gdpr']",
    "[class*='privacy-banner']",
    "#cookie-law-info-bar",
]
_COOKIE_BODY_KEYWORDS = (
    "we use cookies", "this site uses cookies", "cookie policy",
    "your privacy", "gdpr", "privacy preferences", "privacy choices",
    "manage cookies", "cookie consent",
    "uses cookies and similar", "cookie settings", "data protection",
    "wir verwenden cookies", "diese website verwendet cookies", "cookie-einstellungen",
    "datenschutzeinstellungen", "wir nutzen cookies", "cookie-richtlinie",
    "nous utilisons des cookies", "ce site utilise des cookies", "paramètres des cookies",
    "politique de cookies", "gestion des cookies",
    "utilizamos cookies", "este sitio utiliza cookies", "configuración de cookies",
    "política de cookies",
    "utilizziamo i cookie", "questo sito utilizza cookie", "impostazioni cookie",
    "informativa sui cookie",
    "wij gebruiken cookies", "deze website gebruikt cookies", "cookie-instellingen",
    "utilizamos cookies", "este site utiliza cookies", "configurações de cookies",
)
_COOKIE_IFRAME_HINT_SELECTORS = [
    "iframe[src*='consent' i]",
    "iframe[src*='cookie' i]",
    "iframe[src*='privacy' i]",
    "iframe[src*='cmp' i]",
    "iframe[src*='onetrust' i]",
    "iframe[src*='didomi' i]",
    "iframe[src*='cookiefirst' i]",
    "iframe[src*='usercentrics' i]",
    "iframe[id*='cookie' i]",
    "iframe[class*='cookie' i]",
]
_COOKIE_NON_ESSENTIAL_KEYWORDS = (
    "analytics", "analytic", "advertising", "marketing", "targeting",
    "personalization", "personalisation", "performance", "functional",
    "social media", "measurement", "experience", "statistics",
)
_COOKIE_ESSENTIAL_KEYWORDS = (
    "necessary", "essential", "strictly necessary", "required",
    "always active",
)
_SCROLL_LOCK_CLASSES = (
    "modal-open", "overflow-hidden", "no-scroll", "noscroll",
    "scroll-lock", "disable-scroll", "body-no-scroll",
    "ReactModal__Body--open", "ReactModal__Html--open",
    "fancybox-active", "lock-scroll",
)
_CMP_PROFILES: Dict[str, Dict[str, List[str]]] = {
    "amazon": {
        "container_selectors": ["#sp-cc", ".sp-cc-banner"],
        "reject_selectors": ["#sp-cc-rejectall-link"],
        "settings_selectors": [],
        "save_selectors": [],
        "iframe_selectors": [],
    },
    "onetrust": {
        "container_selectors": ["#onetrust-banner-sdk", "#onetrust-consent-sdk"],
        "reject_selectors": ["#onetrust-reject-all-handler", "button#onetrust-reject-all-handler"],
        "settings_selectors": ["#onetrust-pc-btn-handler", "button#onetrust-pc-btn-handler"],
        "save_selectors": ["#onetrust-confirm-btn-handler"],
        "iframe_selectors": ["iframe[src*='onetrust' i]", "iframe[id*='onetrust' i]"],
    },
    "cookiebot": {
        "container_selectors": ["#CybotCookiebotDialog"],
        "reject_selectors": ["#CybotCookiebotDialogBodyButtonDecline", "a#CybotCookiebotDialogBodyButtonDecline"],
        "settings_selectors": ["#CybotCookiebotDialogBodyButtonDetails", "a#CybotCookiebotDialogBodyButtonDetails"],
        "save_selectors": ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection"],
        "iframe_selectors": ["iframe[src*='cookiebot' i]", "iframe[id*='CybotCookiebotDialog' i]"],
    },
    "didomi": {
        "container_selectors": ["#didomi-popup", ".didomi-popup-view"],
        "reject_selectors": ["#didomi-notice-disagree-button"],
        "settings_selectors": ["#didomi-notice-learn-more-button"],
        "save_selectors": ["#didomi-save-button", "[data-testid='didomi-save-button']"],
        "iframe_selectors": ["iframe[src*='didomi' i]"],
    },
    "quantcast": {
        "container_selectors": [".qc-cmp2-container", ".qc-cmp2-summary-section"],
        "reject_selectors": [".qc-cmp2-summary-buttons button:first-child"],
        "settings_selectors": [".qc-cmp2-link", ".qc-cmp2-footer-links button"],
        "save_selectors": [".qc-cmp2-footer button:last-child", ".qc-cmp2-save-and-exit"],
        "iframe_selectors": ["iframe[src*='quantcast' i]", "iframe[src*='cmp2' i]"],
    },
    "osano": {
        "container_selectors": [".osano-cm-dialog"],
        "reject_selectors": [".osano-cm-deny"],
        "settings_selectors": [".osano-cm-manage"],
        "save_selectors": [".osano-cm-save"],
        "iframe_selectors": ["iframe[src*='osano' i]"],
    },
    "complianz": {
        "container_selectors": [".cmplz-cookiebanner"],
        "reject_selectors": [".cmplz-btn.cmplz-deny"],
        "settings_selectors": [".cmplz-btn.cmplz-view-preferences", ".cmplz-manage-consent"],
        "save_selectors": [".cmplz-btn.cmplz-save-preferences"],
        "iframe_selectors": ["iframe[src*='complianz' i]"],
    },
    "cookieyes": {
        "container_selectors": [".cky-consent-container", ".cky-modal"],
        "reject_selectors": [".cky-btn-reject"],
        "settings_selectors": [".cky-btn-customize"],
        "save_selectors": [".cky-btn-preferences"],
        "iframe_selectors": ["iframe[src*='cookieyes' i]", "iframe[src*='cookie-law-info' i]"],
    },
    "usercentrics": {
        "container_selectors": ["#usercentrics-root", "[data-testid='uc-banner-content']"],
        "reject_selectors": ["[data-testid='uc-deny-all-button']"],
        "settings_selectors": [
            "[data-testid='uc-more-button']",
            "[data-testid='uc-manage-all-button']",
            "[data-testid='uc-manage-options-button']",
        ],
        "save_selectors": ["[data-testid='uc-save-button']"],
        "iframe_selectors": ["iframe[src*='usercentrics' i]"],
    },
    "cookiefirst": {
        "container_selectors": [".fc-consent-root"],
        "reject_selectors": ["[data-cookiefirst-action='reject']", ".fc-cta-do-not-consent"],
        "settings_selectors": ["[data-cookiefirst-action='settings']", ".fc-manage-preferences"],
        "save_selectors": ["[data-cookiefirst-action='save']", ".fc-confirm-choices"],
        "iframe_selectors": ["iframe[src*='cookiefirst' i]"],
    },
    "cookiescript": {
        "container_selectors": ["#cookiescript_injected"],
        "reject_selectors": ["#cookiescript_reject"],
        "settings_selectors": ["#cookiescript_manage"],
        "save_selectors": ["#cookiescript_save"],
        "iframe_selectors": ["iframe[src*='cookiescript' i]"],
    },
}
_CMP_SITE_OVERRIDES: Dict[str, Dict[str, List[str]]] = {
    "amazon.com": {
        "profile_names": ["amazon"],
        "container_selectors": ["#sp-cc"],
        "reject_selectors": ["#sp-cc-rejectall-link"],
        "accept_selectors": ["#sp-cc-accept"],
    },
}

# ── Popup/overlay dismissal selectors ────────────────────────────────────
_POPUP_CLOSE_SELECTORS = [
    "button[aria-label='Close']", "button[aria-label='close']",
    "button[aria-label='Dismiss']", "button[aria-label='dismiss']",
    "button[aria-label='Close dialog']", "button[aria-label='Close modal']",
    "[aria-label='Close' i]",
    "[aria-label='Dismiss' i]",
    "[data-dismiss='modal']", "[data-bs-dismiss='modal']",
    "[data-testid='modal-close-button']", "[data-testid='close-button']",
    "[data-testid='closeButton']",
    "[data-action='close']",
    "[role='dialog'] [data-close]",
    "[aria-modal='true'] [data-close]",
    ".modal__close", ".modal-close", ".popup-close", ".overlay-close",
    ".dialog-close", "button[class*='CloseButton']", "button[class*='closeButton']",
    "button[class*='close-btn']", "button[class*='closeBtn']",
    "[class*='modal'] [class*='close']", "[class*='popup'] [class*='close']",
    ".bx-close", ".pf-content-btn-close", "#exit-intent-close",
    ".yotpo-modal .close",
    "[class*='attentive'] button[class*='close']",
    "#attentive_overlay [class*='close']",
    ".klaviyo-close-form",
    ".klaviyo-modal__close",
    "[class*='klaviyo'] [class*='close']",
    ".privy-popup-close", "#privy-popup button[class*='close']",
    ".pum-close", ".modal__close-button", "button[class*='Modal__Close']",
    ".justuno-close", "[class*='justuno'] [class*='close']",
    ".wisepops-close", "[class*='wisepops'] button",
    ".sumo-close-icon",
    ".hustle-button-close",
    ".popup-close-button",
    ".overlay__close",
    ".lightbox-close",
    "button[class*='icon-close']",
    "button[class*='btn-close']",
    ".btn-close",
]
_POPUP_CONTAINER_SELECTORS = [
    '[role="dialog"][aria-modal="true"]', '[role="dialog"]', '[aria-modal="true"]',
    ".modal:not(.cookie-modal)", ".modal-overlay",
    "[class*='modal']:not([class*='cookie'])",
    "[class*='Popup']:not([class*='cookie'])",
    "[class*='popup']:not([class*='cookie'])",
    "[class*='overlay']:not([class*='cookie']):not([class*='product'])",
    "[class*='email-signup']", "[class*='newsletter']", "[class*='subscribe']",
    "#attentive_overlay", ".attentive-creative", "#klaviyo-modal", ".klaviyo-form",
    ".privy-popup", "#privy-popup", ".optinmonster-optin", ".pum-container",
    "[id*='popup']:not([id*='cookie'])", "[id*='modal']:not([id*='cookie'])",
    ".justuno-overlay", "[class*='justuno']",
    ".wisepops-overlay",
    ".hustle-popup",
    ".sumo-overlay",
    "[class*='exit-intent']",
    "[class*='exitIntent']",
    "[class*='lead-capture']",
    "[class*='signup-modal']",
    "[class*='newsletter-modal']",
    "[class*='promo-modal']",
    "[class*='announcement-bar']",
    "[class*='spin-wheel']",
    "[class*='wheel-popup']",
    "[class*='age-gate']",
    "[class*='age-verification']",
]
_POPUP_CLOSE_TEXTS = [
    "no thanks", "no, thanks", "no thank you", "no, thank you",
    "maybe later", "not now", "not interested", "skip", "skip for now",
    "i'll pass", "i don't want", "no, i don't want", "continue without",
    "continue without offer", "continue without subscribing",
    "continue shopping", "close", "dismiss", "×", "✕", "✖",
    "no, i'm good", "no deal", "i'll pay full price",
    "continue to site", "go to site", "enter site",
    "remind me later", "don't show again",
    "i'm not interested", "just browsing", "proceed",
]
# These popup texts must always use exact matching to avoid false positives
# on partial substring hits (e.g. "close" matching "disclosure")
_POPUP_CLOSE_TEXTS_EXACT = {"close", "dismiss", "skip", "proceed", "×", "✕", "✖"}
_SITE_POPUP_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "amazon.com": {
        "close_selectors": [
            "#nav-main .nav-signin-tooltip .nav-action-signin-button + a",
            ".a-popover-header .a-button-close",
            "#aha-popover-close",
            "#all-offers-display-close",
            "#all-offers-display .a-button-close",
        ],
        "force_hide_selectors": ["#all-offers-display"],
        "close_texts": ["dismiss", "not now"],
    },
    "target.com": {
        "close_selectors": [
            "[data-test='storeId-modal-close']",
            "[data-test='@web/ZipCodeModal/CloseButton']",
            "button[data-test='modal-drawer-close-button']",
        ],
    },
    "walmart.com": {
        "close_selectors": [
            "[data-testid='zipcode-modal-close-btn']",
            "button[aria-label='close zip code tooltip']",
            "[class*='LocationFlyout'] button[class*='close']",
        ],
    },
    "bestbuy.com": {
        "close_selectors": [
            ".location-modal .c-close-icon",
            "[data-testid='location-update-modal'] button[class*='close']",
        ],
    },
    "homedepot.com": {
        "close_selectors": [
            ".thd-overlay__close",
            "#thd-overlay__close",
        ],
    },
    "sephora.com": {
        "close_selectors": [
            "[data-comp='Modal'] [data-comp='CloseButton']",
            "[data-at='modal_close']",
        ],
    },
    "nordstrom.com": {
        "close_selectors": [
            "[class*='ModalOverlay'] button[aria-label]",
        ],
    },
    "32degrees.com": {
        "close_selectors": [
            "#attentive_overlay [class*='close']",
            "button[aria-label*='Dismiss' i]",
        ],
        "force_hide_selectors": ["#attentive_overlay"],
    },
}
CHROME_CDP_URL = os.getenv("CHROME_CDP_URL", "http://localhost:9222")
_CDP_HEALTH_CACHE: Dict[str, Any] = {
    "value": None,
    "checked_at": 0.0,
    "forced_unhealthy_until": 0.0,
    "ws_endpoint": None,
    "headers": {},
}
_CDP_HEALTH_LOCK = threading.Lock()
_CDP_BROWSER_LOCK = threading.Lock()
_CDP_PLAYWRIGHT: Optional[Any] = None
_CDP_BROWSER: Optional[Any] = None

# ── Per-domain CAPTCHA cooldown ──────────────────────────────────────────
# When a domain triggers CAPTCHA, we stop hitting it via CDP for a cooldown
# period to let the block expire. Maps domain -> timestamp when cooldown ends.
_CAPTCHA_COOLDOWN: Dict[str, float] = {}
_CAPTCHA_COOLDOWN_LOCK = threading.Lock()
CAPTCHA_COOLDOWN_SECONDS = float(os.getenv("CAPTCHA_COOLDOWN_SECONDS", "1800"))


def _mark_domain_captcha_blocked(domain: str, cooldown_seconds: Optional[float] = None) -> None:
    """Mark a domain as CAPTCHA-blocked. CDP scraping will be skipped until cooldown expires."""
    cd = cooldown_seconds if cooldown_seconds is not None else CAPTCHA_COOLDOWN_SECONDS
    with _CAPTCHA_COOLDOWN_LOCK:
        _CAPTCHA_COOLDOWN[domain] = time.time() + cd
        logger.warning(
            "Domain '%s' marked as CAPTCHA-blocked for %.0f seconds (until %s)",
            domain,
            cd,
            datetime.datetime.fromtimestamp(time.time() + cd).strftime("%H:%M:%S"),
        )


def _is_domain_captcha_blocked(domain: str) -> bool:
    """Check if a domain is still in CAPTCHA cooldown."""
    with _CAPTCHA_COOLDOWN_LOCK:
        expires = _CAPTCHA_COOLDOWN.get(domain, 0.0)
        if time.time() < expires:
            remaining = expires - time.time()
            logger.info("Domain '%s' is CAPTCHA-blocked for %.0f more seconds", domain, remaining)
            return True
        _CAPTCHA_COOLDOWN.pop(domain, None)
        return False


def _get_captcha_cooldown_remaining(domain: str) -> float:
    """Return seconds remaining in cooldown, or 0 if not blocked."""
    with _CAPTCHA_COOLDOWN_LOCK:
        expires = _CAPTCHA_COOLDOWN.get(domain, 0.0)
        remaining = expires - time.time()
        return max(0.0, remaining)


def _mark_cdp_unhealthy(cooldown_seconds: float = 90.0) -> None:
    with _CDP_HEALTH_LOCK:
        now = time.time()
        forced_until = now + max(0.0, float(cooldown_seconds))
        _CDP_HEALTH_CACHE["value"] = False
        _CDP_HEALTH_CACHE["checked_at"] = now
        _CDP_HEALTH_CACHE["ws_endpoint"] = None
        _CDP_HEALTH_CACHE["headers"] = {}
        _CDP_HEALTH_CACHE["forced_unhealthy_until"] = max(
            forced_until,
            float(_CDP_HEALTH_CACHE.get("forced_unhealthy_until") or 0.0),
        )


def _cdp_host_needs_override(hostname: Optional[str]) -> bool:
    host = (hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        # Docker service names (e.g. "chrome") are rejected by Chrome CDP HTTP host checks.
        return True


def _cdp_request_headers(endpoint_url: str) -> Dict[str, str]:
    parsed = urlparse(endpoint_url)
    if _cdp_host_needs_override(parsed.hostname):
        return {"Host": "localhost"}
    return {}


def _resolve_cdp_ws_endpoint(endpoint_url: str, timeout_seconds: float = 5.0) -> Tuple[Optional[str], Dict[str, str]]:
    """Resolve a websocket CDP endpoint, rewriting host/port to match the configured endpoint."""
    raw = (endpoint_url or "").strip()
    if not raw:
        return None, {}

    parsed = urlparse(raw)
    headers = _cdp_request_headers(raw)

    if parsed.scheme in {"ws", "wss"}:
        return raw, headers

    if parsed.scheme not in {"http", "https"}:
        return None, headers

    base = raw.rstrip("/")
    version_url = f"{base}/json/version"

    try:
        resp = httpx.get(version_url, timeout=timeout_seconds, headers=headers or None)
        if resp.status_code >= 400:
            return None, headers
        payload = resp.json()
        ws_url = payload.get("webSocketDebuggerUrl")
        if not isinstance(ws_url, str) or not ws_url.startswith(("ws://", "wss://")):
            return None, headers

        ws_parsed = urlparse(ws_url)
        query = f"?{ws_parsed.query}" if ws_parsed.query else ""
        target_scheme = "wss" if parsed.scheme == "https" else "ws"

        # Keep the discovered browser session path, but force host/port to configured endpoint.
        rewritten = f"{target_scheme}://{parsed.netloc}{ws_parsed.path}{query}"
        return rewritten, headers
    except Exception as exc:
        logger.warning("Failed to resolve CDP websocket endpoint from '%s': %s", version_url, exc)
        return None, headers


def _cdp_endpoint_healthy(ttl_seconds: float = 15.0) -> bool:
    """Best-effort health probe for CDP endpoint before treating failures as UI changes."""
    now = time.time()
    with _CDP_HEALTH_LOCK:
        forced_unhealthy_until = float(_CDP_HEALTH_CACHE.get("forced_unhealthy_until") or 0.0)
        if forced_unhealthy_until > now:
            _CDP_HEALTH_CACHE["value"] = False
            _CDP_HEALTH_CACHE["checked_at"] = now
            _CDP_HEALTH_CACHE["ws_endpoint"] = None
            _CDP_HEALTH_CACHE["headers"] = {}
            return False

        cached_value = _CDP_HEALTH_CACHE.get("value")
        checked_at = float(_CDP_HEALTH_CACHE.get("checked_at") or 0.0)
        if cached_value is not None and now - checked_at <= ttl_seconds:
            return bool(cached_value)

    raw = (CHROME_CDP_URL or "").strip()
    if not raw:
        with _CDP_HEALTH_LOCK:
            _CDP_HEALTH_CACHE["value"] = False
            _CDP_HEALTH_CACHE["checked_at"] = now
            _CDP_HEALTH_CACHE["ws_endpoint"] = None
            _CDP_HEALTH_CACHE["headers"] = {}
        return False
    ws_endpoint, headers = _resolve_cdp_ws_endpoint(raw, timeout_seconds=5.0)
    healthy = bool(ws_endpoint)
    with _CDP_HEALTH_LOCK:
        _CDP_HEALTH_CACHE["value"] = healthy
        _CDP_HEALTH_CACHE["checked_at"] = now
        _CDP_HEALTH_CACHE["ws_endpoint"] = ws_endpoint if healthy else None
        _CDP_HEALTH_CACHE["headers"] = headers if healthy else {}
        if healthy:
            _CDP_HEALTH_CACHE["forced_unhealthy_until"] = 0.0
    return healthy


def _get_cached_cdp_endpoint() -> Optional[Tuple[str, Dict[str, str]]]:
    with _CDP_HEALTH_LOCK:
        now = time.time()
        forced_unhealthy_until = float(_CDP_HEALTH_CACHE.get("forced_unhealthy_until") or 0.0)
        if forced_unhealthy_until > now or not _CDP_HEALTH_CACHE.get("value"):
            return None
        ws_endpoint = _CDP_HEALTH_CACHE.get("ws_endpoint")
        if not isinstance(ws_endpoint, str) or not ws_endpoint:
            return None
        headers = _CDP_HEALTH_CACHE.get("headers")
        if not isinstance(headers, dict):
            headers = {}
        return ws_endpoint, dict(headers)


def _parse_proxy_url(proxy_url: str) -> Optional[dict]:
    """Parse a proxy URL into Playwright's proxy config format."""
    raw = (proxy_url or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if not parsed.hostname or not parsed.port:
        return None
    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
    if parsed.password:
        config["password"] = parsed.password
    return config


def _get_cdp_proxy_list() -> List[Optional[dict]]:
    """Return ordered list of proxy configs to try."""
    proxies = []
    primary = _parse_proxy_url(CDP_PROXY_PRIMARY_URL)
    if primary:
        proxies.append(primary)
    fallback = _parse_proxy_url(CDP_PROXY_FALLBACK_URL)
    if fallback:
        proxies.append(fallback)
    proxies.append(None)
    return proxies


def _get_cdp_browser():
    """
    Persistent CDP browser singleton — NOT currently used by _scrape_with_chrome_cdp().

    Reserved for Azure multi-container deployment where Chrome runs as a separate
    service and a long-lived shared connection (instead of per-request connections)
    reduces overhead. When migrating:
      1. Replace per-request pw/browser creation in _scrape_with_chrome_cdp with
         calls to _get_cdp_browser()
      2. Add reconnect-on-failure between is_connected() check and new_context()
      3. Add connection health validation before returning cached browser

    See also: _CDP_PLAYWRIGHT, _CDP_BROWSER, _CDP_BROWSER_LOCK
    """
    global _CDP_PLAYWRIGHT, _CDP_BROWSER

    with _CDP_BROWSER_LOCK:
        try:
            if _CDP_BROWSER is not None and _CDP_BROWSER.is_connected():
                # Validate connection is actually usable, not just "connected"
                # by checking we can still list contexts. This catches stale WS connections.
                try:
                    _ = _CDP_BROWSER.contexts
                except Exception:
                    logger.warning("CDP browser reports connected but contexts unreachable — reconnecting")
                    try:
                        _CDP_BROWSER.close()
                    except Exception:
                        pass
                    _CDP_BROWSER = None
                    # Fall through to reconnection below
                else:
                    return _CDP_BROWSER
        except Exception as exc:
            logger.warning("Failed to validate cached CDP browser connection: %s", exc)
            try:
                if _CDP_BROWSER is not None:
                    _CDP_BROWSER.close()
            except Exception:
                pass
            _CDP_BROWSER = None

        if _CDP_PLAYWRIGHT is None:
            try:
                _CDP_PLAYWRIGHT = sync_playwright().start()
            except Exception as exc:
                logger.warning("Playwright init failed: %s", exc)
                _CDP_PLAYWRIGHT = None
                _mark_cdp_unhealthy(120.0)
                return None

        try:
            cached_endpoint = _get_cached_cdp_endpoint()
            if cached_endpoint:
                cdp_endpoint, cdp_headers = cached_endpoint
            else:
                cdp_endpoint, cdp_headers = _resolve_cdp_ws_endpoint(CHROME_CDP_URL, timeout_seconds=8.0)
            if not cdp_endpoint:
                logger.warning("CDP endpoint resolution failed for %s", CHROME_CDP_URL)
                _mark_cdp_unhealthy(120.0)
                return None

            connect_kwargs: Dict[str, Any] = {}
            if cdp_headers:
                connect_kwargs["headers"] = cdp_headers

            _CDP_BROWSER = _CDP_PLAYWRIGHT.chromium.connect_over_cdp(cdp_endpoint, **connect_kwargs)
            return _CDP_BROWSER
        except Exception as exc:
            logger.warning("Chrome CDP connect failed: %s", exc)
            _mark_cdp_unhealthy(120.0)
            _CDP_BROWSER = None
            if _CDP_PLAYWRIGHT is not None:
                try:
                    _CDP_PLAYWRIGHT.stop()
                except Exception as exc:
                    logger.debug("Failed to stop Playwright after CDP connect failure: %s", exc)
                _CDP_PLAYWRIGHT = None
            return None

# ── Shared click utilities ────────────────────────────────────────────────

_POPUP_SUPPRESSION_CSS = """
.optinmonster-optin,
.hustle-popup,
.sumo-overlay,
[class*='wisepops'],
[class*='justuno'],
[class*='spin-wheel'],
[class*='exit-intent'],
[class*='exitIntent'],
[id*='exitIntent'],
[class*='lead-capture'],
[class*='email-capture'] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}
"""

_POPUP_PREVENTION_JS = r"""
(() => {
    window.__originalOpen = window.open;
    window.open = function() { return null; };
    if (window.Notification) {
        window.Notification.requestPermission = () => Promise.resolve('denied');
    }
    window.__origAlert = window.alert;
    window.alert = function() {};
    window.__origConfirm = window.confirm;
    window.confirm = function() { return false; };
    window.__origPrompt = window.prompt;
    window.prompt = function() { return null; };

    const style = document.createElement('style');
    style.id = '__popup_guard_css';
    style.textContent = `""" + _POPUP_SUPPRESSION_CSS.replace('`', r'\`') + r"""`;
    (document.head || document.documentElement).appendChild(style);

    const CLOSE_ARIA = ['close', 'dismiss', 'close dialog', 'close modal'];
    const CLOSE_CLASSES = ['close', 'dismiss', 'popup-close', 'modal-close',
                           'overlay-close', 'btn-close', 'pum-close'];
    const COOKIE_INDICATORS = ['cookie', 'consent', 'privacy', 'gdpr',
                               'onetrust', 'didomi', 'cybot', 'usercentrics',
                               'cookiefirst', 'osano'];
    const POPUP_INDICATORS = ['popup', 'modal', 'overlay', 'dialog',
                              'newsletter', 'subscribe', 'email-signup',
                              'exit-intent', 'lead-capture', 'signup',
                              'promo', 'campaign', 'offer', 'lightbox',
                              'klaviyo', 'attentive', 'privy', 'justuno',
                              'wisepop', 'optinmonster', 'sumo'];

    function isPopupContainer(el) {
        if (!el || !el.tagName) return false;

        // Cookie/consent check MUST run first — before role="dialog" check.
        // CMPs (OneTrust, Cookiebot, Didomi) use role="dialog" on cookie banners.
        // Without this guard, the MutationObserver auto-clicks the X button on cookie
        // banners (= accept all), racing with the Python-side reject flow.
        const cls = (el.className || '').toString().toLowerCase();
        const id = (el.id || '').toLowerCase();
        const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
            .toLowerCase().slice(0, 240);
        const combined = cls + ' ' + id;
        if (COOKIE_INDICATORS.some(kw => combined.includes(kw) || text.includes(kw))) return false;

        const role = (el.getAttribute('role') || '').toLowerCase();
        const ariaModal = el.getAttribute('aria-modal');
        if (role === 'dialog' || ariaModal === 'true') return true;

        if (POPUP_INDICATORS.some(kw => combined.includes(kw))) {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 200 && rect.height >= 200) return true;
        }

        const elStyle = window.getComputedStyle(el);
        const z = parseInt(elStyle.zIndex, 10);
        const pos = elStyle.position;
        if (z >= 1000 && (pos === 'fixed' || pos === 'absolute')) {
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (rect.width > vw * 0.3 && rect.height > vh * 0.3) return true;
            if (el.querySelector('input[type="email"], input[placeholder*="email" i]')) return true;
        }

        return false;
    }

    function findCloseButton(container) {
        for (const label of CLOSE_ARIA) {
            const btn = container.querySelector(`[aria-label="${label}" i], button[aria-label="${label}" i]`);
            if (btn && btn.offsetParent !== null) return btn;
        }
        for (const cls of CLOSE_CLASSES) {
            const btn = container.querySelector(`[class*="${cls}"], .${cls}`);
            if (btn && btn.offsetParent !== null) return btn;
        }
        const dataDismiss = container.querySelector('[data-dismiss="modal"], [data-bs-dismiss="modal"], [data-action="close"], [data-close]');
        if (dataDismiss && dataDismiss.offsetParent !== null) return dataDismiss;

        const allClickable = container.querySelectorAll('button, a, span[role="button"], div[role="button"], [onclick]');
        for (const el of allClickable) {
            const text = el.textContent.trim();
            if (['×', '✕', '✖', 'X', '✗', '\u{1F5D9}', ''].includes(text)) {
                if (el.querySelector('svg') || el.querySelector('img') || text.length <= 1 || text === '') {
                    if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
                }
            }
        }

        const containerRect = container.getBoundingClientRect();
        for (const el of allClickable) {
            const r = el.getBoundingClientRect();
            if (r.width < 60 && r.height < 60 && r.width > 8 && r.height > 8) {
                const relX = r.left - containerRect.left;
                const relY = r.top - containerRect.top;
                if (relX > containerRect.width * 0.6 && relY < containerRect.height * 0.25) {
                    if (el.offsetParent !== null) return el;
                }
            }
        }

        return null;
    }

    let lastDismissTime = 0;
    function tryAutoDismiss(el) {
        const now = Date.now();
        if (now - lastDismissTime < 2000) return;
        if (!isPopupContainer(el)) return;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const closeBtn = findCloseButton(el);
        if (closeBtn) {
            lastDismissTime = now;
            setTimeout(() => { try { closeBtn.click(); } catch(e) {} }, 300 + Math.random() * 400);
        }
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                tryAutoDismiss(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll('[role="dialog"], [aria-modal="true"]').forEach(d => tryAutoDismiss(d));
                }
            }
            if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
                tryAutoDismiss(mutation.target);
            }
        }
    });
    observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'aria-hidden'],
    });
    window.__popupGuardObserver = observer;

    let periodicDismissCount = 0;
    const MAX_PERIODIC = 5;
    const periodicInterval = setInterval(() => {
        if (periodicDismissCount >= MAX_PERIODIC) {
            clearInterval(periodicInterval);
            return;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const candidates = document.querySelectorAll('div, section, aside, form, [role="dialog"], [aria-modal="true"]');
        for (const el of candidates) {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
            const z = parseInt(s.zIndex, 10);
            if (isNaN(z) || z < 500) continue;
            const pos = s.position;
            if (pos !== 'fixed' && pos !== 'absolute') continue;
            const r = el.getBoundingClientRect();
            const isLarge = r.width > vw * 0.3 && r.height > vh * 0.3;
            const hasEmail = el.querySelector('input[type="email"], input[placeholder*="email" i]');
            if (!isLarge && !hasEmail) continue;
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
                .toLowerCase().slice(0, 200);
            if (['product', 'gallery', 'carousel', 'header', 'nav', 'footer', 'cart']
                .some(skip => cls.includes(skip) || id.includes(skip))) continue;
            if (COOKIE_INDICATORS.some(skip => cls.includes(skip) || id.includes(skip) || text.includes(skip))) continue;
            const closeBtn = findCloseButton(el);
            if (closeBtn) {
                try { closeBtn.click(); } catch(e) {}
                periodicDismissCount++;
                break;
            } else {
                // Check if body scroll was locked (likely by this popup) before hiding
                const bodyStyle = window.getComputedStyle(document.body);
                const wasScrollLocked = bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden'
                    || document.body.classList.contains('modal-open')
                    || document.body.classList.contains('overflow-hidden')
                    || document.body.classList.contains('no-scroll');
                el.style.display = 'none';
                el.style.visibility = 'hidden';
                el.style.pointerEvents = 'none';
                if (wasScrollLocked) {
                    document.body.style.overflow = '';
                    document.body.classList.remove('modal-open', 'overflow-hidden', 'no-scroll');
                }
                periodicDismissCount++;
                break;
            }
        }
    }, 2000);
    window.__popupGuardInterval = periodicInterval;
})();
"""


def inject_popup_prevention(page) -> None:
    """Call BEFORE page.goto(). Blocks popups proactively via init script."""
    try:
        page.add_init_script(_POPUP_PREVENTION_JS)
        logger.info("Popup prevention JS injected")
    except Exception as exc:
        logger.warning("Failed to inject popup prevention script: %s", exc)


_SHADOW_DOM_CLOSE_JS = """
(() => {
    function walkShadow(root) {
        const found = [];
        const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while (node = treeWalker.nextNode()) {
            if (node.shadowRoot) found.push(...walkShadow(node.shadowRoot));
            const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
            const className = (node.className || '').toString().toLowerCase();
            if (['close', 'dismiss', 'close dialog', 'close modal'].some(l => ariaLabel.includes(l)) ||
                ['close', 'dismiss', 'popup-close', 'modal-close'].some(c => className.includes(c))) {
                if (node.offsetParent !== null || node.getClientRects().length > 0) found.push(node);
            }
        }
        return found;
    }
    const buttons = walkShadow(document);
    for (const btn of buttons) {
        try { btn.click(); return true; } catch(e) {}
    }
    return false;
})();
"""

_DETECT_BLOCKING_OVERLAY_JS = """
(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = document.querySelectorAll('div, section, aside, [role="dialog"]');
    const results = [];
    const consentWords = ['cookie', 'consent', 'privacy', 'gdpr', 'onetrust', 'didomi', 'usercentrics', 'cookiefirst', 'cybot', 'osano', 'cookiebot', 'tarteaucitron', 'cookiescript', 'complianz', 'cookieyes'];
    const signupWords = ['newsletter', 'subscribe', 'email', 'offer', 'discount', 'promo', 'save'];
    for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const zIndex = parseInt(style.zIndex, 10);
        if (isNaN(zIndex) || zIndex < 500) continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const pos = style.position;
        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < vw * 0.4 || rect.height < vh * 0.4) continue;
        const cls = (el.className || '').toString().toLowerCase();
        const id = (el.id || '').toLowerCase();
        if (['product', 'gallery', 'carousel', 'slider', 'header', 'nav', 'footer']
            .some(skip => cls.includes(skip) || id.includes(skip))) continue;
        const textSnippet = ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 220);
        const lowerText = textSnippet.toLowerCase();
        const hasEmailInput = !!el.querySelector('input[type="email"], input[placeholder*="email" i]');
        const hasFormFields = !!el.querySelector('input, select, textarea');
        const hasCloseCandidate = !!el.querySelector(
            "button[aria-label*='close' i], button[aria-label*='dismiss' i], [class*='close'], [data-dismiss], .btn-close, button:has(svg)"
        );
        const hasConsentWords = consentWords.some(word => cls.includes(word) || id.includes(word) || lowerText.includes(word));
        const hasSignupWords = signupWords.some(word => cls.includes(word) || id.includes(word) || lowerText.includes(word));
        const role = (el.getAttribute('role') || '').toLowerCase();
        const ariaModal = (el.getAttribute('aria-modal') || '').toLowerCase();
        if (!(hasCloseCandidate || hasEmailInput || hasFormFields || hasConsentWords || hasSignupWords || role === 'dialog' || ariaModal === 'true')) {
            continue;
        }
        let guardId = el.getAttribute('data-popup-guard-id');
        if (!guardId) {
            guardId = `popup-guard-${Date.now()}-${results.length + 1}`;
            el.setAttribute('data-popup-guard-id', guardId);
        }
        results.push({
            selector: `[data-popup-guard-id="${guardId}"]`,
            tagName: el.tagName,
            id: el.id,
            className: el.className?.toString?.() || '',
            zIndex: zIndex,
            width: rect.width,
            height: rect.height,
            hasEmailInput,
            hasFormFields,
            hasCloseCandidate,
            hasConsentWords,
            hasSignupWords,
            role,
            ariaModal,
            textSnippet,
            htmlSnippet: (el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 260),
        });
    }
    return results;
})();
"""

_REMOVE_OVERLAY_JS = """
(selector) => {
    const el = document.querySelector(selector);
    if (el) {
        el.style.display = 'none';
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        el.style.opacity = '0';
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.documentElement.style.overflow = '';
        return true;
    }
    return false;
}
"""

_SCROLL_LOCK_CLEANUP_JS = f"""
() => {{
    const body = document.body;
    const html = document.documentElement;
    if (!body || !html) return {{restored: false, targetY: 0}};

    const currentY = window.scrollY || window.pageYOffset || 0;
    const computed = window.getComputedStyle(body);
    const rawTop = body.style.top || computed.top || '';
    let targetY = currentY;
    const parsedTop = parseFloat(rawTop);
    if ((body.style.position === 'fixed' || computed.position === 'fixed') && !Number.isNaN(parsedTop) && parsedTop < 0) {{
        targetY = Math.abs(parsedTop);
    }}

    body.style.overflow = '';
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.touchAction = '';
    html.style.overflow = '';
    html.style.position = '';
    html.style.top = '';
    html.style.height = '';
    html.style.width = '';

    body.classList.remove({json.dumps(list(_SCROLL_LOCK_CLASSES)).replace('"', "'")[1:-1]});
    html.classList.remove({json.dumps(list(_SCROLL_LOCK_CLASSES)).replace('"', "'")[1:-1]});

    try {{
        window.scrollTo({{ top: targetY, left: 0, behavior: 'instant' }});
    }} catch (e) {{
        try {{ window.scrollTo(0, targetY); }} catch (_) {{}}
    }}

    return {{restored: true, targetY}};
}}
"""


def _get_domain(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host

def _try_click(page, selector: str, timeout_ms: int = 1200) -> bool:
    try:
        loc = page.locator(selector).first
        if loc.is_visible(timeout=timeout_ms):
            try:
                loc.click(timeout=timeout_ms)
            except Exception:
                loc.click(timeout=timeout_ms, force=True)
            time.sleep(random.uniform(0.25, 0.55))
            return True
    except Exception:
        pass
    return False


def _try_click_by_text(page, text: str, timeout_ms: int = 1200, force_exact: bool = False) -> bool:
    """Try button -> link -> xpath. Uses exact match for short texts to avoid false positives."""
    # Short texts (1-3 chars like "×", "✕", "ok") must match exactly,
    # otherwise "x" matches "English", "Extras", etc.
    use_exact = len(text) <= 3 or force_exact

    for role in ("button", "link"):
        try:
            loc = page.get_by_role(role, name=text, exact=use_exact)
            if loc.count() > 0 and loc.first.is_visible(timeout=timeout_ms):
                try:
                    loc.first.click(timeout=timeout_ms)
                except Exception:
                    loc.first.click(timeout=timeout_ms, force=True)
                time.sleep(random.uniform(0.25, 0.55))
                return True
        except Exception:
            pass

    # XPath fallback — skip entirely for very short texts (too many false positives)
    if len(text) <= 3 or force_exact:
        return False

    t = text.lower()
    upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    lower_str = "abcdefghijklmnopqrstuvwxyz"
    xpath_prefix = ".//" if isinstance(page, Locator) else "//"
    xpath = (
        f"{xpath_prefix}button[contains(translate(normalize-space(.), '{upper}', '{lower_str}'), '{t}')] "
        f"| {xpath_prefix}a[contains(translate(normalize-space(.), '{upper}', '{lower_str}'), '{t}')] "
        f"| {xpath_prefix}span[@role='button'][contains(translate(normalize-space(.), '{upper}', '{lower_str}'), '{t}')] "
        f"| {xpath_prefix}div[@role='button'][contains(translate(normalize-space(.), '{upper}', '{lower_str}'), '{t}')]"
    )
    try:
        loc = page.locator(f"xpath={xpath}")
        if loc.count() > 0 and loc.first.is_visible(timeout=timeout_ms):
            try:
                loc.first.click(timeout=timeout_ms)
            except Exception:
                loc.first.click(timeout=timeout_ms, force=True)
            time.sleep(random.uniform(0.25, 0.55))
            return True
    except Exception:
        pass
    return False


def _click_first_match(page, selectors: list, timeout_ms: int = 1200, label: str = "") -> Optional[str]:
    for sel in selectors:
        if _try_click(page, sel, timeout_ms=timeout_ms):
            if label:
                logger.info("%s dismissed via selector: %s", label, sel)
            return sel
    return None


def _click_first_text_match(
    page,
    texts: list,
    timeout_ms: int = 1200,
    label: str = "",
    force_exact_texts: Optional[set] = None,
) -> Optional[str]:
    for text in texts:
        is_exact = bool(force_exact_texts and text.lower() in force_exact_texts)
        if _try_click_by_text(page, text, timeout_ms=timeout_ms, force_exact=is_exact):
            if label:
                logger.info("%s dismissed via text match: '%s'", label, text)
            return text
    return None


def _merge_unique_strings(*groups) -> List[str]:
    merged: List[str] = []
    seen = set()
    for group in groups:
        for item in group or []:
            if not item or item in seen:
                continue
            seen.add(item)
            merged.append(item)
    return merged


def _record_attempt(attempted_actions: List[str], action: str) -> None:
    if action and action not in attempted_actions:
        attempted_actions.append(action)


def _clear_scroll_locks(page, reason: str = "") -> None:
    try:
        result = page.evaluate(_SCROLL_LOCK_CLEANUP_JS)
        if reason and isinstance(result, dict) and result.get("restored"):
            logger.info("Cleared scroll locks after %s", reason)
    except Exception as exc:
        logger.debug("Scroll-lock cleanup failed after %s: %s", reason or "dismissal", exc)


def _locator_debug_snapshot(locator) -> Optional[Dict[str, Any]]:
    try:
        return locator.evaluate(
            """(el) => ({
                tagName: el.tagName || '',
                id: el.id || '',
                className: (el.className || '').toString(),
                role: el.getAttribute('role') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                textSnippet: ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 220),
                htmlSnippet: (el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 260),
            })"""
        )
    except Exception:
        return None


def _collect_top_blocker_metadata(page, *, prefer_cookie: bool = False) -> Optional[Dict[str, Any]]:
    try:
        return page.evaluate(
            """(preferCookie) => {
                const els = document.querySelectorAll('div, section, aside, form, iframe, [role="dialog"], [aria-modal="true"]');
                const cookieWords = ['cookie', 'consent', 'privacy', 'gdpr', 'onetrust', 'didomi', 'usercentrics'];
                const popupWords = ['popup', 'modal', 'overlay', 'newsletter', 'subscribe', 'offer', 'discount'];
                let best = null;
                let bestScore = -1;
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 180 || rect.height < 80) continue;
                    const z = parseInt(style.zIndex, 10);
                    const cls = (el.className || '').toString().toLowerCase();
                    const id = (el.id || '').toLowerCase();
                    const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
                        .replace(/\\s+/g, ' ').trim().toLowerCase().slice(0, 300);
                    const isCookie = cookieWords.some(word => cls.includes(word) || id.includes(word) || text.includes(word));
                    const isPopup = popupWords.some(word => cls.includes(word) || id.includes(word) || text.includes(word));
                    if (preferCookie && !isCookie) continue;
                    if (!preferCookie && !(isCookie || isPopup || z >= 500)) continue;
                    const score = Math.max(z || 0, 0) + (rect.width * rect.height) / 10000 + (isCookie ? 2000 : 0) + (isPopup ? 1000 : 0);
                    if (score <= bestScore) continue;
                    bestScore = score;
                    best = {
                        tagName: el.tagName || '',
                        id: el.id || '',
                        className: (el.className || '').toString(),
                        role: el.getAttribute('role') || '',
                        zIndex: z,
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        textSnippet: text.slice(0, 220),
                        htmlSnippet: (el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 260),
                    };
                }
                return best;
            }""",
            prefer_cookie,
        )
    except Exception:
        return None


def _log_popup_failure_evidence(
    page,
    *,
    url: str = "",
    popup_type: str,
    attempted_actions: Optional[List[str]] = None,
    blocker: Optional[Dict[str, Any]] = None,
) -> None:
    evidence = {
        "url": url,
        "domain": _get_domain(url) if url else "",
        "type": popup_type,
        "attempted_actions": attempted_actions or [],
        "blocker": blocker or _collect_top_blocker_metadata(page, prefer_cookie=popup_type == "cookie"),
    }
    try:
        logger.warning("%s dismissal incomplete: %s", popup_type.capitalize(), json.dumps(evidence, ensure_ascii=True))
    except Exception:
        logger.warning("%s dismissal incomplete for %s", popup_type.capitalize(), url or "unknown-url")


def _visible_locator_text(locator, timeout_ms: int = 600) -> str:
    try:
        if not locator.is_visible(timeout=timeout_ms):
            return ""
        return (locator.inner_text(timeout=timeout_ms) or "").strip()
    except Exception:
        return ""


def _cookie_text_signal(text: str) -> bool:
    lower_text = (text or "").lower()
    if not lower_text:
        return False
    return any(keyword in lower_text for keyword in _COOKIE_BODY_KEYWORDS) or any(
        token in lower_text
        for token in ("cookie", "consent", "privacy", "gdpr", "tracking technologies")
    )


def _cookie_scope_label(scope: Optional[Dict[str, Any]]) -> str:
    if not scope:
        return "cookie-banner"
    source = scope.get("source") or "page"
    profile_name = scope.get("profile_name") or "generic"
    selector = scope.get("selector") or "document"
    return f"Cookie banner ({profile_name}/{source}) [{selector}]"


def _cmp_profile_names_for_domain(domain: str) -> List[str]:
    override = _CMP_SITE_OVERRIDES.get(domain, {})
    return _merge_unique_strings(override.get("profile_names", []), list(_CMP_PROFILES.keys()))


def _cmp_profile_value(domain: str, profile_name: Optional[str], key: str, fallback: Optional[List[str]] = None) -> List[str]:
    override = _CMP_SITE_OVERRIDES.get(domain, {})
    profile = _CMP_PROFILES.get(profile_name or "", {})
    return _merge_unique_strings(
        override.get(key, []),
        profile.get(key, []),
        fallback or [],
    )


def _iter_exact_iframe_targets(page, selector_groups: List[str], max_per_selector: int = 2) -> List[Dict[str, Any]]:
    targets: List[Dict[str, Any]] = []
    seen = set()
    for group in selector_groups:
        for selector in _split_selectors(group):
            if not selector:
                continue
            try:
                iframe_loc = page.locator(selector)
                iframe_count = min(iframe_loc.count(), max_per_selector)
            except Exception:
                continue

            for iframe_idx in range(iframe_count):
                target_loc = iframe_loc.nth(iframe_idx)
                try:
                    if not target_loc.is_visible(timeout=400):
                        continue
                except Exception:
                    continue

                try:
                    target_handle = target_loc.element_handle(timeout=800)
                except Exception:
                    target_handle = None
                if not target_handle:
                    continue

                try:
                    dedupe_key = target_handle.evaluate(
                        """(el) => [
                            el.src || '',
                            el.id || '',
                            (el.className || '').toString(),
                            Math.round(el.getBoundingClientRect().top),
                            Math.round(el.getBoundingClientRect().left)
                        ].join('|')"""
                    )
                except Exception:
                    dedupe_key = f"{selector}:{iframe_idx}"

                if dedupe_key in seen:
                    continue

                try:
                    frame = target_handle.content_frame()
                except Exception:
                    frame = None

                targets.append(
                    {
                        "selector": selector,
                        "locator": target_loc,
                        "handle": target_handle,
                        "frame": frame,
                        "dedupe_key": dedupe_key,
                    }
                )
                seen.add(dedupe_key)
    return targets


def _locate_cookie_container_in_root(root, selector: str, *, profile_name: Optional[str], source: str) -> Optional[Dict[str, Any]]:
    try:
        loc = root.locator(selector)
        count = min(loc.count(), 3)
    except Exception:
        return None

    known_specific = bool(profile_name) or selector in _COOKIE_CONTAINER_SELECTORS[:10]
    for idx in range(count):
        container = loc.nth(idx)
        try:
            if not container.is_visible(timeout=400):
                continue
        except Exception:
            continue

        text = _visible_locator_text(container)
        if not known_specific and not _cookie_text_signal(text):
            snapshot = _locator_debug_snapshot(container) or {}
            combined = " ".join(
                str(snapshot.get(key, "")) for key in ("id", "className", "ariaLabel", "textSnippet")
            )
            if not _cookie_text_signal(combined):
                continue

        return {
            "profile_name": profile_name,
            "root": container,
            "container": container,
            "context": root,
            "selector": selector,
            "source": source,
            "text": text[:220],
        }
    return None


def _find_cookie_banner_scope(page, domain: str = "") -> Optional[Dict[str, Any]]:
    profile_names = _cmp_profile_names_for_domain(domain)
    generic_selectors = _COOKIE_CONTAINER_SELECTORS

    for profile_name in profile_names:
        for selector in _CMP_PROFILES.get(profile_name, {}).get("container_selectors", []):
            scope = _locate_cookie_container_in_root(page, selector, profile_name=profile_name, source="page")
            if scope:
                return scope

    for selector in _CMP_SITE_OVERRIDES.get(domain, {}).get("container_selectors", []):
        scope = _locate_cookie_container_in_root(page, selector, profile_name=None, source="page-site")
        if scope:
            return scope

    for selector in generic_selectors:
        scope = _locate_cookie_container_in_root(page, selector, profile_name=None, source="page-generic")
        if scope:
            return scope

    iframe_selectors = list(_COOKIE_IFRAME_HINT_SELECTORS)
    for profile_name in profile_names:
        iframe_selectors.extend(_CMP_PROFILES.get(profile_name, {}).get("iframe_selectors", []))
    iframe_selectors.extend(_CMP_SITE_OVERRIDES.get(domain, {}).get("iframe_selectors", []))

    for iframe_target in _iter_exact_iframe_targets(page, iframe_selectors, max_per_selector=2):
        frame = iframe_target.get("frame")
        if not frame:
            continue

        for profile_name in profile_names:
            for selector in _CMP_PROFILES.get(profile_name, {}).get("container_selectors", []):
                scope = _locate_cookie_container_in_root(frame, selector, profile_name=profile_name, source="iframe")
                if scope:
                    scope["iframe_target"] = iframe_target
                    return scope

        for selector in generic_selectors:
            scope = _locate_cookie_container_in_root(frame, selector, profile_name=None, source="iframe-generic")
            if scope:
                scope["iframe_target"] = iframe_target
                return scope

        try:
            frame_text = (
                frame.evaluate("() => (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 320)")
                or ""
            )
        except Exception:
            frame_text = ""

        if _cookie_text_signal(frame_text):
            return {
                "profile_name": None,
                "root": frame,
                "container": None,
                "context": frame,
                "selector": iframe_target.get("selector"),
                "source": "iframe-document",
                "text": frame_text[:220],
                "iframe_target": iframe_target,
            }

    return None


def _toggle_off_non_essential_cookie_choices(scope: Dict[str, Any]) -> List[str]:
    container = scope.get("container")
    if not container:
        return []

    try:
        toggled = container.evaluate(
            """(root, cfg) => {
                const nonEssential = cfg.nonEssential;
                const essential = cfg.essential;
                function labelText(el) {
                    const aria = el.getAttribute('aria-label') || '';
                    const labelledBy = el.getAttribute('aria-labelledby');
                    let label = aria;
                    if (!label && labelledBy) {
                        label = labelledBy.split(/\\s+/).map(id => {
                            const node = document.getElementById(id);
                            return node ? node.textContent || '' : '';
                        }).join(' ');
                    }
                    if (!label) {
                        const labelled = el.closest('label');
                        label = labelled ? labelled.textContent || '' : '';
                    }
                    if (!label) {
                        const parent = el.parentElement;
                        label = parent ? parent.textContent || '' : '';
                    }
                    return label.replace(/\\s+/g, ' ').trim().toLowerCase();
                }
                function isOn(el) {
                    if (el.matches('input[type="checkbox"], input[type="radio"]')) return !!el.checked;
                    const ariaChecked = (el.getAttribute('aria-checked') || '').toLowerCase();
                    if (ariaChecked) return ariaChecked === 'true';
                    const ariaPressed = (el.getAttribute('aria-pressed') || '').toLowerCase();
                    if (ariaPressed) return ariaPressed === 'true';
                    return /(active|enabled|checked|selected|on)/i.test((el.className || '').toString());
                }
                const candidates = root.querySelectorAll(
                    "input[type='checkbox'], input[type='radio'], [role='switch'], button[role='switch'], [aria-checked], [aria-pressed]"
                );
                const toggled = [];
                for (const el of candidates) {
                    const text = labelText(el);
                    if (!text) continue;
                    if (!nonEssential.some(word => text.includes(word))) continue;
                    if (essential.some(word => text.includes(word))) continue;
                    if (!isOn(el)) continue;
                    try {
                        el.click();
                        toggled.push(text.slice(0, 80));
                    } catch (e) {}
                    if (toggled.length >= 6) break;
                }
                return toggled;
            }""",
            {"nonEssential": list(_COOKIE_NON_ESSENTIAL_KEYWORDS), "essential": list(_COOKIE_ESSENTIAL_KEYWORDS)},
        )
        return [item for item in toggled or [] if item]
    except Exception:
        return []


def _attempt_click_group(
    root,
    *,
    selectors: Optional[List[str]] = None,
    texts: Optional[List[str]] = None,
    label: str,
    attempted_actions: List[str],
    timeout_ms: int = 1000,
    force_exact_texts: Optional[set] = None,
) -> Optional[str]:
    _record_attempt(attempted_actions, label)
    matched = _click_first_match(root, selectors or [], timeout_ms=timeout_ms, label=label)
    if matched:
        _record_attempt(attempted_actions, f"{label}:selector:{matched}")
        return matched
    matched = _click_first_text_match(
        root,
        texts or [],
        timeout_ms=timeout_ms,
        label=label,
        force_exact_texts=force_exact_texts,
    )
    if matched:
        _record_attempt(attempted_actions, f"{label}:text:{matched}")
        return matched
    return None


def _try_shadow_dom_close(page) -> bool:
    """Attempt to find and click close buttons inside shadow DOM roots."""
    try:
        result = page.evaluate(_SHADOW_DOM_CLOSE_JS)
        if result:
            logger.info("Popup dismissed via shadow DOM close button")
            _clear_scroll_locks(page, reason="shadow DOM popup dismissal")
            time.sleep(random.uniform(0.3, 0.6))
            return True
    except Exception as exc:
        logger.warning("Shadow DOM popup close failed: %s", exc)
    return False


def _detect_and_remove_blocking_overlays(page) -> int:
    """Detect overlays by z-index + viewport coverage, try close button, then force-hide."""
    removed = 0
    try:
        overlays = page.evaluate(_DETECT_BLOCKING_OVERLAY_JS)
    except Exception as exc:
        logger.warning("Overlay detection JS failed: %s", exc)
        return 0
    for overlay in overlays:
        selector = overlay.get("selector", "")
        if not selector:
            continue
        # Keep unresolved consent/CMP surfaces in the cookie flow so we don't
        # visually hide them without persisting the user's choice.
        if overlay.get("hasConsentWords"):
            continue

        try:
            container = page.locator(selector).first
            if container.is_visible(timeout=500):
                close_btn = container.locator(
                    "button[aria-label*='close' i], button[aria-label*='dismiss' i], "
                    "[class*='close'], [data-dismiss], [data-action='close'], .btn-close, button:has(svg)"
                ).first
                if overlay.get("hasCloseCandidate") and close_btn.is_visible(timeout=500):
                    close_btn.click(timeout=1000, force=True)
                    logger.info("Closed blocking overlay via internal close button: %s", selector)
                    removed += 1
                    time.sleep(random.uniform(0.3, 0.5))
                    continue

                if overlay.get("hasSignupWords"):
                    if _click_first_text_match(
                        container,
                        _POPUP_CLOSE_TEXTS,
                        timeout_ms=700,
                        label="Overlay",
                        force_exact_texts=_POPUP_CLOSE_TEXTS_EXACT,
                    ):
                        removed += 1
                        time.sleep(random.uniform(0.25, 0.45))
                        continue
        except Exception:
            pass

        should_force_hide = any(
            overlay.get(flag)
            for flag in ("hasSignupWords", "hasEmailInput", "hasFormFields")
        ) or overlay.get("role") == "dialog" or overlay.get("ariaModal") == "true"
        if not should_force_hide:
            continue

        try:
            result = page.evaluate(_REMOVE_OVERLAY_JS, selector)
            if result:
                logger.info("Force-hidden blocking overlay: %s", selector)
                removed += 1
                time.sleep(random.uniform(0.2, 0.4))
        except Exception as exc:
            logger.warning("Failed to force-hide overlay '%s': %s", selector, exc)
    if removed:
        _clear_scroll_locks(page, reason="overlay dismissal")
    return removed


def _force_hide_site_overlays(page, domain: str = "") -> int:
    """Force-hide known site-specific overlays before generic heuristics run."""
    if not domain or domain not in _SITE_POPUP_OVERRIDES:
        return 0

    selectors = _SITE_POPUP_OVERRIDES[domain].get("force_hide_selectors", [])
    removed = 0
    for selector in selectors:
        try:
            result = page.evaluate(_REMOVE_OVERLAY_JS, selector)
            if result:
                logger.info("Force-hidden site overlay for %s: %s", domain, selector)
                removed += 1
                time.sleep(random.uniform(0.2, 0.4))
        except Exception as exc:
            logger.warning("Failed to force-hide site overlay '%s' for %s: %s", selector, domain, exc)

    if removed:
        _clear_scroll_locks(page, reason=f"site overlay dismissal ({domain})")
    return removed


def _handle_iframe_popups(page) -> int:
    """Detect and dismiss popups that live inside iframes."""
    dismissed = 0
    iframe_targets = _iter_exact_iframe_targets(
        page,
        [
            'iframe[src*="popup"]',
            'iframe[src*="modal"]',
            'iframe[src*="overlay"]',
            'iframe[src*="newsletter"]',
            'iframe[src*="subscribe"]',
            'iframe[class*="popup"]',
            'iframe[class*="modal"]',
            'iframe[id*="popup"]',
        ],
        max_per_selector=2,
    )

    for iframe_target in iframe_targets:
        iframe_loc = iframe_target.get("locator")
        if not iframe_loc:
            continue
        try:
            hidden = iframe_loc.evaluate(
                """(iframe) => {
                    let el = iframe;
                    for (let i = 0; i < 5 && el; i++) {
                        const style = window.getComputedStyle(el);
                        const z = parseInt(style.zIndex, 10);
                        if (z >= 500 && (style.position === 'fixed' || style.position === 'absolute') && el.id !== 'app') {
                            el.style.display = 'none';
                            el.style.visibility = 'hidden';
                            el.style.pointerEvents = 'none';
                            return true;
                        }
                        el = el.parentElement;
                    }
                    // No high-z popup parent found - only hide if the iframe itself looks like a popup
                    const iframeStyle = window.getComputedStyle(iframe);
                    const iframeZ = parseInt(iframeStyle.zIndex, 10);
                    if (iframeZ >= 500 && (iframeStyle.position === 'fixed' || iframeStyle.position === 'absolute')) {
                        iframe.style.display = 'none';
                        iframe.style.visibility = 'hidden';
                        iframe.style.pointerEvents = 'none';
                        return true;
                    }
                    return false;
                }"""
            )
            if hidden:
                dismissed += 1
        except Exception as exc:
            logger.warning("Exact iframe popup hiding failed for %s: %s", iframe_target.get("selector"), exc)

    if dismissed:
        logger.info("Removed %d popup iframes", dismissed)
        _clear_scroll_locks(page, reason="generic iframe popup dismissal")
    return dismissed


# ── Cookie banner ─────────────────────────────────────────────────────────

def _cookie_banner_present(page) -> bool:
    return _find_cookie_banner_scope(page) is not None


def _banner_is_non_blocking(scope: Optional[Dict[str, Any]]) -> bool:
    if not scope or not scope.get("container"):
        return False
    try:
        return bool(
            scope["container"].evaluate(
                """(el) => {
                    if (!el || !el.isConnected) return true;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
                        return true;
                    }
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 6 || rect.height < 6) return true;
                    if (rect.height < window.innerHeight * 0.15) {
                        // Small banner - non-blocking regardless of position
                        return true;
                    }
                    if ((style.position === 'fixed' || style.position === 'sticky') && rect.height < window.innerHeight * 0.25) {
                        const docHeight = document.documentElement.scrollHeight || window.innerHeight;
                        const isBottomDocked = rect.bottom >= window.innerHeight - 10;
                        const isTopDocked = rect.top <= 10;
                        if (isBottomDocked || isTopDocked) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return True


def _wait_for_banner_gone(page, timeout_ms: int = 1800, banner_scope: Optional[Dict[str, Any]] = None) -> bool:
    time.sleep(random.uniform(0.18, 0.35))

    container = (banner_scope or {}).get("container")
    if container is not None:
        try:
            container.wait_for(state="hidden", timeout=min(timeout_ms, 900))
            return True
        except PlaywrightTimeoutError:
            pass
        except Exception:
            pass

        if _banner_is_non_blocking(banner_scope):
            return True

    fallback_selectors = _merge_unique_strings(
        [banner_scope.get("selector")] if banner_scope and banner_scope.get("selector") else [],
        _CMP_PROFILES.get((banner_scope or {}).get("profile_name") or "", {}).get("container_selectors", []),
        ["#sp-cc", "#onetrust-banner-sdk", "#CybotCookiebotDialog", "#didomi-popup", ".cc-window"],
    )

    for sel in fallback_selectors:
        try:
            page.wait_for_selector(sel, state="hidden", timeout=min(timeout_ms, 450))
            return True
        except PlaywrightTimeoutError:
            continue
        except Exception:
            continue

    return _find_cookie_banner_scope(page) is None


def _handle_cookie_banner(page, url: str = "") -> bool:
    time.sleep(random.uniform(0.3, 0.7))
    domain = _get_domain(url) if url else ""
    scope = _find_cookie_banner_scope(page, domain=domain)
    if not scope:
        return False

    attempted_actions: List[str] = []
    scope_label = _cookie_scope_label(scope)
    logger.info("Cookie banner detected — attempting scoped dismissal via %s", scope_label)

    def current_roots(current_scope: Dict[str, Any]) -> List[Any]:
        ordered: List[Any] = []
        seen = set()
        for candidate in [current_scope.get("root"), current_scope.get("context"), page]:
            if candidate is None:
                continue
            marker = id(candidate)
            if marker in seen:
                continue
            seen.add(marker)
            ordered.append(candidate)
        return ordered

    def refresh_scope() -> Dict[str, Any]:
        return _find_cookie_banner_scope(page, domain=domain) or scope

    profile_name = scope.get("profile_name")
    reject_selectors = _cmp_profile_value(
        domain,
        profile_name,
        "reject_selectors",
        _merge_unique_strings(_COOKIE_FRAMEWORK_SELECTORS, _COOKIE_REJECT_CSS),
    )
    settings_selectors = _cmp_profile_value(domain, profile_name, "settings_selectors", _COOKIE_SETTINGS_SELECTORS)
    save_selectors = _cmp_profile_value(domain, profile_name, "save_selectors", _COOKIE_SAVE_SELECTORS)
    accept_selectors = _cmp_profile_value(domain, profile_name, "accept_selectors", _COOKIE_ACCEPT_FRAMEWORK)

    for index, root in enumerate(current_roots(scope)):
        stage = "scoped" if index == 0 else "context" if index == 1 else "global"
        if _attempt_click_group(
            root,
            selectors=reject_selectors,
            texts=_COOKIE_REJECT_TEXTS,
            label=f"{scope_label} {stage} reject",
            attempted_actions=attempted_actions,
            timeout_ms=950,
        ):
            if _wait_for_banner_gone(page, banner_scope=scope):
                _clear_scroll_locks(page, reason="cookie reject")
                return True
            scope = refresh_scope()

    for index, root in enumerate(current_roots(scope)):
        stage = "scoped" if index == 0 else "context" if index == 1 else "global"
        if not _attempt_click_group(
            root,
            selectors=settings_selectors,
            texts=_COOKIE_SETTINGS_TEXTS,
            label=f"{scope_label} {stage} settings",
            attempted_actions=attempted_actions,
            timeout_ms=900,
        ):
            continue

        time.sleep(random.uniform(0.25, 0.45))
        scope = refresh_scope()
        scope_label = _cookie_scope_label(scope)
        profile_name = scope.get("profile_name")
        reject_selectors = _cmp_profile_value(
            domain,
            profile_name,
            "reject_selectors",
            _merge_unique_strings(_COOKIE_FRAMEWORK_SELECTORS, _COOKIE_REJECT_CSS),
        )
        save_selectors = _cmp_profile_value(domain, profile_name, "save_selectors", _COOKIE_SAVE_SELECTORS)

        for nested_root in current_roots(scope):
            if _attempt_click_group(
                nested_root,
                selectors=reject_selectors,
                texts=_COOKIE_REJECT_TEXTS,
                label=f"{scope_label} reject-after-settings",
                attempted_actions=attempted_actions,
                timeout_ms=900,
            ):
                if _wait_for_banner_gone(page, banner_scope=scope):
                    _clear_scroll_locks(page, reason="cookie settings reject")
                    return True
                scope = refresh_scope()
                break

        toggled = _toggle_off_non_essential_cookie_choices(scope)
        if toggled:
            _record_attempt(attempted_actions, f"{scope_label} toggled:{' | '.join(toggled[:4])}")

        for nested_root in current_roots(scope):
            if _attempt_click_group(
                nested_root,
                selectors=save_selectors,
                texts=_COOKIE_SAVE_TEXTS,
                label=f"{scope_label} save-choices",
                attempted_actions=attempted_actions,
                timeout_ms=900,
            ):
                if _wait_for_banner_gone(page, banner_scope=scope):
                    _clear_scroll_locks(page, reason="cookie save choices")
                    return True
                scope = refresh_scope()
                break

        if toggled and _wait_for_banner_gone(page, banner_scope=scope):
            _clear_scroll_locks(page, reason="cookie category toggles")
            return True

    for index, root in enumerate(current_roots(scope)):
        stage = "scoped" if index == 0 else "context" if index == 1 else "global"
        if _attempt_click_group(
            root,
            selectors=accept_selectors,
            texts=_COOKIE_ACCEPT_TEXTS,
            label=f"{scope_label} {stage} accept-compat",
            attempted_actions=attempted_actions,
            timeout_ms=850,
        ):
            if _wait_for_banner_gone(page, banner_scope=scope):
                _clear_scroll_locks(page, reason="cookie accept compatibility fallback")
                return True
            scope = refresh_scope()
            break

    remaining_for_escape = _find_cookie_banner_scope(page, domain=domain)
    if remaining_for_escape and not _banner_is_non_blocking(remaining_for_escape):
        try:
            _record_attempt(attempted_actions, f"{scope_label} escape")
            page.keyboard.press("Escape")
            time.sleep(random.uniform(0.3, 0.6))
            if _wait_for_banner_gone(page, banner_scope=scope):
                _clear_scroll_locks(page, reason="cookie escape")
                return True
        except Exception:
            pass

    remaining_scope = _find_cookie_banner_scope(page, domain=domain) or scope
    blocker = None
    if remaining_scope.get("container") is not None:
        blocker = _locator_debug_snapshot(remaining_scope["container"])
    if blocker is None:
        blocker = _collect_top_blocker_metadata(page, prefer_cookie=True)
    _log_popup_failure_evidence(
        page,
        url=url,
        popup_type="cookie",
        attempted_actions=attempted_actions,
        blocker=blocker,
    )
    return False


# ── Popup / overlay dismissal ─────────────────────────────────────────────

def _popup_present(page) -> bool:
    """Check if a real popup/overlay is present using selectors, z-index heuristic, and iframe check."""

    # Fast-path: single JS call checks the most common popup signals.
    # If nothing is found, skip the expensive per-selector Python loop entirely.
    try:
        fast_check = page.evaluate("""
            () => {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const consentWords = ['cookie', 'consent', 'privacy', 'gdpr', 'onetrust',
                                      'didomi', 'usercentrics', 'cookiefirst', 'cybot'];
                const cookieTextSignals = ['we use cookies', 'cookie policy', 'cookie consent',
                    'this site uses cookies', 'manage cookies', 'cookie settings',
                    'your privacy', 'gdpr', 'data protection', 'privacy preferences'];

                // Check 1: any visible role="dialog" or aria-modal that's not a cookie banner
                const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
                for (const el of dialogs) {
                    const s = window.getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 200 || r.height < 150) continue;
                    const cls = (el.className || '').toString().toLowerCase();
                    const id = (el.id || '').toLowerCase();
                    if (consentWords.some(w => cls.includes(w) || id.includes(w))) continue;
                    const elText = ((el.innerText || el.textContent || '').toLowerCase()).slice(0, 300);
                    if (cookieTextSignals.some(sig => elText.includes(sig))) continue;
                    return 'dialog';
                }

                // Check 2: high-z-index fixed/absolute elements covering significant viewport
                const allEls = document.querySelectorAll('div, section, aside, form');
                for (const el of allEls) {
                    const s = window.getComputedStyle(el);
                    const z = parseInt(s.zIndex, 10);
                    if (isNaN(z) || z < 500) continue;
                    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                    const pos = s.position;
                    if (pos !== 'fixed' && pos !== 'absolute') continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < vw * 0.3 || r.height < vh * 0.3) {
                        if (!el.querySelector('input[type="email"], input[placeholder*="email" i]')) continue;
                    }
                    const cls = (el.className || '').toString().toLowerCase();
                    const id = (el.id || '').toLowerCase();
                    if (consentWords.some(w => cls.includes(w) || id.includes(w))) continue;
                    const elText = ((el.innerText || el.textContent || '').toLowerCase()).slice(0, 300);
                    if (cookieTextSignals.some(sig => elText.includes(sig))) continue;
                    return 'overlay';
                }

                return null;
            }
        """)
        if fast_check:
            return True
    except Exception:
        pass

    for sel in _POPUP_CONTAINER_SELECTORS:
        try:
            loc = page.locator(sel)
            for i in range(min(loc.count(), 3)):
                el = loc.nth(i)
                if el.is_visible(timeout=300):
                    text = _visible_locator_text(el, timeout_ms=300)
                    if _cookie_text_signal(text):
                        continue
                    snapshot = _locator_debug_snapshot(el) or {}
                    combined = " ".join(
                        str(snapshot.get(key, ""))
                        for key in ("id", "className", "ariaLabel", "textSnippet")
                    )
                    if _cookie_text_signal(combined):
                        continue
                    try:
                        box = el.bounding_box()
                        if box and (box["width"] < 200 or box["height"] < 150):
                            continue
                    except Exception:
                        pass
                    return True
        except Exception:
            continue

    try:
        has_overlay = page.evaluate("""
            () => {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const consentWords = ['cookie', 'consent', 'privacy', 'gdpr', 'onetrust', 'didomi', 'usercentrics', 'cookiefirst', 'cybot'];
                const els = document.querySelectorAll('div, section, aside, [role="dialog"], form');
                for (const el of els) {
                    const s = window.getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                    const z = parseInt(s.zIndex, 10);
                    if (isNaN(z) || z < 500) continue;
                    const pos = s.position;
                    if (pos !== 'fixed' && pos !== 'absolute') continue;
                    const cls = (el.className || '').toString().toLowerCase();
                    const id = (el.id || '').toLowerCase();
                    const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
                        .toLowerCase().slice(0, 220);
                    if (consentWords.some(word => cls.includes(word) || id.includes(word) || text.includes(word))) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > vw * 0.3 && r.height > vh * 0.3) return true;
                    if (el.querySelector('input[type="email"], input[placeholder*="email" i]')) return true;
                }
                return false;
            }
        """)
        if has_overlay:
            return True
    except Exception:
        pass

    for iframe_sel, _ in _IFRAME_POPUP_TARGETS:
        try:
            loc = page.locator(iframe_sel)
            if loc.count() > 0 and loc.first.is_visible(timeout=300):
                return True
        except Exception:
            continue

    return False


_IFRAME_POPUP_TARGETS = [
    (
        'iframe.attentive_creative, iframe[src*="creatives.attn.tv"], #attentive_overlay iframe',
        [
            'button#closeIconContainer',
            'button[data-testid="closeIcon"]',
            'button[aria-label*="Dismiss" i]',
            'button[aria-label*="Close" i]',
            '#closeIconContainer',
            '[class*="close"]',
        ],
    ),
    (
        'iframe[src*="klaviyo.com"], iframe[src*="static.klaviyo"], .klaviyo-form iframe',
        [
            'button[aria-label*="Close" i]',
            'button[aria-label*="Dismiss" i]',
            '.needsclick.kl-private-reset-css-Xuajs1 button',
            '[class*="close"]',
        ],
    ),
    (
        'iframe[src*="justuno.com"], iframe[src*="justo.io"]',
        [
            'button[aria-label*="Close" i]',
            '[class*="close"]',
        ],
    ),
    (
        'iframe[src*="wisepops.com"]',
        [
            'button[aria-label*="Close" i]',
            '.wisepops-close',
            '[class*="close"]',
        ],
    ),
    (
        'iframe[src*="popup"], iframe[src*="campaign"], iframe[src*="subscribe"]',
        [
            'button[aria-label*="Close" i]',
            'button[aria-label*="Dismiss" i]',
            '[class*="close"]',
            '[data-testid*="close" i]',
        ],
    ),
]


def _dismiss_iframe_popups(page) -> int:
    """
    Dismiss popups that live inside iframes (Attentive, Klaviyo, etc.).
    Uses the exact visible iframe element to avoid selector/nth mismatches.
    """
    dismissed = 0

    for iframe_selector, close_selectors in _IFRAME_POPUP_TARGETS:
        iframe_targets = _iter_exact_iframe_targets(page, [iframe_selector], max_per_selector=2)
        for iframe_target in iframe_targets:
            iframe_loc = iframe_target.get("locator")
            frame = iframe_target.get("frame")
            iframe_dismissed = False

            if frame:
                for close_sel in close_selectors:
                    try:
                        close_btn = frame.locator(close_sel).first
                        if close_btn.is_visible(timeout=800):
                            try:
                                close_btn.click(timeout=1500)
                            except Exception:
                                close_btn.click(timeout=1500, force=True)
                            logger.info(
                                "Iframe popup dismissed: iframe='%s' close='%s'",
                                iframe_target.get("selector", iframe_selector)[:50],
                                close_sel,
                            )
                            dismissed += 1
                            iframe_dismissed = True
                            time.sleep(random.uniform(0.3, 0.6))
                            break
                    except Exception:
                        continue

            if not iframe_dismissed and frame:
                try:
                    if _click_first_text_match(
                        frame,
                        _POPUP_CLOSE_TEXTS,
                        timeout_ms=700,
                        label="Iframe popup",
                        force_exact_texts=_POPUP_CLOSE_TEXTS_EXACT,
                    ):
                        logger.info("Iframe popup dismissed via text match inside %s", iframe_target.get("selector", iframe_selector)[:50])
                        dismissed += 1
                        iframe_dismissed = True
                except Exception:
                    pass

            if iframe_dismissed or not iframe_loc:
                continue

            try:
                parent_hidden = iframe_loc.evaluate(
                    """
                        (iframe) => {
                            let el = iframe;
                            for (let i = 0; i < 5 && el; i++) {
                                const s = window.getComputedStyle(el);
                                const z = parseInt(s.zIndex, 10);
                                if (z >= 500 && (s.position === 'fixed' || s.position === 'absolute') && el.id !== 'app') {
                                    el.style.display = 'none';
                                    el.style.visibility = 'hidden';
                                    el.style.pointerEvents = 'none';
                                    return true;
                                }
                                el = el.parentElement;
                            }
                            // No high-z popup parent found — only hide if the iframe itself looks like a popup
                            const iframeStyle = window.getComputedStyle(iframe);
                            const iframeZ = parseInt(iframeStyle.zIndex, 10);
                            if (iframeZ >= 500 && (iframeStyle.position === 'fixed' || iframeStyle.position === 'absolute')) {
                                iframe.style.display = 'none';
                                iframe.style.visibility = 'hidden';
                                iframe.style.pointerEvents = 'none';
                                return true;
                            }
                            return false;
                        }
                    """
                )
                if parent_hidden:
                    logger.info("Iframe popup parent hidden: %s", iframe_target.get("selector", iframe_selector)[:50])
                    dismissed += 1
            except Exception as exc:
                logger.warning("Failed to hide iframe popup parent: %s", exc)

        if not iframe_targets:
            try:
                page.locator(iframe_selector).count()
            except Exception as exc:
                logger.warning("Iframe popup check failed for '%s': %s", iframe_selector[:40], exc)

    if dismissed:
        _clear_scroll_locks(page, reason="iframe popup dismissal")
    return dismissed


def _dismiss_single_popup(page, domain: str = "", attempted_actions: Optional[List[str]] = None) -> bool:
    """
    Multi-layer popup dismissal:
      1) Site-specific selectors
      2) Generic close selectors
      3) Text match INSIDE popup containers only (not page-wide)
      4) Iframe-hosted popup search
      5) Shadow DOM search
      6) Escape key
    """
    if attempted_actions is None:
        attempted_actions = []

    # Layer 1: site-specific overrides
    if domain and domain in _SITE_POPUP_OVERRIDES:
        override = _SITE_POPUP_OVERRIDES[domain]
        site_sels = override.get("close_selectors", [])
        site_texts = override.get("close_texts", [])
        _record_attempt(attempted_actions, f"site-popup-overrides:{domain}")
        if site_sels and _click_first_match(page, site_sels, timeout_ms=800, label=f"Popup ({domain})"):
            _clear_scroll_locks(page, reason=f"site popup dismissal ({domain})")
            return True
        if site_texts and _click_first_text_match(page, site_texts, timeout_ms=800, label=f"Popup ({domain})"):
            _clear_scroll_locks(page, reason=f"site popup dismissal ({domain})")
            return True

    # Layer 2: generic close selectors
    _record_attempt(attempted_actions, "generic-popup-close-selectors")
    if _click_first_match(page, _POPUP_CLOSE_SELECTORS, timeout_ms=1000, label="Popup"):
        _clear_scroll_locks(page, reason="generic popup close selector")
        return True

    # Layer 3: text match SCOPED to inside visible popup containers
    # This prevents clicking random page elements like language selectors
    _record_attempt(attempted_actions, "scoped-popup-close-text")
    for container_sel in _POPUP_CONTAINER_SELECTORS:
        try:
            container = page.locator(container_sel)
            for i in range(min(container.count(), 2)):
                cont = container.nth(i)
                if not cont.is_visible(timeout=300):
                    continue
                # Search for close text INSIDE this container only
                for text in _POPUP_CLOSE_TEXTS:
                    use_exact = len(text) <= 3 or text.lower() in _POPUP_CLOSE_TEXTS_EXACT
                    for role in ("button", "link"):
                        try:
                            btn = cont.get_by_role(role, name=text, exact=use_exact)
                            if btn.count() > 0 and btn.first.is_visible(timeout=300):
                                try:
                                    btn.first.click(timeout=800)
                                except Exception:
                                    btn.first.click(timeout=800, force=True)
                                time.sleep(random.uniform(0.25, 0.55))
                                logger.info("Popup dismissed via scoped text match: '%s' inside %s", text, container_sel)
                                _clear_scroll_locks(page, reason="scoped popup text dismissal")
                                return True
                        except Exception:
                            pass
        except Exception:
            continue

    # Layer 4: iframe-hosted popups (Attentive, Klaviyo, etc.)
    _record_attempt(attempted_actions, "iframe-popup-dismissal")
    if _dismiss_iframe_popups(page):
        return True

    # Layer 5: shadow DOM
    _record_attempt(attempted_actions, "shadow-dom-popup-dismissal")
    if _try_shadow_dom_close(page):
        return True

    # Layer 6: Escape key
    try:
        _record_attempt(attempted_actions, "popup-escape")
        page.keyboard.press("Escape")
        time.sleep(random.uniform(0.3, 0.5))
        if not _popup_present(page):
            logger.info("Popup dismissed via Escape key")
            _clear_scroll_locks(page, reason="popup escape")
            return True
    except Exception:
        pass
    return False


def _handle_popups_and_overlays(page, url: str = "", max_passes: int = 4) -> int:
    time.sleep(random.uniform(0.3, 0.7))
    domain = _get_domain(url) if url else ""
    dismissed = 0
    attempted_actions: List[str] = []
    for pass_num in range(max_passes):
        if not _popup_present(page):
            break
        _record_attempt(attempted_actions, f"popup-pass-{pass_num + 1}")
        if _dismiss_single_popup(page, domain=domain, attempted_actions=attempted_actions):
            dismissed += 1
            time.sleep(random.uniform(0.3, 0.5))
        else:
            _record_attempt(attempted_actions, "site-overlay-force-hide")
            removed = _force_hide_site_overlays(page, domain=domain)
            if removed:
                dismissed += removed
                continue
            # Can't find close button — try z-index overlay detection
            _record_attempt(attempted_actions, "generic-overlay-detection")
            removed = _detect_and_remove_blocking_overlays(page)
            if removed:
                dismissed += removed
            else:
                logger.info("Popup pass %d: detected but no dismissal method worked", pass_num + 1)
                break
    # Always check for iframe popups
    dismissed += _handle_iframe_popups(page)
    if dismissed:
        _clear_scroll_locks(page, reason="popup batch")
        logger.info("Total popups/overlays dismissed: %d", dismissed)
    elif _popup_present(page):
        _log_popup_failure_evidence(
            page,
            url=url,
            popup_type="popup",
            attempted_actions=attempted_actions,
        )
    return dismissed


def handle_all_popups(page, url: str = "", is_recheck: bool = False) -> int:
    """Single entry point. Call after page load, and again after human simulation."""
    try:
        if page.is_closed():
            return 0
    except Exception:
        return 0
    total = 0
    domain = _get_domain(url) if url else ""
    iframe_pass_done = False

    should_check_cookie = (not is_recheck) or _cookie_banner_present(page)
    if should_check_cookie:
        if _handle_cookie_banner(page, url=url):
            total += 1

    total += _handle_popups_and_overlays(page, url=url)
    # _handle_popups_and_overlays already runs iframe checks internally,
    # only do a standalone pass if popups were found (new iframes may have appeared)
    if total > 0:
        total += _dismiss_iframe_popups(page)
        iframe_pass_done = True

    if not is_recheck and total == 0:
        _anti_bot_sleep(2.5, 4.0)
        total += _handle_popups_and_overlays(page, url=url)
        if not iframe_pass_done:
            total += _dismiss_iframe_popups(page)

    if total == 0:
        total += _force_hide_site_overlays(page, domain=domain)
    if total == 0:
        total += _detect_and_remove_blocking_overlays(page)
    if total:
        _clear_scroll_locks(page, reason="handle_all_popups")

    return total


# ── CAPTCHA detection ─────────────────────────────────────────────────────

def _detect_page_issues(page) -> Dict[str, bool]:
    """
    Detect CAPTCHA/block signals using DOM element checks and visible text.
    Never scans raw HTML - that causes false positives from CDN URLs and script tags.
    """
    try:
        if page.is_closed():
            return {"is_captcha": False, "is_blocked": False}
    except Exception:
        return {"is_captcha": False, "is_blocked": False}
    try:
        result = page.evaluate(
            """() => {
                const title = (document.title || '').toLowerCase();
                const bodyText = (document.body?.innerText || '').trim();
                const bodyLower = bodyText.toLowerCase().slice(0, 4000);
                const textLength = bodyText.length;

                const hasChallengeElement = !!(
                    document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                    document.querySelector('iframe[src*="recaptcha/api"]') ||
                    document.querySelector('iframe[src*="hcaptcha.com"]') ||
                    document.querySelector('#challenge-running') ||
                    document.querySelector('#challenge-stage') ||
                    document.querySelector('#challenge-form') ||
                    document.querySelector('.cf-turnstile') ||
                    document.querySelector('[class*="cf-turnstile"]') ||
                    document.querySelector('#px-captcha') ||
                    document.querySelector('.px-captcha') ||
                    document.querySelector('[id*="captcha-container"]') ||
                    document.querySelector('[class*="captcha-container"]') ||
                    document.querySelector('div[data-sitekey]') ||
                    document.querySelector('.g-recaptcha') ||
                    document.querySelector('.h-captcha')
                );

                return {
                    title: title,
                    bodyLower: bodyLower,
                    textLength: textLength,
                    hasChallengeElement: hasChallengeElement,
                };
            }"""
        )
    except Exception as exc:
        logger.warning("Failed to evaluate page for captcha/block signals: %s", exc)
        return {"is_captcha": False, "is_blocked": False}

    title = result.get("title", "")
    body = result.get("bodyLower", "")
    text_length = result.get("textLength", 0)
    has_challenge_element = result.get("hasChallengeElement", False)
    is_minimal_content = text_length < 300

    is_captcha = False
    is_blocked = False

    if has_challenge_element and is_minimal_content:
        is_captcha = True
        logger.info("CAPTCHA detected: challenge DOM element present, page has only %d chars", text_length)

    challenge_title_markers = [
        "just a moment",
        "checking your browser",
        "attention required",
        "verify you are human",
        "security check",
        "access denied",
        "please wait",
        "one more step",
    ]
    if any(marker in title for marker in challenge_title_markers):
        if is_minimal_content:
            is_captcha = True
            logger.info("CAPTCHA detected: challenge title '%s', page has only %d chars", title[:60], text_length)

    captcha_text_markers = [
        "verify you are human",
        "press & hold",
        "robot or human",
        "please verify you are a human",
        "checking if the site connection is secure",
        "please stand by",
        "performing a security check",
    ]
    blocked_text_markers = [
        "sorry, you have been blocked",
        "blocked your ip",
        "your ip address has been blocked",
        "this request was blocked",
    ]

    if is_minimal_content:
        if any(marker in body for marker in captcha_text_markers):
            is_captcha = True
        if any(marker in body for marker in blocked_text_markers):
            is_blocked = True

    return {"is_captcha": is_captcha, "is_blocked": is_blocked}


def _bezier_points(p0, p1, p2, p3, steps: int = 20):
    """Yield (x, y) points along a cubic Bezier curve."""
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3*p0[0] + 3*u**2*t*p1[0] + 3*u*t**2*p2[0] + t**3*p3[0]
        y = u**3*p0[1] + 3*u**2*t*p1[1] + 3*u*t**2*p2[1] + t**3*p3[1]
        yield int(x), int(y)


def _simulate_human_behavior(page, duration_seconds: float = 2.0) -> None:
    """Simulate realistic human interaction using Bezier mouse paths and randomised scrolling."""
    start = time.time()
    try:
        vp = page.viewport_size() or {"width": 1280, "height": 800}
    except Exception as exc:
        logger.debug("Failed to read viewport size for behavior simulation: %s", exc)
        vp = {"width": 1280, "height": 800}
    W, H = vp["width"], vp["height"]

    def rand_point():
        return (random.randint(int(W * 0.1), int(W * 0.9)),
                random.randint(int(H * 0.1), int(H * 0.9)))

    _current_pos = [W // 2, H // 2]

    def bezier_move(dst):
        src_x, src_y = _current_pos
        dx, dy = dst[0] - src_x, dst[1] - src_y
        cp1 = (src_x + dx * 0.25 + random.randint(-60, 60),
               src_y + dy * 0.25 + random.randint(-60, 60))
        cp2 = (src_x + dx * 0.75 + random.randint(-60, 60),
               src_y + dy * 0.75 + random.randint(-60, 60))
        steps = random.randint(12, 28)
        for (px, py) in _bezier_points((src_x, src_y), cp1, cp2, dst, steps):
            try:
                page.mouse.move(px, py)
            except Exception as exc:
                logger.debug("Mouse movement failed during behavior simulation: %s", exc)
                break
            if random.random() < 0.08:
                time.sleep(random.uniform(0.01, 0.04))
        _current_pos[0], _current_pos[1] = dst[0], dst[1]

    for _ in range(random.randint(3, 5)):
        bezier_move(rand_point())
        time.sleep(random.uniform(0.06, 0.15))

    scroll_down = random.randint(300, 700)
    page.mouse.wheel(0, scroll_down)
    time.sleep(random.uniform(0.3, 0.6))

    for _ in range(random.randint(2, 4)):
        bezier_move(rand_point())
        time.sleep(random.uniform(0.05, 0.12))

    page.mouse.wheel(0, -random.randint(80, int(scroll_down * 0.6)))
    time.sleep(random.uniform(0.15, 0.35))

    price_area = (random.randint(int(W * 0.3), int(W * 0.7)),
                  random.randint(int(H * 0.2), int(H * 0.5)))
    bezier_move(price_area)
    time.sleep(random.uniform(0.2, 0.45))

    elapsed = time.time() - start
    remaining = duration_seconds - elapsed
    if remaining > 0.1:
        time.sleep(min(remaining, duration_seconds))


def _wait_for_real_content(page, timeout_seconds: int = 15) -> bool:
    try:
        if page.is_closed():
            return False
    except Exception:
        return False
    # Primary check: reasonable amount of text content
    try:
        page.wait_for_function(
            "document.body && document.body.innerText.trim().length > 200",
            timeout=timeout_seconds * 1000,
        )
        return True
    except Exception:
        pass

    # Fallback: page has less text but contains price-like elements (common on minimal product pages)
    try:
        has_price_signal = page.evaluate(
            """() => {
                const body = document.body;
                if (!body) return false;
                const textLen = (body.innerText || '').trim().length;
                if (textLen < 50) return false;
                // Page has some content AND a price-related element
                return !!(
                    document.querySelector('[itemprop="price"]') ||
                    document.querySelector('[data-price]') ||
                    document.querySelector('[class*="price"]') ||
                    document.querySelector('.a-price') ||
                    document.querySelector('[data-testid*="price" i]')
                );
            }"""
        )
        if has_price_signal:
            return True
    except Exception:
        pass

    logger.warning("Waiting for real page content failed after %ds", timeout_seconds)
    return False


def _url_matches_any_domain(url: str, domains) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    for domain in domains:
        if host == domain or host.endswith(f".{domain}"):
            return True
    return False


_PRODUCT_TITLE_SELECTORS = [
    "#productTitle",
    "[data-test='product-title']",
    "h1[itemprop='name']",
    "[data-testid='product-title']",
    "h1.product-title",
    "[class*='ProductTitle'] h1",
    "[class*='product-title'] h1",
    "h1[class*='productTitle']",
    "h1[class*='product-name']",
]


def _scrape_with_chrome_cdp(
    url: str,
    custom_selector: Optional[str] = None,
    original_price_selector: Optional[str] = None,
    resolved_cdp_endpoint: Optional[Tuple[str, Dict[str, str]]] = None,
    proxy_config: Optional[dict] = None,
    skip_captcha_check: bool = False,
    max_attempts_override: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Scrape price using the remote Chrome container via CDP."""
    max_attempts = max_attempts_override if max_attempts_override is not None else int(os.getenv("SCRAPE_MAX_ATTEMPTS", "3"))
    scraped_domain = _get_domain(url)
    if not skip_captcha_check and _is_domain_captcha_blocked(scraped_domain):
        remaining = _get_captcha_cooldown_remaining(scraped_domain)
        return {
            "status": "captcha_blocked",
            "error": (
                f"CAPTCHA protection detected on {scraped_domain}. "
                f"Use the browser extension to check this price. "
                f"CDP will retry automatically in {int(remaining // 60)} minutes."
            ),
            "domain": scraped_domain,
            "cooldown_remaining": remaining,
            "source": "chrome_cdp",
        }
    had_real_content = False
    had_captcha = False  # Track if any attempt hit CAPTCHA
    wall_deadline = time.time() + CDP_SCRAPE_MAX_WALL_SECONDS
    per_attempt_context = _url_matches_any_domain(url, BOT_AGGRESSIVE_DOMAINS)
    pw = None
    browser = None
    shared_context = None
    try:
        try:
            pw = sync_playwright().start()
            if resolved_cdp_endpoint and resolved_cdp_endpoint[0]:
                cdp_endpoint, cdp_headers = resolved_cdp_endpoint
            else:
                cached_endpoint = _get_cached_cdp_endpoint()
                if cached_endpoint:
                    cdp_endpoint, cdp_headers = cached_endpoint
                else:
                    cdp_endpoint, cdp_headers = _resolve_cdp_ws_endpoint(CHROME_CDP_URL, timeout_seconds=8.0)
            if not cdp_endpoint:
                logger.warning("CDP endpoint resolution failed for %s", CHROME_CDP_URL)
                return None
            connect_kwargs = {"headers": cdp_headers} if cdp_headers else {}
            browser = pw.chromium.connect_over_cdp(cdp_endpoint, **connect_kwargs)
        except Exception as exc:
            logger.warning("CDP per-request connect failed: %s", exc)
            if pw:
                try:
                    pw.stop()
                except Exception as stop_exc:
                    logger.debug("Failed to stop Playwright after CDP connect failure: %s", stop_exc)
                pw = None
            return None

        try:
            if not per_attempt_context:
                _context_kwargs = dict(
                    viewport={"width": 1280, "height": 800},
                    locale="en-US",
                    timezone_id=random.choice(_US_TIMEZONES),
                    java_script_enabled=True,
                    user_agent=random.choice(USER_AGENTS),
                )
                if proxy_config:
                    _context_kwargs["proxy"] = proxy_config
                shared_context = browser.new_context(**_context_kwargs)

            for attempt in range(max_attempts):
                if time.time() > wall_deadline:
                    logger.warning("CDP scrape max wall time (%.0fs) exceeded for %s", CDP_SCRAPE_MAX_WALL_SECONDS, url)
                    break
                context = shared_context
                # Note: when per_attempt_context is True, shared_context is None,
                # so context starts as None and gets replaced by a fresh context below.
                # If new_context() fails, context remains None and finally-block skips close.
                if per_attempt_context:
                    try:
                        _context_kwargs = dict(
                            viewport={"width": 1280, "height": 800},
                            locale="en-US",
                            timezone_id=random.choice(_US_TIMEZONES),
                            java_script_enabled=True,
                            user_agent=random.choice(USER_AGENTS),
                        )
                        if proxy_config:
                            _context_kwargs["proxy"] = proxy_config
                        context = browser.new_context(**_context_kwargs)
                    except Exception as exc:
                        logger.debug("CDP context creation failed on attempt %d: %s", attempt + 1, exc)
                        _retry_sleep(attempt)
                        continue

                page = None
                try:
                    page = context.new_page()
                    page.on("dialog", lambda dialog: dialog.dismiss())
                    apply_stealth(page)
                    _inject_manual_stealth(page)
                    inject_popup_prevention(page)
                    try:
                        wait_strategy = "networkidle" if proxy_config else "domcontentloaded"
                        response = page.goto(url, wait_until=wait_strategy, timeout=90000)
                        if response and response.status in PERMANENT_ERROR_CODES:
                            logger.warning(
                                "CDP page returned HTTP %d for %s on attempt %d — skipping",
                                response.status, url, attempt + 1,
                            )
                            continue
                        page_title = (page.title() or "").strip()
                        if any(bot_word in page_title.lower() for bot_word in BOT_TITLE_MARKERS):
                            logger.warning("CDP bot challenge title detected for %s on attempt %d: %s", url, attempt + 1, page_title)
                            try:
                                page.close()
                            except Exception:
                                pass
                            had_captcha = True
                            continue
                        try:
                            page.wait_for_selector(
                                '[itemprop="price"], [data-price], .a-price, [class*="price"]',
                                timeout=8000,
                            )
                        except Exception as exc:
                            logger.debug("Initial price selector wait failed on CDP page: %s", exc)
                    except Exception as e:
                        logger.debug("CDP page.goto failed on attempt %d: %s", attempt + 1, e)
                        continue

                    _anti_bot_sleep(0.3, 0.8)

                    # Check if page is still alive after anti-bot sleep
                    try:
                        if page.is_closed():
                            logger.warning("CDP page closed during anti-bot sleep for %s on attempt %d", url, attempt + 1)
                            continue
                    except Exception:
                        continue

                    if time.time() > wall_deadline:
                        logger.warning("CDP max wall time reached before popup handling for %s", url)
                        break

                    handle_all_popups(page, url)

                    issues = _detect_page_issues(page)
                    if issues["is_captcha"] or issues["is_blocked"]:
                        issue_type = "CAPTCHA" if issues["is_captcha"] else "blocked"
                        logger.warning(
                            "CDP %s detected on attempt %d for %s - retrying with new IP",
                            issue_type,
                            attempt + 1,
                            url,
                        )
                        try:
                            page.close()
                        except Exception:
                            pass
                        had_captcha = True
                        continue

                    content_loaded = _wait_for_real_content(page, timeout_seconds=15)
                    if not content_loaded:
                        try:
                            page.reload(timeout=30000)
                        except Exception as exc:
                            logger.debug("CDP page reload failed after empty content: %s", exc)
                        time.sleep(1)
                        handle_all_popups(page, url)
                        content_loaded = _wait_for_real_content(page, timeout_seconds=10)

                    if not content_loaded:
                        logger.warning("Chrome CDP scrape: content did not load for %s", url)
                        continue

                    had_real_content = True
                    if time.time() <= wall_deadline:
                        if per_attempt_context:
                            _simulate_human_behavior(page, duration_seconds=2.0)
                        handle_all_popups(page, url, is_recheck=True)
                    else:
                        logger.info("CDP wall-clock timeout reached for %s — skipping simulation/recheck, proceeding to extraction", url)
                    if _cookie_banner_present(page):
                        _log_popup_failure_evidence(page, url=url, popup_type="cookie", attempted_actions=["pre-extraction recheck"])
                    elif _popup_present(page):
                        _log_popup_failure_evidence(page, url=url, popup_type="popup", attempted_actions=["pre-extraction recheck"])

                    name_text = "Unknown Product"
                    try:
                        for title_sel in _PRODUCT_TITLE_SELECTORS:
                            try:
                                loc = page.locator(title_sel)
                                if loc.count() > 0 and loc.first.is_visible(timeout=500):
                                    candidate = loc.first.inner_text(timeout=2000).strip()
                                    if (
                                        candidate
                                        and 5 <= len(candidate) <= 300
                                        and "keyboard shortcut" not in candidate.lower()
                                        and "shift + alt" not in candidate.lower()
                                        and "aria" not in candidate.lower()[:20]
                                    ):
                                        name_text = candidate
                                        break
                            except Exception:
                                continue

                        if name_text == "Unknown Product" and page.locator("h1").count() > 0:
                            candidate = page.locator("h1").first.inner_text(timeout=2000).strip()
                            if (
                                candidate
                                and 5 <= len(candidate) <= 300
                                and "keyboard shortcut" not in candidate.lower()
                                and "shift + alt" not in candidate.lower()
                            ):
                                name_text = candidate
                    except Exception as exc:
                        logger.warning("Failed to extract product name in CDP page: %s", exc)
                    if not name_text or name_text == "Unknown Product":
                        name_text = (page.title() or "Unknown Product").strip()
                        for suffix in [
                            " - Amazon.com",
                            " | Target",
                            " | Best Buy",
                            " - Walmart.com",
                            " | Walmart",
                        ]:
                            if name_text.endswith(suffix):
                                name_text = name_text[:-len(suffix)].strip()
                                break

                    extracted_prices = _extract_prices_from_page(
                        page,
                        url,
                        custom_selector=custom_selector,
                        original_price_selector=original_price_selector,
                    )
                    price = extracted_prices.get("price")

                    if price is not None:
                        currency_code = _extract_currency_code_from_page(page, url)
                        try:
                            cdp_html = page.content()
                            cdp_soup = BeautifulSoup(cdp_html, "lxml")
                            site_name_text = _extract_site_name_from_soup(cdp_soup, url)
                        except Exception:
                            site_name_text = None
                        return {
                            "name": name_text,
                            "site_name": site_name_text,
                            "price": price,
                            "original_price": extracted_prices.get("original_price"),
                            "currency_code": currency_code,
                            "selector_worked": extracted_prices.get("selector_worked", True),
                        }
                finally:
                    try:
                        if page:
                            page.close()
                    except Exception as exc:
                        logger.debug("Failed to close CDP page: %s", exc)
                    if per_attempt_context:
                        try:
                            if context:
                                context.close()
                        except Exception as exc:
                            logger.debug("Failed to close per-attempt CDP context: %s", exc)
        finally:
            try:
                if shared_context:
                    shared_context.close()
            except Exception as exc:
                logger.debug("Failed to close shared CDP context: %s", exc)

        if not had_real_content and not had_captcha:
            # CDP is reachable but not yielding usable pages right now; avoid raising UI_CHANGED.
            _mark_cdp_unhealthy(45.0)
        if had_captcha:
            return {
                "status": "captcha_blocked",
                "error": (
                    f"CAPTCHA detected on {scraped_domain} after {max_attempts} attempts. "
                    f"Trying next proxy or will retry later."
                ),
                "domain": scraped_domain,
                "source": "chrome_cdp",
            }
        return None

    except Exception as exc:
        logger.warning("Chrome CDP scrape failed: %s", exc)
        _mark_cdp_unhealthy(15.0)
        return None
    finally:
        try:
            if browser:
                browser.close()
        except Exception as exc:
            logger.debug("Failed to close CDP browser handle: %s", exc)
        try:
            if pw:
                pw.stop()
        except Exception as exc:
            logger.debug("Failed to stop Playwright in CDP cleanup: %s", exc)


def _update_tracked_product_price(
    url: str,
    price: float,
    original_price: Optional[float] = None,
    product_name: Optional[str] = None,
    currency_code: Optional[str] = None,
    user_id: Optional[str] = None,
    site_name: Optional[str] = None,
):
    """Update current_price on tracked_products if the URL is tracked."""
    try:
        with SessionLocal() as db:
            tp = _find_tracked_product_by_url(db, url, user_id=user_id)
            if tp:
                old_price = tp.current_price
                tp.current_price = price
                tp.original_price = original_price
                tp.last_checked = datetime.datetime.now(datetime.timezone.utc)
                tp.ui_changed = False
                tp.selector_fail_count = 0
                tp.currency_code = normalize_currency_code(currency_code or tp.currency_code or _guess_currency_code_from_url(url))
                if product_name and product_name != "Unknown Product":
                    tp.product_name = product_name
                if site_name and not tp.site_name:
                    tp.site_name = site_name

                # Queue email alert if price crossed below threshold
                if (
                    tp.threshold is not None
                    and tp.threshold > 0
                    and price <= tp.threshold
                    and tp.user_id
                    and (old_price is None or old_price > tp.threshold)
                ):
                    _queue_price_alert(
                        db,
                        user_id=tp.user_id,
                        url=tp.url,
                        product_name=tp.product_name,
                        old_price=old_price,
                        new_price=price,
                        threshold=tp.threshold,
                        currency_code=tp.currency_code,
                    )

                db.commit()
    except SQLAlchemyError as exc:
        logger.exception("Failed to update tracked product price: %s", exc)


def _queue_price_alert(
    db,
    user_id: str,
    url: str,
    product_name: Optional[str],
    old_price: Optional[float],
    new_price: float,
    threshold: float,
    currency_code: Optional[str],
):
    """Queue a price alert for email delivery."""
    try:
        settings = db.query(EmailAlertSettings).filter(
            EmailAlertSettings.user_id == user_id
        ).first()
        if settings and not settings.enabled:
            return

        alert = PriceAlert(
            user_id=user_id,
            url=url,
            product_name=product_name or "Unknown Product",
            old_price=old_price,
            new_price=new_price,
            threshold=threshold,
            currency_code=currency_code,
        )
        db.add(alert)
        logger.info(
            "price_alert_queued user=%s domain=%s price=%s threshold=%s",
            user_id,
            _get_domain(url),
            new_price,
            threshold,
        )
    except Exception as exc:
        logger.warning("Failed to queue price alert: %s", exc)


def _send_alert_email(to_emails: List[str], subject: str, html_body: str) -> bool:
    """Send an email via Resend API."""
    if not _RESEND_AVAILABLE:
        logger.warning("Email send skipped: resend package not installed")
        return False
    if not RESEND_API_KEY:
        logger.info("Email send skipped: RESEND_API_KEY not configured")
        return False
    if not to_emails:
        logger.info("Email send skipped: no recipients")
        return False
    try:
        params = {
            "from": EMAIL_FROM,
            "to": to_emails,
            "subject": subject,
            "html": html_body,
        }
        r = resend.Emails.send(params)
        logger.info("alert_email_sent via=resend to=%s subject=%s id=%s", to_emails, subject[:60], r.get("id"))
        return True
    except Exception as exc:
        logger.warning("Failed to send alert email via Resend: %s", exc)
        return False


def _build_alert_digest_html(alerts: List[PriceAlert], user_email: str) -> str:
    """Build a simple HTML email body for a batch of price alerts."""
    rows = []
    for a in alerts:
        symbol = _currency_symbol_from_code(a.currency_code)
        old_str = f"{symbol}{a.old_price:.2f}" if a.old_price is not None else "N/A"
        new_str = f"{symbol}{a.new_price:.2f}"
        threshold_str = f"{symbol}{a.threshold:.2f}"
        domain = _get_domain(a.url)
        rows.append(
            f'<tr>'
            f'<td style="padding:8px;border-bottom:1px solid #eee;">'
            f'<a href="{a.url}" style="color:#5636ef;text-decoration:none;">{a.product_name or "Product"}</a>'
            f'<br><span style="color:#999;font-size:12px;">{domain}</span></td>'
            f'<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">{old_str}</td>'
            f'<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#cc0000;font-weight:700;">{new_str}</td>'
            f'<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">{threshold_str}</td>'
            f'</tr>'
        )
    table_rows = "\n".join(rows)
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#7056f6,#5636ef);padding:20px;border-radius:12px 12px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:1px;">TRAKER</h1>
            <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;">Price Drop Alert</p>
        </div>
        <div style="padding:20px;background:#fff;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
            <p>Hi! {len(alerts)} product(s) dropped below your threshold:</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <thead>
                    <tr style="background:#f8f7ff;">
                        <th style="padding:8px;text-align:left;font-size:12px;color:#666;">Product</th>
                        <th style="padding:8px;text-align:right;font-size:12px;color:#666;">Was</th>
                        <th style="padding:8px;text-align:right;font-size:12px;color:#666;">Now</th>
                        <th style="padding:8px;text-align:right;font-size:12px;color:#666;">Threshold</th>
                    </tr>
                </thead>
                <tbody>
                    {table_rows}
                </tbody>
            </table>
            <a href="https://traker.azurewebsites.net/?tab=droplist"
               style="display:inline-block;background:#5636ef;color:#fff;padding:10px 24px;
                      border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px;">
                View Droplist
            </a>
            <p style="color:#999;font-size:12px;margin-top:20px;">
                You're receiving this because you enabled email alerts on Traker.
                <br>Sent to: {user_email}
            </p>
        </div>
    </div>
    """


def _extension_available(user_id: Optional[str] = None, ttl_seconds: float = EXTENSION_HEARTBEAT_TTL_SECONDS) -> bool:
    """Check if a specific user's extension is online, or any extension if user_id is None."""
    now = time.time()
    with _EXTENSION_HEARTBEAT_LOCK:
        if user_id is not None:
            last_seen = _EXTENSION_HEARTBEATS.get(user_id, 0.0)
            return (now - last_seen) < ttl_seconds
        # No user specified - check if ANY extension is alive (for general availability checks)
        return any((now - ts) < ttl_seconds for ts in _EXTENSION_HEARTBEATS.values())


def _build_scrape_response(
    name,
    price,
    currency_code,
    selector,
    source,
    *,
    original_price: Optional[float] = None,
    original_price_selector: Optional[str] = None,
    site_name: Optional[str] = None,
):
    return {
        "name": name,
        "site_name": site_name,
        "price": price,
        "original_price": original_price,
        "currency_code": currency_code,
        "currency_symbol": _currency_symbol_from_code(currency_code),
        "display_price": _format_display_price(price, currency_code),
        "custom_selector": selector,
        "original_price_selector": original_price_selector,
        "source": source,
    }


@app.post("/scrape")
def scrape_price(product: ProductRequest, caller: User = Depends(get_current_user)):
    caller_user_id = str(caller.id)
    latest_selectors = _get_latest_selectors_for_url(product.url, user_id=caller_user_id)
    effective_selector = _normalize_selector_value(product.custom_selector) or latest_selectors.get("custom_selector")
    effective_original_selector = _normalize_selector_value(product.original_price_selector) or latest_selectors.get(
        "original_price_selector"
    )
    scraped_hostname = urlparse(product.url).hostname
    logger.info(
        "scrape_start user=%s domain=%s url=%s skip_ext=%s",
        caller_user_id,
        scraped_hostname,
        product.url[:120],
        product.skip_extension,
    )

    if ENABLE_TIER_1_HTTP:
        http_result = try_http_first(
            product.url,
            custom_selector=effective_selector,
            original_price_selector=effective_original_selector,
        )
        if http_result.get("ok"):
            if not http_result.get("selector_worked") and http_result.get("price") is not None and effective_selector:
                logger.warning(
                    "scrape_selector_drift tier=http domain=%s user=%s — selector failed, fallback found price",
                    scraped_hostname, caller_user_id,
                )
            name = http_result["name"]
            site_name = http_result.get("site_name")
            final_price = float(http_result["price"])
            original_price = http_result.get("original_price")
            currency_code = normalize_currency_code(http_result.get("currency_code") or _guess_currency_code_from_url(product.url))

            _save_price_history(
                product_name=name,
                url=product.url,
                price=final_price,
                original_price=original_price,
                currency_code=currency_code,
                custom_selector=effective_selector,
                original_price_selector=effective_original_selector,
                ui_changed=False,
                user_id=caller_user_id,
            )
            _update_tracked_product_price(
                product.url,
                final_price,
                original_price,
                name,
                currency_code=currency_code,
                user_id=caller_user_id,
                site_name=site_name,
            )
            logger.info("scrape_success tier=http domain=%s user=%s", scraped_hostname, caller_user_id)

            return _build_scrape_response(
                name,
                final_price,
                currency_code,
                effective_selector,
                "http",
                original_price=original_price,
                original_price_selector=effective_original_selector,
                site_name=site_name,
            )

        logger.info("HTTP-first failed; trying curl_cffi. Reason: %s", http_result.get("reason"))
    else:
        logger.info("tier_skip tier=http reason=disabled domain=%s user=%s", scraped_hostname, caller_user_id)

    # Tier 2: curl_cffi with Chrome TLS impersonation (fast, no browser)
    if ENABLE_TIER_2_CFFI and cffi_requests:
        cffi_headers = {
            "Referer": "https://www.google.com/",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "Cache-Control": "max-age=0",
        }
        cffi_max_attempts = 2
        cffi_retry_statuses = {429, 500, 502, 503, 504}
        cffi_sessions: Dict[str, Any] = {}
        try:
            for attempt in range(cffi_max_attempts):
                retryable_status_seen = False
                successful_html: Optional[str] = None
                successful_soup: Optional["BeautifulSoup"] = None
                successful_title: str = "Unknown Product"
                successful_site_name: Optional[str] = None
                for profile in CFFI_IMPERSONATIONS:
                    try:
                        cffi_session = cffi_sessions.get(profile)
                        if cffi_session is None:
                            cffi_session = cffi_requests.Session()
                            cffi_sessions[profile] = cffi_session

                        cffi_resp = cffi_session.get(
                            product.url,
                            impersonate=profile,
                            headers=cffi_headers,
                            allow_redirects=True,
                            timeout=30,
                        )
                    except Exception as exc:
                        logger.warning("curl_cffi scrape failed (attempt=%d, profile=%s): %s", attempt + 1, profile, exc)
                        continue

                    status_code = cffi_resp.status_code
                    if status_code >= 400:
                        if status_code in cffi_retry_statuses:
                            retryable_status_seen = True
                        continue

                    html = cffi_resp.text or ""
                    if _looks_blocked_html(html):
                        continue

                    logger.info("curl_cffi succeeded with profile %s on attempt %d", profile, attempt + 1)
                    successful_html = html
                    successful_soup = BeautifulSoup(html, "lxml")
                    successful_title = (successful_soup.title.get_text(strip=True) if successful_soup.title else "") or "Unknown Product"
                    successful_site_name = _extract_site_name_from_soup(successful_soup, product.url)
                    break

                if successful_html is not None and successful_soup is not None:
                    extracted_prices = _extract_prices_from_html(
                        successful_html,
                        product.url,
                        custom_selector=effective_selector,
                        original_price_selector=effective_original_selector,
                        soup=successful_soup,
                    )
                    price = extracted_prices.get("price")
                    if not extracted_prices.get("selector_worked") and extracted_prices.get("price") is not None and effective_selector:
                        logger.warning(
                            "scrape_selector_drift tier=curl_cffi domain=%s user=%s — selector failed, fallback found price",
                            scraped_hostname, caller_user_id,
                        )
                    if price is not None:
                        original_price = extracted_prices.get("original_price")
                        currency_code = _extract_currency_code_from_soup(successful_soup, product.url)
                        _save_price_history(
                            product_name=successful_title,
                            url=product.url,
                            price=price,
                            original_price=original_price,
                            currency_code=currency_code,
                            custom_selector=effective_selector,
                            original_price_selector=effective_original_selector,
                            ui_changed=False,
                            user_id=caller_user_id,
                        )
                        _update_tracked_product_price(
                            product.url,
                            price,
                            original_price,
                            successful_title,
                            currency_code=currency_code,
                            user_id=caller_user_id,
                            site_name=successful_site_name,
                        )
                        logger.info("scrape_success tier=curl_cffi domain=%s user=%s", scraped_hostname, caller_user_id)
                        return _build_scrape_response(
                            successful_title,
                            price,
                            currency_code,
                            effective_selector,
                            "curl_cffi",
                            original_price=original_price,
                            original_price_selector=effective_original_selector,
                            site_name=successful_site_name,
                        )
                    logger.info(
                        "curl_cffi fetched HTML successfully but failed to extract a price for %s",
                        product.url,
                    )
                    break

                if retryable_status_seen and attempt < cffi_max_attempts - 1:
                    _retry_sleep(attempt)
                    continue
                break
        finally:
            for cffi_session in cffi_sessions.values():
                try:
                    cffi_session.close()
                except Exception:
                    pass
    else:
        logger.info("tier_skip tier=curl_cffi reason=disabled domain=%s user=%s", scraped_hostname, caller_user_id)

    # Tier 3: Browser extension (non-blocking)
    # skip_extension=True prevents recursive loops when the extension itself calls /scrape
    if ENABLE_TIER_3_EXTENSION and not product.skip_extension and _extension_available(user_id=caller_user_id):
        extension_job_id: Optional[int] = None
        try:
            with SessionLocal() as db:
                pending_job_query = db.query(ExtensionJob).filter(
                    ExtensionJob.url == product.url,
                    ExtensionJob.status.in_(["pending", "in_progress"]),
                )
                if caller_user_id is not None:
                    pending_job_query = pending_job_query.filter(ExtensionJob.user_id == caller_user_id)
                pending_job = pending_job_query.order_by(ExtensionJob.created_at.asc()).first()
                if pending_job:
                    extension_job_id = pending_job.id
                else:
                    # Limit pending+in_progress jobs per domain to prevent flooding
                    job_domain = _get_domain(product.url)
                    domain_limit_reached = False
                    if job_domain:
                        domain_job_count = db.query(ExtensionJob).filter(
                            ExtensionJob.user_id == caller_user_id,
                            ExtensionJob.status.in_(["pending", "in_progress"]),
                            ExtensionJob.normalized_host == job_domain,
                        ).count()
                        if domain_job_count >= 3:
                            logger.info(
                                "Tier 3 domain rate limit: %d active jobs for %s; falling through to CDP",
                                domain_job_count,
                                job_domain,
                            )
                            domain_limit_reached = True

                    if not domain_limit_reached:
                        job = ExtensionJob(
                            url=product.url,
                            normalized_host=_normalized_host(product.url),
                            custom_selector=effective_selector,
                            original_price_selector=effective_original_selector,
                            user_id=caller_user_id,
                        )
                        db.add(job)
                        db.commit()
                        db.refresh(job)
                        extension_job_id = job.id
        except SQLAlchemyError as exc:
            logger.exception("Failed to enqueue extension job for %s: %s", product.url, exc)

        if extension_job_id is not None:
            logger.info(
                "scrape_pending tier=extension job_id=%d domain=%s user=%s url=%s",
                extension_job_id,
                scraped_hostname,
                caller_user_id,
                product.url[:120],
            )
            return {
                "status": "pending",
                "job_id": extension_job_id,
                "source": "extension",
                "custom_selector": effective_selector,
                "original_price_selector": effective_original_selector,
                "message": "Extension job queued. Poll /scrape/status/{job_id} for results.",
            }
    elif not ENABLE_TIER_3_EXTENSION:
        logger.info("tier_skip tier=extension reason=disabled domain=%s user=%s", scraped_hostname, caller_user_id)
    elif product.skip_extension:
        logger.info("tier_skip tier=extension reason=skip_extension domain=%s user=%s", scraped_hostname, caller_user_id)
    else:
        logger.info("tier_skip tier=extension reason=unavailable domain=%s user=%s", scraped_hostname, caller_user_id)

    # Tier 4: Remote Chrome container via CDP (with on-demand ACI start)
    if _is_domain_captcha_blocked(scraped_hostname):
        remaining = _get_captcha_cooldown_remaining(scraped_hostname)
        logger.info(
            "tier_skip tier=chrome_cdp reason=captcha_cooldown domain=%s user=%s remaining=%d",
            scraped_hostname,
            caller_user_id,
            int(remaining),
        )
        return {
            "status": "captcha_blocked",
            "error": (
                f"CAPTCHA protection detected on {scraped_hostname}. "
                f"Use the browser extension to check this price. "
                f"CDP will retry automatically in {int(remaining // 60)} minutes."
            ),
            "domain": scraped_hostname,
            "cooldown_remaining": remaining,
            "source": "chrome_cdp",
        }

    cdp_healthy = _cdp_endpoint_healthy()

    if not cdp_healthy and ENABLE_ACI_AUTO_START and _AZURE_SDK_AVAILABLE and ACI_SUBSCRIPTION_ID:
        logger.info(
            "CDP not healthy — attempting to start ACI container for domain=%s user=%s",
            scraped_hostname,
            caller_user_id,
        )
        aci_started = _start_aci_container()
        if aci_started:
            cdp_healthy = True
            logger.info("ACI container started successfully, proceeding with CDP scrape")
        else:
            logger.warning("ACI container failed to start for domain=%s user=%s", scraped_hostname, caller_user_id)

    cached_cdp_endpoint = _get_cached_cdp_endpoint() if cdp_healthy else None
    if cdp_healthy:
        _touch_aci_idle_timer()
        logger.info("tier_fallback tier=chrome_cdp domain=%s user=%s", scraped_hostname, caller_user_id)
        proxy_list = _get_cdp_proxy_list()
        cdp_result = None
        proxy_attempts = [3, 2, 1]
        try:
            for proxy_idx, proxy_cfg in enumerate(proxy_list):
                proxy_label = "direct" if proxy_cfg is None else ("primary_proxy" if proxy_idx == 0 else "fallback_proxy")
                is_last_proxy = proxy_idx == len(proxy_list) - 1
                attempts_for_this_proxy = proxy_attempts[proxy_idx] if proxy_idx < len(proxy_attempts) else 1
                try:
                    logger.info("CDP attempt with %s (%d max attempts) for domain=%s", proxy_label, attempts_for_this_proxy, scraped_hostname)
                    cdp_result = _scrape_with_chrome_cdp(
                        product.url,
                        custom_selector=effective_selector,
                        original_price_selector=effective_original_selector,
                        resolved_cdp_endpoint=cached_cdp_endpoint,
                        proxy_config=proxy_cfg,
                        skip_captcha_check=True,
                        max_attempts_override=attempts_for_this_proxy,
                    )
                    if cdp_result is not None:
                        if cdp_result.get("price"):
                            logger.info("CDP %s got price for domain=%s", proxy_label, scraped_hostname)
                            break
                        if cdp_result.get("status") in ("captcha_blocked", "bot_blocked"):
                            if is_last_proxy:
                                logger.info(
                                    "CDP %s blocked on domain=%s (final attempt, returning to user)",
                                    proxy_label,
                                    scraped_hostname,
                                )
                                break
                            logger.info("CDP %s blocked on domain=%s, trying next proxy", proxy_label, scraped_hostname)
                            continue
                        logger.info("CDP %s returned no price for domain=%s, trying next proxy", proxy_label, scraped_hostname)
                        continue
                    logger.info(
                        "CDP %s returned None for domain=%s (possible proxy auth failure or timeout), trying next",
                        proxy_label,
                        scraped_hostname,
                    )
                except Exception as exc:
                    logger.warning("CDP %s failed for domain=%s: %s", proxy_label, scraped_hostname, exc)
                    if is_last_proxy:
                        logger.warning("All CDP proxy attempts exhausted for domain=%s", scraped_hostname)
                    continue
            if cdp_result:
                if cdp_result.get("status") in ("bot_blocked", "captcha_blocked"):
                    _mark_domain_captcha_blocked(scraped_hostname)
                    logger.info(
                        "scrape_%s tier=%s domain=%s — all proxies failed, cooldown set for %d seconds",
                        cdp_result["status"], "chrome_cdp", scraped_hostname, int(CAPTCHA_COOLDOWN_SECONDS),
                    )
                    return {
                        "status": "captcha_blocked",
                        "error": (
                            f"CAPTCHA protection detected on {scraped_hostname}. "
                            f"All proxy attempts exhausted. "
                            f"Use the browser extension to check this price. "
                            f"CDP will retry automatically in {int(CAPTCHA_COOLDOWN_SECONDS // 60)} minutes."
                        ),
                        "domain": scraped_hostname,
                        "cooldown_remaining": CAPTCHA_COOLDOWN_SECONDS,
                        "source": "chrome_cdp",
                    }
                if not cdp_result.get("selector_worked") and effective_selector:
                    logger.warning(
                        "scrape_selector_drift tier=chrome_cdp domain=%s user=%s — selector failed, fallback found price",
                        scraped_hostname, caller_user_id,
                    )
                currency_code = normalize_currency_code(cdp_result.get("currency_code") or _guess_currency_code_from_url(product.url))
                original_price = cdp_result.get("original_price")
                _save_price_history(
                    product_name=cdp_result["name"],
                    url=product.url,
                    price=cdp_result["price"],
                    original_price=original_price,
                    currency_code=currency_code,
                    custom_selector=effective_selector,
                    original_price_selector=effective_original_selector,
                    ui_changed=False,
                    user_id=caller_user_id,
                )
                _update_tracked_product_price(
                    product.url,
                    cdp_result["price"],
                    original_price,
                    cdp_result["name"],
                    currency_code=currency_code,
                    user_id=caller_user_id,
                    site_name=cdp_result.get("site_name"),
                )
                logger.info("scrape_success tier=chrome_cdp domain=%s user=%s", scraped_hostname, caller_user_id)
                return _build_scrape_response(
                    cdp_result["name"],
                    cdp_result["price"],
                    currency_code,
                    effective_selector,
                    "chrome_cdp",
                    original_price=original_price,
                    original_price_selector=effective_original_selector,
                    site_name=cdp_result.get("site_name"),
                )
        except Exception as exc:
            logger.warning("Chrome CDP scrape failed: %s", exc)
    else:
        logger.warning("tier_skip tier=chrome_cdp reason=unhealthy domain=%s user=%s", scraped_hostname, caller_user_id)

    cdp_healthy_after_attempt = _cdp_endpoint_healthy(ttl_seconds=0.0)
    if effective_selector and not cdp_healthy_after_attempt:
        return {
            "error": "Browser fallback is temporarily unavailable. Your selector was saved; try Manual Price Check again shortly."
        }

    if effective_selector:
        try:
            with SessionLocal() as db:
                tp = _find_tracked_product_by_url(db, product.url, user_id=caller_user_id)
                if tp:
                    tp.selector_fail_count = (tp.selector_fail_count or 0) + 1
                    fail_count = tp.selector_fail_count
                    if fail_count >= 3:
                        tp.ui_changed = True
                        _set_ui_changed_for_url(product.url, True, user_id=caller_user_id)
                        db.commit()
                        logger.warning(
                            "scrape_ui_changed domain=%s user=%s url=%s fail_count=%d",
                            scraped_hostname, caller_user_id, product.url[:120], fail_count,
                        )
                        raise _ui_changed_http_exception(
                            "Custom selector failed across all scrape methods. Website layout may have changed."
                        )
                    else:
                        db.commit()
                        logger.warning(
                            "scrape_selector_failed domain=%s user=%s url=%s fail_count=%d (threshold=3)",
                            scraped_hostname, caller_user_id, product.url[:120], fail_count,
                        )
                        return {
                            "error": f"Price not found this check (attempt {fail_count}/3). Will retry before flagging as changed.",
                            "selector_fail_count": fail_count,
                        }
                else:
                    # No tracked product found - flag immediately since there's no counter to track
                    _set_ui_changed_for_url(product.url, True, user_id=caller_user_id)
                    logger.warning(
                        "scrape_ui_changed domain=%s user=%s url=%s (no tracked product)",
                        scraped_hostname, caller_user_id, product.url[:120],
                    )
                    raise _ui_changed_http_exception(
                        "Custom selector failed across all scrape methods. Website layout may have changed."
                    )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Failed to update selector fail count: %s", exc)
            # Fall through to generic error if counter update fails

    logger.warning("scrape_failed domain=%s user=%s url=%s", scraped_hostname, caller_user_id, product.url[:120])
    return {"error": "Price not found on page. The page structure may have changed."}


@app.get("/scrape/status/{job_id}")
def scrape_status(job_id: int, caller: User = Depends(get_current_user)):
    """Poll for the result of a non-blocking extension scrape job."""
    try:
        with SessionLocal() as db:
            job = db.query(ExtensionJob).filter(ExtensionJob.id == job_id).first()
            if not job:
                return {"status": "not_found", "job_id": job_id}
            if job.user_id and job.user_id != str(caller.id):
                return {"status": "not_found", "job_id": job_id}

            if job.status == "pending":
                return {"status": "pending", "job_id": job_id}

            if job.status == "in_progress":
                return {"status": "pending", "job_id": job_id}

            if job.status == "failed":
                return {
                    "status": "failed",
                    "job_id": job_id,
                    "error_reason": job.error_reason,
                    "retry_hint": "Retry with skip_extension=true to use CDP fallback.",
                }

            if job.status == "done" and job.result_price is not None:
                currency_code = normalize_currency_code(
                    job.result_currency or _guess_currency_code_from_url(job.url)
                )
                return {
                    "status": "done",
                    "job_id": job_id,
                    "name": job.result_name or "Unknown Product",
                    "site_name": job.result_site_name,
                    "price": float(job.result_price),
                    "original_price": float(job.result_original_price) if job.result_original_price is not None else None,
                    "currency_code": currency_code,
                    "currency_symbol": _currency_symbol_from_code(currency_code),
                    "display_price": _format_display_price(float(job.result_price), currency_code),
                    "custom_selector": job.custom_selector,
                    "original_price_selector": job.original_price_selector,
                    "source": "extension",
                }

            return {"status": "failed", "job_id": job_id, "error_reason": getattr(job, "error_reason", None)}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to check scrape status for job %d: %s", job_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/captcha-cooldowns")
def get_captcha_cooldowns(user: User = Depends(get_current_user)):
    """Show which domains are currently in CAPTCHA cooldown."""
    with _CAPTCHA_COOLDOWN_LOCK:
        now = time.time()
        active = {}
        for domain, expires in _CAPTCHA_COOLDOWN.items():
            remaining = expires - now
            if remaining > 0:
                active[domain] = {
                    "remaining_seconds": round(remaining),
                    "remaining_minutes": round(remaining / 60, 1),
                    "expires_at": datetime.datetime.fromtimestamp(expires).isoformat(),
                }
        return {"cooldowns": active}


@app.delete("/captcha-cooldowns/{domain}")
def clear_captcha_cooldown(domain: str, user: User = Depends(get_current_user)):
    """Manually clear CAPTCHA cooldown for a domain (e.g. after solving in browser)."""
    with _CAPTCHA_COOLDOWN_LOCK:
        removed = _CAPTCHA_COOLDOWN.pop(domain, None)
    if removed:
        logger.info("CAPTCHA cooldown manually cleared for domain: %s", domain)
        return {"ok": True, "message": f"Cooldown cleared for {domain}"}
    return {"ok": True, "message": f"No active cooldown for {domain}"}


@app.get("/aci/status")
def aci_status(user: User = Depends(get_current_user)):
    """Check the status of the on-demand Chrome ACI container."""
    if not _AZURE_SDK_AVAILABLE:
        return {"error": "Azure SDK not installed", "enabled": False}
    if not ACI_SUBSCRIPTION_ID:
        return {"error": "ACI_SUBSCRIPTION_ID not configured", "enabled": False}

    state = _get_aci_container_state()
    cdp_healthy = _cdp_endpoint_healthy(ttl_seconds=0.0)

    with _ACI_LAST_CDP_REQUEST_LOCK:
        last_request = _ACI_LAST_CDP_REQUEST

    idle_seconds = time.time() - last_request if last_request > 0 else None

    return {
        "enabled": ENABLE_ACI_AUTO_START,
        "container_group": ACI_CONTAINER_GROUP_NAME,
        "provisioning_state": state["provisioning_state"],
        "container_state": state["container_state"],
        "ip": state["ip"],
        "cdp_url": CHROME_CDP_URL,
        "cdp_healthy": cdp_healthy,
        "idle_seconds": round(idle_seconds) if idle_seconds else None,
        "idle_timeout_seconds": ACI_IDLE_TIMEOUT_SECONDS,
        "proxy_primary_configured": bool(CDP_PROXY_PRIMARY_URL.strip()),
        "proxy_fallback_configured": bool(CDP_PROXY_FALLBACK_URL.strip()),
        "proxy_enabled": CDP_PROXY_ENABLED,
    }


@app.post("/aci/start")
def aci_start(user: User = Depends(get_current_user)):
    """Manually start the Chrome ACI container."""
    if not _AZURE_SDK_AVAILABLE or not ACI_SUBSCRIPTION_ID:
        return {"error": "ACI not configured"}
    started = _start_aci_container()
    if started:
        _touch_aci_idle_timer()
    return {"started": started, "cdp_url": CHROME_CDP_URL}


@app.post("/aci/stop")
def aci_stop(user: User = Depends(get_current_user)):
    """Manually stop the Chrome ACI container."""
    if not _AZURE_SDK_AVAILABLE or not ACI_SUBSCRIPTION_ID:
        return {"error": "ACI not configured"}
    _stop_aci_container()
    return {"stopped": True}


@app.post("/extension/heartbeat")
def extension_heartbeat(
    payload: Optional[ExtensionHeartbeatPayload] = None,
    user: User = Depends(get_current_user),
):
    user_key = str(user.id)
    with _EXTENSION_HEARTBEAT_LOCK:
        if payload is not None and payload.active is False:
            _EXTENSION_HEARTBEATS.pop(user_key, None)
        else:
            _EXTENSION_HEARTBEATS[user_key] = time.time()
        # Purge stale entries to prevent unbounded growth
        if len(_EXTENSION_HEARTBEATS) > 100:
            now = time.time()
            stale = [k for k, v in _EXTENSION_HEARTBEATS.items() if (now - v) > EXTENSION_HEARTBEAT_TTL_SECONDS * 2]
            for k in stale:
                del _EXTENSION_HEARTBEATS[k]
    return {"ok": True}


@app.get("/extension/jobs")
def extension_jobs(user: User = Depends(get_current_user)):
    try:
        with SessionLocal() as db:
            _cleanup_extension_jobs(db)
            db.commit()
            jobs: List[ExtensionJob] = (
                db.query(ExtensionJob)
                .filter(
                    ExtensionJob.status == "pending",
                    ExtensionJob.user_id == str(user.id),
                )
                .order_by(ExtensionJob.created_at.asc())
                .limit(5)
                .all()
            )
            now = datetime.datetime.now(datetime.timezone.utc)
            for job in jobs:
                job.status = "in_progress"
                job.claimed_at = now
                job.attempts = (job.attempts or 0) + 1
            db.commit()
            return [
                {
                    "id": job.id,
                    "url": job.url,
                    "custom_selector": job.custom_selector,
                    "original_price_selector": job.original_price_selector,
                }
                for job in jobs
            ]
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch extension jobs: %s", exc)
        return []


@app.post("/extension/jobs/{job_id}/complete")
def extension_job_complete(
    job_id: int,
    report: ExtensionJobCompleteRequest,
    user: User = Depends(get_current_user),
):
    logger.info("job_complete_start job_id=%d user=%s failed=%s", job_id, str(user.id), report.failed)
    try:
        job_url: Optional[str] = None
        job_selector: Optional[str] = None
        job_original_selector: Optional[str] = None
        job_user_id: Optional[str] = None
        with SessionLocal() as db:
            _cleanup_extension_jobs(db)
            db.commit()

            job = db.query(ExtensionJob).filter(ExtensionJob.id == job_id).first()
            if not job:
                raise HTTPException(status_code=404, detail="Extension job not found")
            if job.user_id and job.user_id != str(user.id):
                raise HTTPException(status_code=403, detail="Not authorized to complete this job")

            if report.failed:
                current_attempts = job.attempts or 1
                if current_attempts < EXTENSION_JOB_MAX_ATTEMPTS:
                    # Transient failure - reset to pending for retry
                    job.status = "pending"
                    job.claimed_at = None
                    job.error_reason = report.error_reason
                    db.commit()
                    logger.info(
                        "Extension job %d failed (attempt %d/%d), re-queued for retry: %s",
                        job_id,
                        current_attempts,
                        EXTENSION_JOB_MAX_ATTEMPTS,
                        report.error_reason or "unknown",
                    )
                    return {"ok": True, "status": "retrying", "attempts": current_attempts}
                else:
                    # Max attempts exhausted - permanently failed
                    job.status = "failed"
                    job.error_reason = report.error_reason
                    db.commit()
                    return {"ok": True, "status": "failed"}

            if report.price is None:
                raise HTTPException(status_code=400, detail="price is required when failed is false")

            currency_code = normalize_currency_code(
                report.currency_code or _guess_currency_code_from_url(job.url)
            )
            result_name = report.name or "Unknown Product"
            result_site_name = report.site_name
            result_price = float(report.price)
            result_original_price = float(report.original_price) if report.original_price is not None else None
            completed_at = datetime.datetime.now(datetime.timezone.utc)

            job.status = "done"
            job.result_price = result_price
            job.result_original_price = result_original_price
            job.result_name = result_name
            job.result_site_name = result_site_name
            job.result_currency = currency_code
            job.completed_at = completed_at
            if report.selector_fallback:
                logger.warning(
                    "ext_job_selector_fallback job_id=%d domain=%s user=%s — extension used structured data fallback",
                    job_id, _get_domain(job.url), str(user.id),
                )
            job_url = job.url
            job_selector = report.selector or job.custom_selector
            job_original_selector = report.original_selector or job.original_price_selector
            job.original_price_selector = job_original_selector
            job_user_id = job.user_id
            db.commit()

        if not job_url:
            raise HTTPException(status_code=400, detail="Job URL missing")

        _save_price_history(
            product_name=result_name,
            url=job_url,
            price=result_price,
            original_price=result_original_price,
            currency_code=currency_code,
            custom_selector=job_selector,
            original_price_selector=job_original_selector,
            ui_changed=False,
            user_id=job_user_id,
        )
        _update_tracked_product_price(
            job_url,
            result_price,
            result_original_price,
            result_name,
            currency_code=currency_code,
            user_id=job_user_id,
            site_name=result_site_name,
        )
        return {"ok": True, "status": "done"}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to complete extension job: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/extension/price-report")
def extension_price_report(report: ExtensionPriceReport, user: User = Depends(get_current_user)):
    logger.info("ext_price_report user=%s domain=%s price=%s url=%s", str(user.id), _get_domain(report.url), report.price, report.url[:120])
    if report.selector_fallback:
        logger.warning(
            "ext_price_report_selector_fallback user=%s domain=%s — extension used structured data fallback",
            str(user.id), _get_domain(report.url),
        )
    currency_code = normalize_currency_code(
        report.currency_code or _guess_currency_code_from_url(report.url)
    )
    _save_price_history(
        product_name=report.name or "Unknown Product",
        url=report.url,
        price=report.price,
        original_price=report.original_price,
        currency_code=currency_code,
        custom_selector=report.selector,
        original_price_selector=report.original_selector,
        ui_changed=False,
        user_id=str(user.id),
    )
    _update_tracked_product_price(
        report.url,
        report.price,
        report.original_price,
        report.name,
        currency_code=currency_code,
        user_id=str(user.id),
        site_name=report.site_name,
    )
    logger.info(
        "extension_report_success domain=%s user=%s",
        _get_domain(report.url),
        str(user.id),
    )
    return {"ok": True}


@app.get("/extension/products")
def get_extension_products(user: User = Depends(get_current_user)):
    """Return all tracked products with their latest price."""
    try:
        with SessionLocal() as db:
            subquery = (
                db.query(
                    PriceHistory.url,
                    func.max(PriceHistory.timestamp).label("max_ts")
                )
                .filter(
                    PriceHistory.price.isnot(None),
                    PriceHistory.user_id == str(user.id),
                )
                .group_by(PriceHistory.url)
                .subquery()
            )
            rows = (
                db.query(PriceHistory)
                .join(
                    subquery,
                    (PriceHistory.url == subquery.c.url) &
                    (PriceHistory.timestamp == subquery.c.max_ts)
                )
                .filter(PriceHistory.user_id == str(user.id))
                .all()
            )
            return [
                {
                    "url": row.url,
                    "product_name": row.product_name,
                    "price": row.price,
                    "original_price": row.original_price,
                    "currency_code": normalize_currency_code(row.currency_code or _guess_currency_code_from_url(row.url)),
                    "currency_symbol": _currency_symbol_from_code(row.currency_code or _guess_currency_code_from_url(row.url)),
                    "custom_selector": row.custom_selector,
                    "original_price_selector": row.original_price_selector,
                    "timestamp": row.timestamp.isoformat() if row.timestamp else None,
                }
                for row in rows
            ]
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch extension products: %s", exc)
        return []


@app.get("/email-settings", response_model=EmailAlertSettingsResponse)
def get_email_settings(user: User = Depends(get_current_user)):
    """Get the user's email alert settings."""
    try:
        with SessionLocal() as db:
            settings = db.query(EmailAlertSettings).filter(
                EmailAlertSettings.user_id == str(user.id)
            ).first()
            recipients = []
            if settings and settings.recipients:
                recipients = [r.strip() for r in settings.recipients.split(",") if r.strip()]
            return {
                "enabled": settings.enabled if settings else False,
                "recipients": recipients,
                "primary_email": user.email,
            }
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch email settings: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/email-settings")
def update_email_settings(
    payload: EmailAlertSettingsRequest,
    user: User = Depends(get_current_user),
):
    """Update the user's email alert settings."""
    caller_user_id = str(user.id)
    clean_recipients = []
    for email in (payload.recipients or []):
        email = (email or "").strip().lower()
        if email and "@" in email and "." in email:
            clean_recipients.append(email)

    try:
        with SessionLocal() as db:
            settings = db.query(EmailAlertSettings).filter(
                EmailAlertSettings.user_id == caller_user_id
            ).first()
            if settings:
                settings.enabled = payload.enabled if payload.enabled is not None else settings.enabled
                settings.recipients = ",".join(clean_recipients)
                settings.updated_at = datetime.datetime.now(datetime.timezone.utc)
            else:
                settings = EmailAlertSettings(
                    user_id=caller_user_id,
                    enabled=payload.enabled if payload.enabled is not None else True,
                    recipients=",".join(clean_recipients),
                )
                db.add(settings)
            db.commit()
            logger.info(
                "email_settings_updated user=%s enabled=%s recipients=%d",
                caller_user_id,
                settings.enabled,
                len(clean_recipients),
            )
            return {"ok": True, "enabled": settings.enabled, "recipients": clean_recipients}
    except SQLAlchemyError as exc:
        logger.exception("Failed to update email settings: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/email-alerts/send-digest")
def send_alert_digest(user: User = Depends(get_current_user)):
    """
    Send unsent price alerts as a digest email to the user.
    NOTE (Azure migration): This endpoint becomes an Azure Function timer trigger
    that iterates over all users with unsent alerts. The per-user logic stays the same.
    """
    if not EMAIL_ALERTS_ENABLED:
        return {"ok": False, "reason": "Email alerts are disabled server-side."}

    caller_user_id = str(user.id)
    try:
        with SessionLocal() as db:
            settings = db.query(EmailAlertSettings).filter(
                EmailAlertSettings.user_id == caller_user_id
            ).first()
            if not settings or not settings.enabled:
                return {"ok": False, "reason": "Email alerts not enabled for this user."}

            unsent = (
                db.query(PriceAlert)
                .filter(PriceAlert.user_id == caller_user_id, PriceAlert.sent.is_(False))
                .order_by(PriceAlert.created_at.desc())
                .all()
            )
            if not unsent:
                return {"ok": True, "sent": 0, "message": "No pending alerts."}

            recipients = [user.email]
            if settings.recipients:
                extras = [r.strip() for r in settings.recipients.split(",") if r.strip()]
                recipients.extend(extras)
            recipients = [email for email in dict.fromkeys(recipients) if email]

            subject = f"Traker: {len(unsent)} price drop{'s' if len(unsent) != 1 else ''} detected!"
            html_body = _build_alert_digest_html(unsent, user.email)
            sent_ok = _send_alert_email(recipients, subject, html_body)

            if sent_ok:
                now = datetime.datetime.now(datetime.timezone.utc)
                for alert in unsent:
                    alert.sent = True
                    alert.sent_at = now
                db.commit()
                logger.info(
                    "alert_digest_sent user=%s count=%d recipients=%s",
                    caller_user_id,
                    len(unsent),
                    recipients,
                )
                return {"ok": True, "sent": len(unsent), "recipients": recipients}
            return {"ok": False, "reason": "Email delivery failed. Check SMTP configuration."}
    except SQLAlchemyError as exc:
        logger.exception("Failed to send alert digest: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/email-alerts/pending")
def get_pending_alerts(user: User = Depends(get_current_user)):
    """Get count of unsent price alerts for this user."""
    try:
        with SessionLocal() as db:
            count = (
                db.query(PriceAlert)
                .filter(PriceAlert.user_id == str(user.id), PriceAlert.sent.is_(False))
                .count()
            )
            return {"pending_count": count}
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch pending alerts: %s", exc)
        return {"pending_count": 0}


@app.get("/tracked-products")
def list_tracked_products(user: User = Depends(get_current_user)):
    try:
        with SessionLocal() as db:
            cdp_healthy = _cdp_endpoint_healthy()
            products = (
                db.query(TrackedProduct)
                .filter(TrackedProduct.user_id == str(user.id))
                .order_by(TrackedProduct.created_at.desc())
                .all()
            )
            response = []
            for p in products:
                currency_code = normalize_currency_code(p.currency_code or _guess_currency_code_from_url(p.url))
                response.append(
                    {
                        "id": p.id,
                        "url": p.url,
                        "product_name": p.product_name,
                        "site_name": p.site_name,
                        "custom_selector": p.custom_selector,
                        "current_price": p.current_price,
                        "original_price": p.original_price,
                        "original_price_selector": p.original_price_selector,
                        "currency_code": currency_code,
                        "currency_symbol": _currency_symbol_from_code(currency_code),
                        "display_price": _format_display_price(p.current_price, currency_code)
                        if p.current_price is not None
                        else None,
                        "threshold": p.threshold,
                        "frequency": normalize_frequency(p.frequency),
                        "last_checked": p.last_checked.isoformat() if p.last_checked else None,
                        "ui_changed": bool(p.ui_changed) if cdp_healthy else False,
                        "created_at": p.created_at.isoformat() if p.created_at else None,
                        "scraper_available": cdp_healthy,
                    }
                )
            return response
    except SQLAlchemyError as exc:
        logger.exception("Failed to list tracked products: %s", exc)
        return []


@app.get("/tracked-products/check-url")
def check_tracked_url(url: str, user: User = Depends(get_current_user)):
    """Lightweight check: is this URL (or a canonical equivalent) already tracked?"""
    caller_user_id = str(user.id)
    try:
        with SessionLocal() as db:
            existing = _find_tracked_product_by_url(db, url, user_id=caller_user_id)
            if existing:
                currency_code = normalize_currency_code(
                    existing.currency_code or _guess_currency_code_from_url(existing.url)
                )
                return {
                    "exists": True,
                    "id": existing.id,
                    "url": existing.url,
                    "product_name": existing.product_name,
                    "current_price": existing.current_price,
                    "display_price": _format_display_price(existing.current_price, currency_code)
                    if existing.current_price is not None
                    else None,
                }
            return {"exists": False}
    except SQLAlchemyError as exc:
        logger.exception("Failed to check tracked URL: %s", exc)
        return {"exists": False}


@app.post("/tracked-products")
def add_tracked_product(
    product: TrackedProductRequest,
    caller: User = Depends(get_current_user),
):
    caller_user_id = str(caller.id)
    try:
        with SessionLocal() as db:
            existing = _find_tracked_product_by_url(
                db,
                product.url,
                user_id=caller_user_id,
            )
            if existing:
                if product.product_name and product.product_name != "Unknown Product":
                    existing.product_name = product.product_name
                if product.site_name and not existing.site_name:
                    existing.site_name = product.site_name
                normalized_custom_selector = _normalize_selector_value(product.custom_selector)
                normalized_original_selector = _normalize_selector_value(product.original_price_selector)
                if normalized_custom_selector:
                    existing.custom_selector = normalized_custom_selector
                    existing.ui_changed = False
                    existing.selector_fail_count = 0
                if normalized_original_selector:
                    existing.original_price_selector = normalized_original_selector
                    existing.ui_changed = False
                    existing.selector_fail_count = 0
                price_updated = False
                if product.current_price is not None:
                    existing.current_price = product.current_price
                    price_updated = True
                if product.original_price is not None:
                    existing.original_price = product.original_price
                    price_updated = True
                if price_updated:
                    existing.last_checked = datetime.datetime.now(datetime.timezone.utc)
                    existing.ui_changed = False
                    existing.selector_fail_count = 0
                if product.currency_code is not None:
                    existing.currency_code = normalize_currency_code(product.currency_code)
                if not existing.currency_code:
                    existing.currency_code = _guess_currency_code_from_url(product.url)
                if product.threshold is not None:
                    existing.threshold = product.threshold
                if product.frequency is not None:
                    existing.frequency = normalize_frequency(product.frequency)
                if normalized_custom_selector or normalized_original_selector:
                    _upsert_selector_for_url(
                        product.url,
                        selector=normalized_custom_selector,
                        original_price_selector=normalized_original_selector,
                        user_id=caller_user_id,
                    )
                db.commit()
                return {"ok": True, "id": existing.id, "action": "updated"}
            else:
                new_product = TrackedProduct(
                    user_id=caller_user_id,
                    url=product.url,
                    canonical_url=_canonical_url(product.url),
                    normalized_host=_normalized_host(product.url),
                    product_name=product.product_name or "Unknown Product",
                    site_name=product.site_name,
                    custom_selector=_normalize_selector_value(product.custom_selector),
                    current_price=product.current_price,
                    original_price=product.original_price,
                    original_price_selector=_normalize_selector_value(product.original_price_selector),
                    currency_code=normalize_currency_code(product.currency_code or _guess_currency_code_from_url(product.url)),
                    threshold=product.threshold,
                    frequency=normalize_frequency(product.frequency),
                    last_checked=(
                        datetime.datetime.now(datetime.timezone.utc)
                        if product.current_price is not None or product.original_price is not None
                        else None
                    ),
                    ui_changed=False,
                    selector_fail_count=0,
                )
                db.add(new_product)
                if _normalize_selector_value(product.custom_selector) or _normalize_selector_value(product.original_price_selector):
                    _upsert_selector_for_url(
                        product.url,
                        selector=product.custom_selector,
                        original_price_selector=product.original_price_selector,
                        user_id=caller_user_id,
                    )
                db.commit()
                db.refresh(new_product)
                return {"ok": True, "id": new_product.id, "action": "created"}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to add tracked product: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/tracked-products/{product_id}")
def update_tracked_product(
    product_id: int,
    product: TrackedProductRequest,
    user: User = Depends(get_current_user),
):
    try:
        with SessionLocal() as db:
            existing = db.query(TrackedProduct).filter(
                TrackedProduct.id == product_id,
                TrackedProduct.user_id == str(user.id),
            ).first()
            if not existing:
                raise HTTPException(status_code=404, detail="Product not found")
            if product.product_name and product.product_name != "Unknown Product":
                existing.product_name = product.product_name
            if product.site_name and not existing.site_name:
                existing.site_name = product.site_name
            normalized_custom_selector = _normalize_selector_value(product.custom_selector)
            normalized_original_selector = _normalize_selector_value(product.original_price_selector)
            if normalized_custom_selector:
                existing.custom_selector = normalized_custom_selector
                existing.ui_changed = False
                existing.selector_fail_count = 0
            if normalized_original_selector:
                existing.original_price_selector = normalized_original_selector
                existing.ui_changed = False
                existing.selector_fail_count = 0
            price_updated = False
            if product.current_price is not None:
                existing.current_price = product.current_price
                price_updated = True
            if product.original_price is not None:
                existing.original_price = product.original_price
                price_updated = True
            if price_updated:
                existing.last_checked = datetime.datetime.now(datetime.timezone.utc)
                existing.ui_changed = False
                existing.selector_fail_count = 0
            if product.currency_code is not None:
                existing.currency_code = normalize_currency_code(product.currency_code)
            if not existing.currency_code:
                existing.currency_code = _guess_currency_code_from_url(existing.url)
            if product.threshold is not None:
                existing.threshold = product.threshold
            if product.frequency is not None:
                existing.frequency = normalize_frequency(product.frequency)
            if normalized_custom_selector or normalized_original_selector:
                _upsert_selector_for_url(
                    existing.url,
                    selector=normalized_custom_selector,
                    original_price_selector=normalized_original_selector,
                    user_id=str(user.id),
                )
            db.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to update tracked product: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/tracked-products/{product_id}")
def remove_tracked_product(product_id: int, user: User = Depends(get_current_user)):
    try:
        with SessionLocal() as db:
            product = db.query(TrackedProduct).filter(
                TrackedProduct.id == product_id,
                TrackedProduct.user_id == str(user.id),
            ).first()
            if not product:
                raise HTTPException(status_code=404, detail="Product not found")
            db.delete(product)
            db.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to remove tracked product: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/tracked-products/by-url/delete")
@app.delete("/tracked-products/by-url")
def remove_tracked_product_by_url(
    url: str,
    caller: User = Depends(get_current_user),
):
    caller_user_id = str(caller.id)
    try:
        with SessionLocal() as db:
            product = _find_tracked_product_by_url(db, url, user_id=caller_user_id)
            if not product:
                raise HTTPException(status_code=404, detail="Product not found")
            db.delete(product)
            db.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        logger.exception("Failed to remove tracked product: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/history")
def get_history(user: User = Depends(get_current_user)):
    try:
        with SessionLocal() as db:
            _prune_old_history(db)
            db.commit()
            rows: List[PriceHistory] = (
                db.query(PriceHistory)
                .filter(
                    PriceHistory.user_id == str(user.id),
                    PriceHistory.price.isnot(None),
                    PriceHistory.price > 0,
                )
                .order_by(PriceHistory.timestamp.desc())
                .limit(10)
                .all()
            )
            response = []
            for row in rows:
                currency_code = normalize_currency_code(row.currency_code or _guess_currency_code_from_url(row.url))
                response.append(
                    {
                        "id": row.id,
                        "product_name": row.product_name,
                        "url": row.url,
                        "price": row.price,
                        "original_price": row.original_price,
                        "currency_code": currency_code,
                        "currency_symbol": _currency_symbol_from_code(currency_code),
                        "custom_selector": row.custom_selector,
                        "original_price_selector": row.original_price_selector,
                        "ui_changed": bool(row.ui_changed),
                        "timestamp": row.timestamp.isoformat() if row.timestamp else None,
                    }
                )
            return response
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch price history: %s", exc)
        return []


@app.get("/history/by-url")
def get_history_by_url(
    url: str,
    limit: int = 1000,
    days: int = HISTORY_RETENTION_DAYS,
    user: User = Depends(get_current_user),
):
    safe_limit = max(1, min(limit, 5000))
    safe_days = max(1, min(days, HISTORY_RETENTION_DAYS))
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=safe_days)
    try:
        with SessionLocal() as db:
            _prune_old_history(db)
            db.commit()
            tracked = db.query(TrackedProduct).filter(
                TrackedProduct.url == url,
                TrackedProduct.user_id == str(user.id),
            ).first()
            tracked_currency = tracked.currency_code if tracked else None
            rows: List[PriceHistory] = (
                db.query(PriceHistory)
                .filter(
                    PriceHistory.url == url,
                    PriceHistory.user_id == str(user.id),
                    PriceHistory.price.isnot(None),
                    PriceHistory.price > 0,
                    PriceHistory.timestamp >= cutoff,
                )
                .order_by(PriceHistory.timestamp.desc())
                .limit(safe_limit)
                .all()
            )
            response = []
            for row in rows:
                currency_code = normalize_currency_code(
                    row.currency_code or tracked_currency or _guess_currency_code_from_url(row.url)
                )
                response.append(
                    {
                        "id": row.id,
                        "product_name": row.product_name,
                        "url": row.url,
                        "price": row.price,
                        "original_price": row.original_price,
                        "currency_code": currency_code,
                        "currency_symbol": _currency_symbol_from_code(currency_code),
                        "custom_selector": row.custom_selector,
                        "original_price_selector": row.original_price_selector,
                        "ui_changed": bool(row.ui_changed),
                        "timestamp": row.timestamp.isoformat() if row.timestamp else None,
                    }
                )
            return response
    except SQLAlchemyError as exc:
        logger.exception("Failed to fetch URL history: %s", exc)
        return []
