# User-Agent Parser

Parse User-Agent strings and Client Hints into browser, OS, and hardware fields. Optional **AI Analyze** (risk 1–10). Hardware comes from **`dataset_files/model_parse_cache.json`**, updated by the **GSMArena crawler**.

**API examples (copy/paste):** [http://localhost:3000/api-docs.html](http://localhost:3000/api-docs.html) (with server running)

---

## What we use now

| Use | Ignore for now |
|-----|----------------|
| `npm run start:https` | `npm run start:gsmarena`, `start:full`, `dev:gsmarena`, `dev:full` |
| `MODEL_PARSE_CACHE=1` (default in npm scripts) | Live GSMArena on each **Detect** |
| `dataset_files/model_parse_cache.json` | `GSMR_ENRICH_ALLOWED` in `.env` (no effect while cache-only is on) |
| `npm run crawl:quick` (manual crawler) | Background `lookupJob` / UA parse cache layers |
| `.env`: `FIRECRAWL_API_KEY` (crawler), `AI_ANALYZE_API_KEY` | Per-request `gsmarena-api` enrich |

**Loop:** start server → **Detect** reads cache → run crawler when you need new phones → **restart server** after the JSON file changes.

---

## Quick start

```bash
npm install
cp .env.example .env   # add FIRECRAWL_API_KEY, AI_ANALYZE_API_KEY as needed
npm run start:https    # https://localhost:3000
```

Crawler (first time):

```bash
cd crawler && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && cd ..
npm run crawl:quick
```

---

## Main commands

| Command | Purpose |
|---------|---------|
| `npm run start:https` | App + API (HTTPS, Client Hints) |
| `npm run crawl:quick` | Crawler: page 1 per brand → `model_parse_cache.json` |
| `cd crawler && python3 main.py` | Full crawl (uses `crawler/progress.json`) |
| `npm start` | HTTP instead of HTTPS |

---

## Web UI

- **Detect** — parse only; hardware from model cache.
- **AI Analyze** — risk score + summary (needs `AI_ANALYZE_API_KEY` on server).
- **Use this device** — fills Client Hints via `/api/ch-probe` (HTTPS).

---

## Config (`.env`)

One file at repo root for Node and crawler. See **`.env.example`**.

Important today: `FIRECRAWL_API_KEY`, `AI_ANALYZE_API_KEY` / `KONSOLE_API_KEY`.

---

## Crawler notes

- Writes slim rows into **`model_parse_cache.json`** (same 17 fields as cache entries in the repo).
- **Quick update** = GSMArena **page 1 only** per brand.
- `↪ no valid model codes` = page OK but no SKU to store (common on basic phones).
- Crawl manually: `npm run crawl:quick` or `python3 crawler/main.py --quick-update` (no macOS LaunchAgent schedule).

More detail: [crawler/README.md](crawler/README.md) (pointer only).

---

## API (short)

| Method | Path |
|--------|------|
| GET | `/api/health` |
| POST | `/api/parse` |
| POST | `/api/ai-analyze` |
| GET | `/api/ch-probe` |
| POST | `/mcp` |

Full bodies and curl: **`/api-docs.html`**.

---

## Deploy

Railway: `npm start`, health `GET /api/health`. Ship `dataset_files/` with the app.

---

## Troubleshooting

- **Hardware N/A** — model missing from `model_parse_cache.json`; run crawler or add a row; restart server.
- **Stale data after crawl** — restart `npm run start:https`.
- **AI 501** — set `AI_ANALYZE_API_KEY` in `.env`.
