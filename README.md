# PriceTracker

A full-stack price monitoring system for e-commerce products. Track prices across 50+ sites with a multi-tier scraping engine, React dashboard, Chrome extension, and automated email alerts.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker Network                            │
│                                                                  │
│  ┌──────────────┐  CDP (9222)  ┌───────────────────┐            │
│  │   backend    │ ───────────► │     chrome         │            │
│  │  FastAPI     │              │  Real Chrome +     │            │
│  │  :8000       │              │  Xvfb (headful)    │            │
│  │              │  HTTP (3001) ┌───────────────────┐            │
│  │              │ ───────────► │    camoufox        │            │
│  └──────┬───────┘              │  Stealth Firefox + │            │
│         │ SQL                  │  Playwright Broker │            │
│  ┌──────▼───────┐              └───────────────────┘            │
│  │      db      │              └───────────────────┘            │
│  │  PostgreSQL  │                                                │
│  │  :5432       │                                                │
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
         ▲ :8000 (host)
         │
   Chrome Extension / React Frontend
```

## Features

- **Multi-tier scraping** — 5 fallback strategies from fast HTTP to full stealth browsers
- **Chrome extension** — track products, pick price selectors visually, get desktop notifications
- **React dashboard** — view tracked products, price history charts, and manage alerts
- **Email alerts** — digest notifications when prices drop below your threshold
- **JWT authentication** — secure user accounts with access/refresh token flow
- **50+ site selectors** — built-in CSS selectors for Amazon, Walmart, Target, eBay, and more
- **Multi-currency** — USD, EUR, GBP, JPY, CNY, INR, and others
- **Azure deployment** — CI/CD with GitHub Actions, auto-scaling with Azure Container Instances

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, Express.js (production server) |
| Backend | FastAPI, SQLAlchemy 2.0, Pydantic, uvicorn |
| Database | PostgreSQL 15 |
| Scraping | httpx, curl_cffi, Patchright, Camoufox, BeautifulSoup |
| Auth | JWT (python-jose), bcrypt (passlib) |
| Email | Resend API |
| Extension | Chrome Manifest v3 |
| Infra | Docker Compose, Azure Web Apps, Azure Container Instances |
| CI/CD | GitHub Actions |

## Scrape Fallback Chain

For every URL the backend tries in order:

| Tier | Method | How it works |
|------|--------|-------------|
| 1 | **HTTP-first** | Plain `httpx` with realistic headers and HTTP/2 — fastest, no browser needed |
| 2 | **curl_cffi** | Chrome TLS fingerprint impersonation — bypasses basic TLS/Cloudflare checks |
| 3 | **Extension job** | Queues a scrape job for the Chrome extension to execute client-side |
| 4a | **Camoufox** | Stealth Firefox via Playwright with fingerprint spoofing, human-like interaction, GeoIP matching |
| 4b | **Chrome CDP** | Real Chrome + Xvfb in a Docker container over Chrome DevTools Protocol |

## Prerequisites

- Docker & Docker Compose v2
- Node.js 22+ (for frontend development)
- Python 3.11+ (for backend development)

## Setup

### Quick Start (Docker)

```bash
# Clone the repo
git clone <repo-url>
cd PriceTracker

# Copy env config
cp .env.example .env

# Build and start all services
docker compose up --build

# Backend: http://localhost:8000
# Chrome VNC: http://localhost:6080
# Camoufox VNC: http://localhost:6081
```

### Frontend Development

```bash
cd frontend
npm install
npm run dev          # Vite dev server on http://localhost:5173
npm run build        # Production build to ./dist
```

### Backend Development

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py       # Or: uvicorn main:app --reload
```

### Chrome Extension

1. Open `chrome://extensions` and enable Developer mode
2. Click "Load unpacked" and select the `./extension/` directory
3. Set `DEV = true` in `extension/config.js` for localhost API

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:password@db:5432/pricetracker

# Browser containers
CHROME_CDP_URL=http://chrome:9223
CAMOUFOX_BROKER_URL=http://camoufox:3001
BROKER_API_KEY=<optional>

# Scraper tuning
SCRAPE_MAX_ATTEMPTS=3
HTTP_FIRST_MAX_ATTEMPTS=3
ENABLE_TIER_2_CFFI=true

# Authentication
JWT_SECRET=your-secret-key-here
ACCESS_TOKEN_MINUTES=60
REFRESH_TOKEN_DAYS=30

# CORS
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:3000

# Email (optional)
RESEND_API_KEY=<your-resend-key>

# Proxy (optional)
CDP_PROXY_PRIMARY_URL=http://user:pass@proxy-host:port

# Azure Container Instances (optional)
ENABLE_ACI_AUTO_START=true
ACI_SUBSCRIPTION_ID=<azure-subscription-id>
ACI_RESOURCE_GROUP=traker-rg
```

## Docker Services

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| db | postgres:15 | 5432 | PostgreSQL database |
| chrome | custom (Ubuntu + Chrome + Xvfb) | 9223, 6080 | Real Chrome with CDP and VNC |
| camoufox | custom (Ubuntu + Camoufox) | 3001, 6081 | Stealth Firefox scraper + broker |
| backend | custom (Python 3.11) | 8000 | FastAPI application |

## API Endpoints

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Get access + refresh tokens |
| GET | `/auth/me` | Current user info |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Revoke refresh token |
| DELETE | `/auth/account` | Delete account |

### Scraping & Tracking
| Method | Path | Description |
|--------|------|-------------|
| POST | `/scrape` | Scrape price for a URL (tries all tiers) |
| GET | `/scrape/status/{job_id}` | Async scrape job status |
| POST | `/visual-pick` | Store a CSS selector for a URL |
| GET | `/tracked-products` | List tracked products |
| POST | `/tracked-products` | Add/update a tracked product |
| PUT | `/tracked-products/{id}` | Update a tracked product |
| DELETE | `/tracked-products/{id}` | Remove a tracked product |
| DELETE | `/tracked-products/by-url` | Remove by URL |
| GET | `/tracked-products/check-url` | Check if URL is already tracked |

### Price History & Alerts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/history` | Last 10 price history entries |
| GET | `/history/by-url?url=...` | Price history for a specific URL |
| GET | `/email-settings` | User's alert settings |
| PUT | `/email-settings` | Update alert settings |
| POST | `/email-alerts/send-digest` | Send alert digest email |
| GET | `/email-alerts/pending` | Pending alerts |

### Extension Integration
| Method | Path | Description |
|--------|------|-------------|
| POST | `/extension/heartbeat` | Keep-alive signal |
| GET | `/extension/jobs` | Poll pending jobs |
| POST | `/extension/jobs/{id}/complete` | Report job result |
| POST | `/extension/price-report` | Report price from extension |
| GET | `/extension/products` | Latest price per URL |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/scrape-stats` | Scrape stats by domain/tier |
| GET | `/aci/status` | Azure Container Instance health |
| POST | `/aci/start` | Start ACI container |
| POST | `/aci/stop` | Stop ACI container |

## Key Design Decisions

- **Chrome runs headful** (Xvfb virtual display) — no `--headless` flag, so `navigator.webdriver` stays `false` and bot fingerprints are minimized
- **Backend connects to Chrome via CDP** — never launches its own browser process
- **CDP port is internal-only** — never mapped to the host network
- **`shm_size: 2gb`** — prevents Chrome OOM crashes on shared-memory limits
- **Camoufox with BrowserForge** — randomized OS/screen/navigator fingerprints, human-like cursor/scroll simulation, GeoIP-based timezone/locale spoofing
- **Idle container lifecycle** — Camoufox ACI auto-stops after 30 minutes of inactivity for cost optimization
- **Selector drift detection** — custom selectors auto-fallback to built-ins after 3 consecutive failures
- **URL canonicalization** — query param normalization and variant detection for deduplication

## Project Structure

```
PriceTracker/
├── backend/
│   ├── main.py                  # FastAPI app (all routes, scraping, models)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── tests/                   # Unit tests (URL canonicalization, price parsing)
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # Main dashboard UI
│   │   ├── LoginPage.jsx        # Authentication page
│   │   └── ToastNotification.jsx
│   ├── server.js                # Express.js production server
│   ├── package.json
│   └── vite.config.js
├── extension/
│   ├── manifest.json            # Chrome Manifest v3
│   ├── popup.js / popup.html    # Extension popup UI
│   ├── background.js            # Service worker (polling, auth)
│   ├── content_picker.js        # Visual selector picker
│   └── content_scraper.js       # Client-side scraping
├── chrome-container/
│   ├── Dockerfile               # Ubuntu + Chrome + Xvfb
│   └── entrypoint.sh
├── camoufox-container/
│   ├── Dockerfile               # Ubuntu + Camoufox + Playwright
│   ├── broker.py                # FastAPI broker for Camoufox
│   └── entrypoint.sh
├── docker-compose.yml           # 4-service orchestration
├── .github/workflows/           # CI/CD (Azure deploy)
└── build.sh                     # Extension build script
```

## Deployment

- **Frontend** — Azure Web App (Node.js 22), auto-deployed via GitHub Actions on changes to `frontend/`
- **Backend** — Azure Web App (Python 3.13 + Gunicorn), auto-deployed on changes to `backend/`
- **Database** — Azure Database for PostgreSQL (managed)
- **Browser containers** — Azure Container Instances (on-demand auto-scaling)
