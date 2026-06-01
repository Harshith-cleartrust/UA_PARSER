# Crawler

Updates `../dataset_files/model_parse_cache.json` from GSMArena.

```bash
npm run crawl:quick              # from repo root
python3 main.py                  # full crawl
python3 main.py --quick-update   # page 1 per brand
```

Config: repo root `.env`. Resume: `progress.json` (gitignored).

See [../README.md](../README.md).
