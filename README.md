# Price Tracker

A product price tracking tool with a FastAPI backend, PostgreSQL database, and Chrome extension.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Network                        │
│                                                         │
│  ┌──────────────┐   CDP (9222)   ┌──────────────────┐  │
│  │   backend    │ ─────────────► │     chrome       │  │
│  │  FastAPI     │                │  Real Chrome +   │  │
│  │  :8000       │                │  Xvfb (headful)  │  │
│  └──────┬───────┘                └──────────────────┘  │
│         │ SQL                                           │
│  ┌──────▼───────┐                                       │
│  │      db      │                                       │
│  │  PostgreSQL  │                                       │
│  │  :5432       │                                       │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘

        ▲ :8000 (host)
        │
  Chrome Extension / Frontend
```

**Key design decisions:**
- Chrome runs in its own container with Xvfb (virtual display) — **no `--headless` flag**, so `navigator.webdriver` stays `false` and bot fingerprints are minimised.
- The backend connects to Chrome over CDP (`connect_over_cdp`) — it never launches its own browser.
- CDP port 9222 is internal-only and never mapped to the host.
- `shm_size: 2gb` prevents Chrome from crashing on shared-memory limits.

## Scrape fallback chain

For every URL the backend tries in order:

1. **HTTP-first** — plain `httpx` with realistic headers (fastest, no browser)
2. **curl_cffi** — Chrome TLS fingerprint impersonation (bypasses basic TLS checks)
3. **Remote Chrome CDP** — real Chrome in the container (highest compatibility)

## Prerequisites

- Docker & Docker Compose v2
- The Chrome extension loaded in your browser (from `./extension/`)

## Setup

```bash
# 1. Copy env config
cp .env.example .env

# 2. Build and start all services
docker compose up --build

# 3. Backend is now available at http://localhost:8000
```

The first build downloads Google Chrome stable (~100 MB) — subsequent builds use the layer cache.

## Services

| Service  | Image          | Port (host) | Description                        |
|----------|----------------|-------------|------------------------------------|
| db       | postgres:15    | 5432        | PostgreSQL database                |
| chrome   | (built)        | —           | Real Chrome + Xvfb, CDP on :9222  |
| backend  | (built)        | 8000        | FastAPI scraping backend           |

## Adding a proxy

To route Chrome through a residential proxy, edit `docker-compose.yml` and add to the `chrome` service:

```yaml
  chrome:
    environment:
      PROXY_SERVER: http://user:pass@proxy-host:port
```

Then uncomment the `--proxy-server` line in [chrome-container/entrypoint.sh](chrome-container/entrypoint.sh).

## API endpoints

| Method | Path                          | Description                        |
|--------|-------------------------------|------------------------------------|
| POST   | `/scrape`                     | Scrape price for a URL             |
| POST   | `/visual-pick`                | Store a CSS selector for a URL     |
| GET    | `/tracked-products`           | List all tracked products          |
| POST   | `/tracked-products`           | Add / update a tracked product     |
| PUT    | `/tracked-products/{id}`      | Update a tracked product           |
| DELETE | `/tracked-products/{id}`      | Remove a tracked product           |
| DELETE | `/tracked-products/by-url`    | Remove a tracked product by URL    |
| GET    | `/history`                    | Last 10 price history entries      |
| GET    | `/history/by-url?url=...`     | Price history for a specific URL   |
| GET    | `/extension/products`         | Latest price per URL (extension)   |
