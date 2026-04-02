# PriceTracker

A full-stack price monitoring system for e-commerce products. Track prices across 50+ sites with a multi-tier scraping engine, React dashboard, Chrome extension, and automated email alerts.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                 Azure Cloud                                     │
│                                                                                 │
│   ┌──────────────────────┐              ┌─────────────────────────────────┐     │
│   │  Azure Web App       │     CDP      │  Azure Container Instance       │     │
│   │  FastAPI Backend     │─────────────►│  Chrome + Xvfb                  │     │
│   │  (Python 3.13)       │              │  (headful mode)                 │     │
│   │                      │              └─────────────────────────────────┘     │
│   │                      │                                                      │
│   │                      │              ┌─────────────────────────────────┐     │
│   │                      │     HTTP     │  Azure Container Instance       │     │
│   │                      │─────────────►│  Camoufox +                     │     │
│   └───────────┬──────────┘              │  Playwright Broker              │     │
│               │                         └─────────────────────────────────┘     │
│               │ SQL                                                             │
│               │                                                                 │
│   ┌───────────▼──────────┐                                                      │
│   │  Neon Serverless     │                                                      │
│   │  Postgres            │                                                      │
│   └──────────────────────┘                                                      │
│                                                                                 │
│   ┌──────────────────────┐                                                      │
│   │  Azure Web App       │                                                      │
│   │  React Frontend      │                                                      │
│   │  (Node.js 22)        │                                                      │
│   └──────────────────────┘                                                      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
             ▲
             │ HTTPS
    Chrome Extension / Web Dashboard
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
| Backend | FastAPI, SQLAlchemy 2.0, Pydantic, Gunicorn |
| Database | Neon Serverless Postgres |
| Scraping | httpx, curl_cffi, Patchright, Camoufox, BeautifulSoup |
| Auth | JWT (python-jose), bcrypt (passlib) |
| Email | Resend API |
| Extension | Chrome Web Store (Manifest v3) |
| Hosting | Azure Web Apps (frontend + backend) |
| Containers | Azure Container Instances (Chrome + Camoufox) |
| CI/CD | GitHub Actions |

## Scrape Fallback Chain

For every URL the backend tries in order:

| Tier | Method | How it works |
|------|--------|-------------|
| 1 | **HTTP-first** | Plain `httpx` with realistic headers and HTTP/2 — fastest, no browser needed |
| 2 | **curl_cffi** | Chrome TLS fingerprint impersonation — bypasses basic TLS/Cloudflare checks |
| 3 | **Extension job** | Queues a scrape job for the Chrome extension to execute client-side |
| 4a | **Camoufox** | Stealth Firefox via Playwright with fingerprint spoofing, human-like interaction, GeoIP matching |
| 4b | **Chrome CDP** | Real Chrome + Xvfb over Chrome DevTools Protocol (headful mode defeats bot detection) |

## Production Infrastructure

| Component | Service | Details |
|-----------|---------|---------|
| Frontend | Azure Web App | Node.js 22, React SPA served via Express.js |
| Backend | Azure Web App | Python 3.13, FastAPI + Gunicorn |
| Database | Neon | Serverless Postgres with connection pooling |
| Chrome | Azure Container Instance | Real Chrome + Xvfb (virtual display), CDP access |
| Camoufox | Azure Container Instance | Stealth Firefox + Playwright broker, on-demand scaling |

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
- **Camoufox with BrowserForge** — randomized OS/screen/navigator fingerprints, human-like cursor/scroll simulation, GeoIP-based timezone/locale spoofing
- **Idle container lifecycle** — Camoufox ACI auto-stops after 30 minutes of inactivity for cost optimization
- **Selector drift detection** — custom selectors auto-fallback to built-ins after 3 consecutive failures
- **URL canonicalization** — query param normalization and variant detection for deduplication

## Deployment

All deployments are automated via GitHub Actions:

- **Frontend** — Azure Web App (Node.js 22), auto-deployed on changes to `frontend/`
- **Backend** — Azure Web App (Python 3.13 + Gunicorn), auto-deployed on changes to `backend/`
- **Database** — Neon Serverless Postgres
- **Browser containers** — Azure Container Instances (on-demand auto-scaling, auto-stop after idle timeout)
