# UA parse automation

Runs your **User-Agent** (and optional **Client Hints**) cases against the parser and writes a **JSON report**.

## Modes

| Mode | Command | Needs server? |
|------|---------|----------------|
| **integration** (default) | `npm run test:automation` | Yes — start `npm start` first |
| **offline** | `npm run test:automation -- --offline` | No — uses the same libs as the server |

## Environment

- `BASE_URL` — API root (default `http://localhost:3000`)
- `MODEL_PARSE_CACHE` — set automatically for offline mode (`1`)

## Tags (Apple, proof, crawler, …)

Each case may include `"tags": ["apple", "ios"]` (optional). Run only matching cases:

```bash
node automation/run-tests.mjs --offline --tags=apple
node automation/run-tests.mjs --offline --tags=proof,crawler
TAGS=android,cache npm run test:automation:offline
```

If no case matches the filter, the report still writes with `casesRun: 0`.

### Bundled groups

| Tag | What it covers |
|-----|----------------|
| **apple** | iPhone Safari, iPad Safari, iPhone Chrome (CriOS), macOS Safari |
| **ios** | iPhone / iPad UA cases |
| **proof** | Explicit behavior checks (Client Hints override UA model; no crawler rows unless bot; Googlebot includes crawler fields) |
| **crawler** | Bot UAs |
| **android** | Android + cache / edge cases |
| **cache** | Models present in `model_parse_cache.json` |
| **smoke** | Quick sanity checks |

## Add your own cases

Edit `cases.json`. Each entry in `cases`:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable id for logs |
| `userAgent` | yes | Full UA string |
| `clientHints` | no | Object passed as JSON body `clientHints` |
| `tags` | no | e.g. `["apple","proof"]` — filter with `--tags=apple` |
| `expect` | no | Assertions (see below) |
| `captureFullResponse` | no | If `true`, full `/api/parse` JSON is stored in the report (large) |

### `expect` shape (all optional)

```json
{
  "httpStatus": 200,
  "debug": {
    "modelKey": { "equals": "sma5760" },
    "modelParseCacheHit": { "equals": true }
  },
  "properties": {
    "HardwareChipset": { "includes": "Exynos" },
    "IsCrawler": { "equals": "False" }
  },
  "gsmarena": {
    "reason": { "equals": "model_parse_cache_only" }
  }
}
```

Matchers per field:

- `{ "equals": <string|number|boolean> }` — strict equality after stringifying for strings
- `{ "includes": "<substring>" }` — property value must include substring (case-sensitive)
- `{ "regex": "<pattern>" }` — value must match (JS `RegExp`)
- `{ "exists": true }` — property row must exist and not be `N/A` / empty

## Output (one UA = one line)

Log file (same calendar day, UTC): **`automation/output/daily-YYYY-MM-DD.jsonl`**

- **Each line** = one test case = one **User-Agent** run (minified JSON).
- Fields typically include: `ts`, `run` (batch id = suite start time), `mode`, `id`, `ok`, `ms`, **`ua`**, optional `ch`, optional `dbg` (`modelKey`, `modelParseCacheHit`, `modelSource`), `failures` / `error` if any.
- **Console:** prints the same one line per case, then one **`kind:"suite"`** summary line with totals and `log` path.

Example (pretty-printed for reading; file is one line):

```json
{"ts":"2026-05-20T10:00:00.100Z","run":"2026-05-20T10:00:00.000Z","mode":"offline","id":"cache-hit-samsung-a5760","ok":true,"ms":25,"ua":"Mozilla/5.0 ...","ch":{"secChUaModel":"\"SM-A5760\""},"dbg":{"modelKey":"sma5760","modelParseCacheHit":true,"modelSource":"client_hint"}}
```

Filter today’s log to lines for one case id:

```bash
grep '"id":"crawler-googlebot"' automation/output/daily-$(date -u +%Y-%m-%d).jsonl
```

## Exit code

- `0` — all cases with `expect` passed (cases without `expect` are informational only)
- `1` — any failure, or HTTP/network error
