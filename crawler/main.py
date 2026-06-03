#!/usr/bin/env python3

import json
import os
import random
import re
import time

import requests
from bs4 import BeautifulSoup


def load_env_file(path):
    """Load KEY=VALUE pairs from a .env file without overwriting exported vars."""
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()

            if not key or key in os.environ:
                continue

            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]

            os.environ[key] = value


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)


def load_local_env():
    """Load repo-root `.env` only (same file as `npm start` / server.js)."""
    env_path = os.environ.get("DOTENV_PATH", "").strip() or os.path.join(REPO_ROOT, ".env")

    try:
        from dotenv import load_dotenv
    except ImportError:
        load_env_file(env_path)
    else:
        load_dotenv(env_path, override=False)


load_local_env()

# ---------------------------------
# CONFIG
# ---------------------------------
BASE = "https://www.gsmarena.com/"


def default_dataset_file():
    """Same file the UA parser reads when MODEL_PARSE_CACHE=1."""
    custom = os.environ.get("MODEL_PARSE_CACHE_PATH", "").strip()
    if custom:
        return os.path.abspath(custom)
    return os.path.join(REPO_ROOT, "dataset_files", "model_parse_cache.json")


OUTPUT_FILE = os.environ.get("SMARTPHONE_OUTPUT_FILE", "").strip() or default_dataset_file()
PROGRESS_FILE = os.environ.get(
    "SMARTPHONE_PROGRESS_FILE",
    os.path.join(SCRIPT_DIR, "progress.json"),
)

REQUEST_DELAY_MIN = int(os.environ.get("REQUEST_DELAY_MIN", "10"))
REQUEST_DELAY_MAX = int(os.environ.get("REQUEST_DELAY_MAX", "18"))
MAX_BRANDS_PER_RUN = int(os.environ.get("MAX_BRANDS_PER_RUN", "10"))
PAGE_DELAY_SEC = float(os.environ.get("PAGE_DELAY_SEC", "2"))
# --quick-update: after queueing page-1 rows missing from the cache, optionally re-fetch the
# first N page-1 links anyway (catches new model codes when hardware_name already exists). 0 = off.
QUICK_UPDATE_RECHECK_FIRST = max(0, int(os.environ.get("QUICK_UPDATE_RECHECK_FIRST", "0")))
# 1 = save model_parse_cache.json after every successful phone (safest, slow on huge files).
# Set to 3–10 to batch writes; crash may lose up to N−1 unsaved phones.
SAVE_EVERY_N_PHONES = max(1, int(os.environ.get("SMARTPHONE_SAVE_EVERY_N_PHONES", "1")))

FIRECRAWL_API_URL = os.environ.get(
    "FIRECRAWL_API_URL", "https://api.firecrawl.dev/v1/scrape"
)
FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
USE_FIRECRAWL = os.environ.get("USE_FIRECRAWL", "true").lower() not in ("0", "false", "no")
# If true, never call GSM Arena from your IP (only Firecrawl). Use when you get HTTP 429 / IP blocks.
DISABLE_DIRECT_GSM = os.environ.get("DISABLE_DIRECT_GSM", "false").lower() in (
    "1",
    "true",
    "yes",
)
SKIP_SEED_COMPLETE = os.environ.get("SKIP_SEED_COMPLETE", "false").lower() in (
    "1",
    "true",
    "yes",
)
# Comma-separated vendor names to skip this run (e.g. samsung). Advances brand_index
# and pins listed_phones to current dataset size so resume logic won't keep reopening Samsung.
SKIP_VENDORS = frozenset(
    v.strip().lower()
    for v in os.environ.get("SKIP_VENDORS", "").split(",")
    if v.strip()
)
_firecrawl_disabled = False
_gsmarena_rate_limited = False

DEVICE_FIELDS = [
    "model",
    "hardware_vendor",
    "oem",
    "hardware_name",
    "hardware_family",
    "hardware_name_version",
    "device_type",
    "screen_inches_diagonal",
    "screen_pixels_width",
    "screen_pixels_height",
    "supported_bearers",
    "cpu_architecture",
    "approx_device_age",
    "CPU",
    "GPU",
    "SoC",
]

NA = "na"
MODEL_SKIP = frozenset({"ds", "dsn", "duos", "nfc", "wifi", "lte", "5g", "4g", "3g"})

REMOVED_FIELDS = frozenset({
    "hardware_model",
    "hardware_model_variants",
    "manufacturer",
    "device_model",
    "platform_name",
    "platform_vendor",
    "platform_version",
    "operating_system",
    "os_version",
    "browser_name",
    "browser_vendor",
    "browser_type",
    "rendering_engine",
    "android_webview",
    "default_app_stores",
    "mobile_browser",
    "browser_version",
    "is_crawler",
    "crawler_name",
    "crawler_product_tokens",
    "crawler_url",
    "crawler_usage",
    "is_web_app",
    "is_data_minimising",
    "in_app_browser",
    "automation_bots",
    "app_version",
})

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}

RE_RESOLUTION = re.compile(r"(\d+)\s*x\s*(\d+)", re.IGNORECASE)
RE_SCREEN_INCHES = re.compile(r"([\d.]+)\s*inches?", re.IGNORECASE)
RE_YEAR = re.compile(r"\b(20\d{2})\b")
RE_LISTING_PAGE = re.compile(r"-p(\d+)\.php$")
RE_VALID_MODEL_DIGIT = re.compile(r"\d")
RE_DS_COMBINED = re.compile(r"\d[a-z]$")
RE_DEVICE_YEAR_PAREN = re.compile(r"\(20\d{2}\)")
RE_DEVICE_YEAR_WORD = re.compile(r"\b20\d{2}\b")

JSON_SAVE_INDENT = None if os.environ.get("CRAWLER_JSON_INDENT", "1") == "0" else 2
JSON_SAVE_SEPARATORS = (",", ":") if JSON_SAVE_INDENT is None else (",", ": ")

_http_session = None


def get_http_session():
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
        _http_session.headers.update(HTTP_HEADERS)
    return _http_session


def _soup(html):
    return BeautifulSoup(html, "html.parser")


def na(value):
    if value is None:
        return NA
    if isinstance(value, str) and not value.strip():
        return NA
    if isinstance(value, (list, tuple)) and not value:
        return NA
    return value


def normalize_url(href):
    if not href:
        return BASE
    href = href.strip()
    if href.startswith(("http://", "https://")):
        return href
    if href.startswith("//"):
        return "https:" + href
    return BASE + href.lstrip("/")


# ---------------------------------
# FIRECRAWL FETCH
# ---------------------------------

def firecrawl_fetch(url, retries=3):
    global _firecrawl_disabled

    if not FIRECRAWL_API_KEY:
        raise RuntimeError(
            "FIRECRAWL_API_KEY is not set. Export your Firecrawl API key first."
        )

    if _firecrawl_disabled:
        return None

    headers = {
        "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "url": url,
        "formats": ["html"],
        "onlyMainContent": False,
        "waitFor": 2000,
    }

    for attempt in range(retries):
        try:
            response = requests.post(
                FIRECRAWL_API_URL,
                headers=headers,
                json=payload,
                timeout=120,
            )

            if response.status_code == 429:
                print("⚠ Firecrawl rate limit. Sleeping 60 sec...")
                time.sleep(60)
                continue

            if response.status_code == 402:
                _firecrawl_disabled = True
                print(
                    "⚠ Firecrawl HTTP 402 — account has no credits or plan expired. "
                    "Key is valid but billing is required. Falling back to direct fetch only."
                )
                return None

            if response.status_code != 200:
                print(f"⚠ Firecrawl HTTP {response.status_code} for {url}")
                return None

            body = response.json()
            if not body.get("success"):
                print(f"⚠ Firecrawl scrape failed for {url}: {body.get('error', body)}")
                return None

            data = body.get("data") or {}
            html = data.get("html") or data.get("rawHtml")
            if html:
                return html

            print(f"⚠ Firecrawl returned no HTML for {url}")
            return None

        except requests.exceptions.Timeout:
            print(f"⏳ Firecrawl timeout (attempt {attempt + 1}/{retries})")
            time.sleep(8)
        except Exception as exc:
            print(f"Request error: {exc}")
            time.sleep(5)

    return None


def direct_fetch(url, retries=5):
    global _gsmarena_rate_limited

    if _gsmarena_rate_limited:
        return None

    for attempt in range(retries):
        try:
            response = get_http_session().get(url, timeout=30)
            if response.status_code == 200:
                return response.text
            if response.status_code == 429:
                _gsmarena_rate_limited = True
                wait = min(300, 30 * (2**attempt))
                print(
                    f"⚠ GSM Arena rate limit (429). Waiting {wait}s before retry "
                    f"({attempt + 1}/{retries})..."
                )
                time.sleep(wait)
                continue
            print(f"⚠ Direct HTTP {response.status_code} for {url}")
        except Exception as exc:
            print(f"Direct fetch error: {exc}")
        time.sleep(5)
    return None


def count_devices_in_html(html):
    return len(_soup(html).select(".makers li a"))


def html_has_specs(html):
    return bool(_soup(html).select("table tr td.ttl"))


def fetch_html(url, expect_devices=False, expect_specs=False):
    global _gsmarena_rate_limited

    html = None
    if FIRECRAWL_API_KEY and USE_FIRECRAWL and not _firecrawl_disabled:
        html = firecrawl_fetch(url)

    if html:
        if expect_devices and count_devices_in_html(html) == 0:
            print(f"⚠ Firecrawl HTML missing device list for {url}, using direct fetch...")
            if DISABLE_DIRECT_GSM:
                print("   (DISABLE_DIRECT_GSM=1 — skipping direct GSM; fix Firecrawl or retry.)")
                return None
            html = None
        elif expect_specs and not html_has_specs(html):
            print(f"⚠ Firecrawl HTML missing specs for {url}, using direct fetch...")
            if DISABLE_DIRECT_GSM:
                print("   (DISABLE_DIRECT_GSM=1 — skipping direct GSM; fix Firecrawl or retry.)")
                return None
            html = None
        else:
            return html

    if _gsmarena_rate_limited or DISABLE_DIRECT_GSM:
        return None

    return direct_fetch(url)


# ---------------------------------
# LOAD / SAVE DATA
# ---------------------------------

def default_output():
    return {
        "devices": [],
        "progress": {"brand_index": 0},
    }


def load_progress_file():
    """Load progress from PROGRESS_FILE if present; otherwise return None."""
    if not os.path.exists(PROGRESS_FILE):
        return None
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return None
    if isinstance(raw, dict) and "progress" in raw and isinstance(raw["progress"], dict):
        return raw["progress"]
    if isinstance(raw, dict):
        return raw
    return None


def load_data():
    store = CacheDataset.load_from_disk()
    progress = load_progress_file() or {"brand_index": 0}
    data = {"_store": store, "progress": progress}
    migrate_progress(data)
    compact_complete_phones_for_save(data["progress"], store)
    return data


def is_corrupted_model(model, vendor, hardware_name=""):
    if not model or model == NA:
        return True
    if model.startswith(f"{vendor}_"):
        return True
    if hardware_name and model.replace("_", "") == hardware_name.replace("_", ""):
        return True
    return False


def resolve_entry_key(vendor, name, model, existing):
    """Storage key for one cache row; `existing` is the entries dict."""
    vendor = vendor or "unknown"
    name = name or "unknown"
    if not is_corrupted_model(model, vendor, name):
        key = model
        if key in existing:
            prev = existing[key]
            prev_v = prev.get("hardware_vendor")
            if prev_v and vendor and prev_v != vendor:
                key = f"{vendor}_{model}"
            else:
                key = f"{vendor}_{name}_{model}"
    else:
        key = f"{vendor}_{name}"
    return key


def slim_entry_fields(entry):
    formatted = format_device_entry(dict(entry))
    return {field: formatted[field] for field in DEVICE_FIELDS}


class CacheDataset:
    """In-memory model_parse_cache with vendor/model indexes (avoids list↔map on every save)."""

    __slots__ = ("entries", "phones_by_vendor", "model_keys")

    def __init__(self, entries=None):
        self.entries = entries if isinstance(entries, dict) else {}
        self.phones_by_vendor = {}
        self.model_keys = set()
        self._rebuild_indexes()

    def _rebuild_indexes(self):
        self.phones_by_vendor = {}
        self.model_keys = set()
        for fields in self.entries.values():
            if not isinstance(fields, dict):
                continue
            vendor = (fields.get("hardware_vendor") or "").strip().lower()
            name = fields.get("hardware_name")
            model = fields.get("model")
            if vendor and name:
                self.phones_by_vendor.setdefault(vendor, set()).add(name)
            if vendor and model and model != NA and is_valid_model_code(model):
                self.model_keys.add(vendor_model_dedupe_key(vendor, model))

    def __len__(self):
        return len(self.entries)

    def phones_for_vendor(self, brand_name):
        return self.phones_by_vendor.get((brand_name or "").lower(), set())

    def add_entry(self, entry, existing_keys=None):
        slim = slim_entry_fields(entry)
        vendor = slim.get("hardware_vendor") or "unknown"
        name = slim.get("hardware_name") or "unknown"
        model = slim.get("model")
        if not is_corrupted_model(model, vendor, name):
            slim["model"] = model
        else:
            slim["model"] = NA
        key = resolve_entry_key(vendor, name, slim["model"], self.entries)
        self.entries[key] = slim
        vlow = vendor.lower()
        if vlow and name:
            self.phones_by_vendor.setdefault(vlow, set()).add(name)
        if (
            vlow
            and slim["model"] != NA
            and is_valid_model_code(slim["model"])
        ):
            dedupe = vendor_model_dedupe_key(vendor, slim["model"])
            self.model_keys.add(dedupe)
            if existing_keys is not None:
                existing_keys.add(dedupe)
        return key

    def as_list(self):
        return devices_map_to_list(self.entries)

    def write_atomic(self, progress):
        output_dir = os.path.dirname(OUTPUT_FILE)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        payload = {"version": 1, "entries": self.entries}
        temp_path = OUTPUT_FILE + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(
                payload,
                handle,
                indent=JSON_SAVE_INDENT,
                ensure_ascii=False,
                separators=JSON_SAVE_SEPARATORS,
            )
        os.replace(temp_path, OUTPUT_FILE)

        progress_dir = os.path.dirname(PROGRESS_FILE)
        if progress_dir:
            os.makedirs(progress_dir, exist_ok=True)
        progress_payload = {
            "progress": progress,
            "last_updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        temp_progress = PROGRESS_FILE + ".tmp"
        with open(temp_progress, "w", encoding="utf-8") as handle:
            json.dump(
                progress_payload,
                handle,
                indent=JSON_SAVE_INDENT,
                ensure_ascii=False,
                separators=JSON_SAVE_SEPARATORS,
            )
        os.replace(temp_progress, PROGRESS_FILE)

    @classmethod
    def load_from_disk(cls):
        if os.path.exists(OUTPUT_FILE):
            with open(OUTPUT_FILE, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if isinstance(raw, dict) and isinstance(raw.get("entries"), dict):
                return cls(raw["entries"])
            data = normalize_loaded_data(raw)
            return cls(devices_list_to_map(data["devices"]))

        legacy_dataset = os.path.join(
            SCRIPT_DIR, "datasets", "smartphone_hardware_test_dataset.json"
        )
        if os.path.exists(legacy_dataset):
            with open(legacy_dataset, "r", encoding="utf-8") as handle:
                legacy = json.load(handle)
            legacy_devices = legacy.get("devices", legacy if isinstance(legacy, list) else [])
            if isinstance(legacy_devices, dict):
                legacy_devices = devices_map_to_list(legacy_devices)
            data = normalize_loaded_data(
                {"devices": legacy_devices, "progress": {"brand_index": 0}}
            )
            return cls(devices_list_to_map(data["devices"]))

        return cls({})


def get_store(data):
    return data["_store"]


def devices_list_to_map(devices):
    result = {}
    for device in devices:
        model = device.get("model")
        vendor = device.get("hardware_vendor") or "unknown"
        name = device.get("hardware_name") or "unknown"
        key = resolve_entry_key(vendor, name, model, result)
        device["model"] = model if not is_corrupted_model(model, vendor, name) else NA
        result[key] = slim_entry_fields(device)
    return result


def devices_map_to_list(devices_map):
    devices = []
    if not isinstance(devices_map, dict):
        return devices

    for key, fields in devices_map.items():
        if not isinstance(fields, dict):
            continue

        entry = dict(fields)
        vendor = fields.get("hardware_vendor", "")
        name = fields.get("hardware_name", "")
        stored_model = fields.get("model")

        if stored_model and stored_model != NA and not is_corrupted_model(
            stored_model, vendor, name
        ):
            entry["model"] = stored_model
        elif key == f"{vendor}_{name}":
            entry["model"] = NA
        elif key.startswith(f"{vendor}_{name}_"):
            entry["model"] = key[len(f"{vendor}_{name}_") :]
        elif key.startswith("samsung_samsung_"):
            entry["model"] = key.replace("samsung_samsung_", "", 1)
        elif not is_corrupted_model(key, vendor, name):
            entry["model"] = key
        else:
            entry["model"] = NA

        devices.append(entry)

    return devices


def normalize_loaded_data(data):
    if isinstance(data, list):
        return {"devices": dedupe_devices(data), "progress": {"brand_index": 0}}

    if isinstance(data.get("entries"), dict):
        progress = data.get("progress", {"brand_index": 0})
        devices = dedupe_devices(devices_map_to_list(data["entries"]))
        compact_complete_phones_for_save(progress, devices)
        return {
            "devices": devices,
            "progress": progress,
        }

    meta_keys = {"progress", "last_updated", "run_log", "version", "entries"}
    if "devices" not in data and any(
        isinstance(v, dict) and "hardware_vendor" in v for k, v in data.items() if k not in meta_keys
    ):
        devices_map = {k: v for k, v in data.items() if k not in meta_keys and isinstance(v, dict)}
        progress = data.get("progress", {"brand_index": 0})
        devices = dedupe_devices(devices_map_to_list(devices_map))
        compact_complete_phones_for_save(progress, devices)
        return {
            "devices": devices,
            "progress": progress,
        }

    if isinstance(data.get("devices"), dict):
        data["devices"] = dedupe_devices(devices_map_to_list(data["devices"]))
    elif isinstance(data.get("devices"), list):
        data["devices"] = dedupe_devices(data["devices"])
    else:
        data["devices"] = []

    data.setdefault("progress", {"brand_index": 0})
    data.pop("run_log", None)
    migrate_progress(data)
    compact_complete_phones_for_save(data["progress"], data["devices"])
    return data


def save_data(data):
    store = get_store(data)
    progress = data.get("progress", {"brand_index": 0})
    compact_complete_phones_for_save(progress, store)
    store.write_atomic(progress)


def log_message(data, message):
    print(message, flush=True)


def migrate_progress(data):
    progress = data["progress"]
    if "brand_index" not in progress and "last_index" in progress:
        progress["brand_index"] = progress["last_index"]


def get_progress(data):
    migrate_progress(data)
    return data["progress"].get("brand_index", 0)


def set_progress(data, brand_index):
    data["progress"]["brand_index"] = brand_index


def _phones_in_dataset(devices_or_store, brand_name):
    if isinstance(devices_or_store, CacheDataset):
        return devices_or_store.phones_for_vendor(brand_name)
    return unique_phones_in_data(devices_or_store, brand_name)


def _merge_complete_phones_raw(progress, devices_or_store, brand_name):
    """Set of listing hardware_name values treated as done for this vendor."""
    in_data = _phones_in_dataset(devices_or_store, brand_name)
    raw = (progress.get("complete_phones") or {}).get(brand_name)
    if isinstance(raw, list):
        return in_data | set(raw)
    if isinstance(raw, dict):
        return in_data | set(raw.get("x") or [])
    if isinstance(raw, int):
        return set(in_data)
    return set(in_data)


def _count_from_complete(raw):
    """Best-effort count of completed phones from any historic shape."""
    if isinstance(raw, int):
        return raw
    if isinstance(raw, list):
        return len(set(raw))
    if isinstance(raw, dict):
        return int(raw.get("n") or 0)
    return 0


def mark_phone_complete(progress, brand_name, hardware_name, devices_or_store):
    """Store a single integer per brand (count of completed phones)."""
    complete = progress.setdefault("complete_phones", {})
    in_data = _phones_in_dataset(devices_or_store, brand_name)

    if hardware_name in in_data:
        # Dataset already covers this name; recompute from dataset + any legacy extras.
        raw = complete.get(brand_name)
        extras = set()
        if isinstance(raw, dict):
            extras = set(raw.get("x") or []) - in_data
        elif isinstance(raw, list):
            extras = set(raw) - in_data
        complete[brand_name] = len(in_data | extras)
        return

    # Phone marked done without a dataset row: bump the count without listing names.
    current = _count_from_complete(complete.get(brand_name))
    # Keep count consistent with dataset size if it has grown beyond the stored value.
    base = max(current, len(in_data))
    complete[brand_name] = base + 1


def compact_complete_phones_for_save(progress, devices_or_store):
    """Normalize complete_phones to a plain integer per brand."""
    complete = progress.get("complete_phones")
    if not isinstance(complete, dict):
        return
    for brand_name in list(complete.keys()):
        raw = complete.get(brand_name)
        in_data = _phones_in_dataset(devices_or_store, brand_name)
        if isinstance(raw, int):
            complete[brand_name] = max(raw, len(in_data))
        elif isinstance(raw, list):
            complete[brand_name] = len(in_data | set(raw))
        elif isinstance(raw, dict):
            extras = set(raw.get("x") or []) - in_data
            stored = int(raw.get("n") or 0)
            complete[brand_name] = max(stored, len(in_data | extras))
        else:
            complete[brand_name] = len(in_data)


def merge_complete_phones(data, devices_or_store, brand_name):
    if SKIP_SEED_COMPLETE:
        raw = (data["progress"].get("complete_phones") or {}).get(brand_name)
        if isinstance(raw, list):
            return set(raw)
        if isinstance(raw, dict):
            return set(raw.get("x") or [])
        if isinstance(raw, int):
            return set()
        return set()
    return _merge_complete_phones_raw(data["progress"], devices_or_store, brand_name)


def unique_phones_in_data(devices, brand_name):
    b = (brand_name or "").lower()
    return {
        d["hardware_name"]
        for d in devices
        if (d.get("hardware_vendor") or "").lower() == b and d.get("hardware_name")
    }


def get_effective_start_index(brands, data, quiet=False, devices_or_store=None):
    migrate_progress(data)
    progress = data["progress"]
    listed_map = progress.get("listed_phones", {})
    saved_index = progress.get("brand_index", 0)
    store = devices_or_store or get_store(data)

    for idx, brand in enumerate(brands):
        brand_name = brand["brand"]
        # Never resume at a vendor we refuse to crawl — otherwise the whole
        # MAX_BRANDS_PER_RUN window can be skip-only and nothing new is fetched.
        if brand_name in SKIP_VENDORS:
            continue

        stored_count = len(store.phones_for_vendor(brand_name))
        listed_count = listed_map.get(brand_name)

        if listed_count is None:
            if stored_count > 0 and idx < saved_index:
                return idx
            if idx == 0 and saved_index > 0:
                return 0
            continue

        if stored_count < listed_count:
            if not quiet:
                log_message(
                    data,
                    f"Resuming incomplete brand {brand_name} "
                    f"({stored_count}/{listed_count} phones in dataset)",
                )
            return idx

    return min(saved_index, len(brands))


def is_valid_model_code(code):
    if not code:
        return False
    normalized = code.strip().lower().replace("-", "")
    if normalized in MODEL_SKIP or len(normalized) < 4:
        return False
    return bool(RE_VALID_MODEL_DIGIT.search(normalized))


def vendor_model_dedupe_key(vendor, model):
    """Canonical (vendor, model) for duplicate checks across stored JSON and GSM parses."""
    v = (vendor or "").strip().lower()
    if not isinstance(model, str):
        model = str(model) if model is not None else ""
    m = model.strip().lower().replace("-", "")
    return (v, m)


def expand_model_token(token):
    normalized = token.strip().lower().replace("-", "")
    if not normalized:
        return []

    if "/" in normalized:
        base, suffix = normalized.split("/", 1)
        base = base.strip()
        suffix = suffix.strip()
        expanded = []
        if is_valid_model_code(base):
            expanded.append(base)
        if suffix:
            if suffix in ("ds", "dsn") and RE_DS_COMBINED.search(base):
                combined = base[:-1] + suffix
            else:
                combined = f"{base}{suffix}"
            if is_valid_model_code(combined) and combined not in expanded:
                expanded.append(combined)
        return expanded

    return [normalized] if is_valid_model_code(normalized) else []


def collect_models_from_device(device):
    models = []
    model = device.get("model")
    if model and model != NA:
        for code in expand_model_token(model):
            if code not in models:
                models.append(code)

    variants = device.get("hardware_model_variants", "")
    if variants and variants != NA:
        for part in variants.split(","):
            for code in expand_model_token(part):
                if code not in models:
                    models.append(code)

    return models


def dedupe_devices(devices):
    """One stored row per (vendor, model) when model is a valid code.

    GSM Arena often lists the same FCC / regional model numbers on several
    product pages (e.g. Apple Watch aluminum vs generic vs edition). Those
    rows are the same SKU; keeping them produced duplicate JSON keys like
    apple_watchseries6_a2294 while model was already a2294.
    """
    by_key = {}
    for device in devices:
        for field in REMOVED_FIELDS:
            device.pop(field, None)

        models = collect_models_from_device(device)
        if not models:
            models = [device.get("model") or NA]

        for model_code in models:
            entry = dict(device)
            entry["model"] = na(model_code)
            vendor = entry.get("hardware_vendor")
            name = entry.get("hardware_name")
            model_val = entry.get("model")

            if (
                vendor
                and model_val
                and model_val != NA
                and is_valid_model_code(model_val)
            ):
                key = ("vm", vendor, model_val)
            else:
                key = ("vnm", vendor, name, model_val)

            formatted = format_device_entry(entry)
            existing = by_key.get(key)
            if existing is None:
                by_key[key] = formatted
                continue

            # Prefer the shorter hardware_name (main listing vs regional variant page).
            old_name = existing.get("hardware_name") or ""
            new_name = formatted.get("hardware_name") or ""
            if len(new_name) < len(old_name) or (
                len(new_name) == len(old_name) and new_name < old_name
            ):
                by_key[key] = formatted

    return list(by_key.values())


# ---------------------------------
# HTML PARSING HELPERS
# ---------------------------------

def parse_spec_rows(html):
    soup = _soup(html)
    specs = {}

    for row in soup.select("table tr"):
        label_cell = row.select_one("td.ttl, th.ttl")
        if not label_cell:
            continue

        label = label_cell.get_text(" ", strip=True).lower()
        value_cells = row.select("td.nfo")
        if not value_cells:
            value_cell = label_cell.find_next_sibling("td")
            if value_cell:
                value_cells = [value_cell]

        if not value_cells:
            continue

        value = " ".join(cell.get_text(" ", strip=True) for cell in value_cells)
        if label and value:
            specs[label] = value

    return specs


def parse_resolution(text):
    if not text:
        return NA, NA
    match = RE_RESOLUTION.search(text)
    if match:
        return match.group(1), match.group(2)
    return NA, NA


def parse_screen_inches(text):
    if not text:
        return NA
    match = RE_SCREEN_INCHES.search(text)
    return match.group(1) if match else NA


def parse_os_fields(os_text):
    if not os_text:
        return NA, NA, NA, NA, NA

    os_lower = os_text.lower()
    operating_system = NA
    platform_name = NA
    platform_vendor = NA
    platform_version = NA
    os_version = NA

    if "ios" in os_lower or "ipados" in os_lower:
        operating_system = "iOS"
        platform_name = "iOS"
        platform_vendor = "Apple"
    elif "android" in os_lower:
        operating_system = "Android"
        platform_name = "Android"
        platform_vendor = "Google"
    elif "harmony" in os_lower:
        operating_system = "HarmonyOS"
        platform_name = "HarmonyOS"
        platform_vendor = "Huawei"
    else:
        operating_system = os_text.split(",")[0].strip()

    version_matches = re.findall(
        r"(?:ios|android|ipados|harmonyos)\s*([\d.]+)",
        os_lower,
        flags=re.IGNORECASE,
    )
    if version_matches:
        platform_version = version_matches[-1]
        os_version = version_matches[-1]

    return operating_system, platform_name, platform_vendor, platform_version, os_version


def infer_browser_fields(platform_name, operating_system):
    platform = (platform_name or operating_system or "").lower()

    if platform == "ios":
        return {
            "browser_name": "Mobile Safari",
            "browser_vendor": "Apple",
            "browser_type": "mobile browser",
            "rendering_engine": "WebKit",
            "android_webview": NA,
            "default_app_stores": "App Store",
        }

    if platform == "android":
        return {
            "browser_name": "Chrome Mobile",
            "browser_vendor": "Google",
            "browser_type": "mobile browser",
            "rendering_engine": "Blink",
            "android_webview": "true",
            "default_app_stores": "Google Play",
        }

    return {
        "browser_name": NA,
        "browser_vendor": NA,
        "browser_type": NA,
        "rendering_engine": NA,
        "android_webview": NA,
        "default_app_stores": NA,
    }


def infer_cpu_architecture(chipset_text, cpu_text):
    combined = f"{chipset_text or ''} {cpu_text or ''}".lower()
    if not combined.strip():
        return NA
    if any(token in combined for token in ("arm", "apple a", "snapdragon", "exynos", "dimensity", "kirin", "helio", "unisoc")):
        return "ARM"
    if "x86" in combined or "intel" in combined or "amd" in combined:
        return "x86"
    return NA


def parse_supported_bearers(specs):
    parts = []
    for key in ("technology", "2g bands", "3g bands", "4g bands", "5g bands", "speed"):
        value = specs.get(key)
        if not value:
            continue
        if "5g" in value.lower():
            parts.append("5G")
        if "lte" in value.lower() or "4g" in value.lower():
            parts.append("4G")
        if "hspa" in value.lower() or "3g" in value.lower():
            parts.append("3G")
        if "gsm" in value.lower() or "2g" in value.lower():
            parts.append("2G")

    unique = []
    for bearer in ("5G", "4G", "3G", "2G"):
        if bearer in parts and bearer not in unique:
            unique.append(bearer)

    return ", ".join(unique) if unique else NA


def parse_device_type(specs, hardware_name=""):
    for key in ("type", "body", "form factor"):
        value = specs.get(key, "")
        if not value:
            continue
        lower = value.lower()
        if "mah" in lower or "battery" in lower or "li-ion" in lower or "li-po" in lower:
            continue
        return value

    name = (hardware_name or "").lower()
    if "watch" in name:
        return "smartwatch"
    if "tab" in name or "pad" in name:
        return "tablet"
    return "smartphone"


def fix_device_type_value(value, hardware_name=""):
    if not value or value == NA:
        return parse_device_type({}, hardware_name)
    lower = str(value).lower()
    if "mah" in lower or "battery" in lower or "li-ion" in lower or "li-po" in lower:
        return parse_device_type({}, hardware_name)
    return value


def is_valid_device_entry(device):
    if not device.get("hardware_vendor") or not device.get("hardware_name"):
        return False
    chipset = device.get("SoC") or device.get("hardware_chipset")
    model = device.get("model")
    if chipset in (None, "", NA) and model in (None, "", NA):
        return False
    return True


def format_device_entry(device):
    for field in REMOVED_FIELDS:
        device.pop(field, None)

    vendor = na(device.get("hardware_vendor"))
    name = na(device.get("hardware_name"))
    model = na(device.get("model"))
    chipset = device.get("SoC") or device.get("hardware_chipset")
    cpu = device.get("CPU") or device.get("hardware_cpu")
    gpu = device.get("GPU") or device.get("hardware_gpu")

    return {
        "model": model,
        "hardware_vendor": vendor,
        "oem": vendor,
        "hardware_name": name,
        "hardware_family": name,
        "hardware_name_version": na(device.get("hardware_name_version")),
        "device_type": fix_device_type_value(
            device.get("device_type"), device.get("hardware_name", "")
        ),
        "screen_inches_diagonal": na(device.get("screen_inches_diagonal")),
        "screen_pixels_width": na(device.get("screen_pixels_width")),
        "screen_pixels_height": na(device.get("screen_pixels_height")),
        "supported_bearers": na(device.get("supported_bearers")),
        "cpu_architecture": na(device.get("cpu_architecture")),
        "approx_device_age": na(device.get("approx_device_age")),
        "CPU": na(cpu),
        "GPU": na(gpu),
        "SoC": na(chipset),
    }


def normalize_device_record(device):
    return format_device_entry(dict(device))


def repair_json_file(path):
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    if '"progress"' in text and "\n  ],\n  \"progress\"" not in text:
        text = re.sub(
            r'\},\s*\n\s*\n\s*"progress"\s*:',
            '\n    }\n  ],\n  "progress":',
            text,
            count=1,
        )
        if "\n  ],\n  \"progress\"" not in text:
            text = text.replace('\n  "progress":', '\n  ],\n  "progress":', 1)

    return json.loads(text)


def parse_approx_device_age(specs):
    announced = specs.get("announced") or specs.get("status") or ""
    years = RE_YEAR.findall(announced)
    if not years:
        return NA

    release_year = int(years[-1])
    current_year = time.localtime().tm_year
    age = max(0, current_year - release_year)
    return str(age)


def extract_models_from_specs(specs):
    models_text = specs.get("models", "")
    if not models_text:
        return []

    models = []
    for part in models_text.split(","):
        for code in expand_model_token(part):
            if code not in models:
                models.append(code)

    return models


def normalize_device_name(raw_name, brand_name):
    name_without_brand = raw_name.replace(brand_name, "")
    name_without_brand = RE_DEVICE_YEAR_PAREN.sub("", name_without_brand)
    name_without_brand = RE_DEVICE_YEAR_WORD.sub("", name_without_brand)

    gen_match = re.search(r"\((.*?)\)", name_without_brand)
    generation_suffix = ""

    if gen_match:
        gen_text = gen_match.group(1).lower()
        gen_text = gen_text.replace("generation", "")
        gen_text = gen_text.replace("gen", "")
        gen_text = re.sub(r"(st|nd|rd|th)", "", gen_text)
        gen_number = re.findall(r"\d+", gen_text)
        if gen_number:
            generation_suffix = gen_number[0]

    name_without_brand = re.sub(r"\(.*?\)", "", name_without_brand)

    clean_name = (
        name_without_brand.replace("+", "plus").replace("-", "").replace(".", "").lower().strip()
    )
    clean_name = re.sub(r"\s+", "", clean_name)

    if generation_suffix:
        clean_name += generation_suffix

    return clean_name


def build_device_entry(brand_name, clean_name, raw_name, model_code, specs):
    chipset = specs.get("chipset", "")
    cpu = specs.get("cpu", "")
    gpu = specs.get("gpu", "")
    resolution_text = specs.get("resolution", "")
    size_text = specs.get("size", "")
    width, height = parse_resolution(resolution_text)

    return format_device_entry(
        {
            "model": na(model_code),
            "hardware_vendor": brand_name,
            "hardware_name": clean_name,
            "hardware_name_version": raw_name,
            "hardware_chipset": chipset,
            "hardware_cpu": cpu,
            "hardware_gpu": gpu,
            "device_type": parse_device_type(specs, clean_name),
            "screen_inches_diagonal": parse_screen_inches(size_text),
            "screen_pixels_width": width,
            "screen_pixels_height": height,
            "supported_bearers": parse_supported_bearers(specs),
            "cpu_architecture": infer_cpu_architecture(chipset, cpu),
            "approx_device_age": parse_approx_device_age(specs),
        }
    )


# ---------------------------------
# GSM ARENA CRAWL STEPS
# ---------------------------------

def get_brands():
    html = fetch_html(BASE + "makers.php3")
    if not html:
        return []

    soup = _soup(html)
    return [
        {"brand": anchor.text.strip().lower(), "url": normalize_url(anchor["href"])}
        for anchor in soup.select(".brandmenu-v2 li a")
    ]


def get_brand_listing_urls(brand_url, soup):
    urls = [brand_url]
    max_page = 1
    page_template = None

    for anchor in soup.select(".nav-pages a[href]"):
        href = anchor.get("href", "").strip()
        match = RE_LISTING_PAGE.search(href)
        if not match:
            continue
        max_page = max(max_page, int(match.group(1)))
        if page_template is None:
            page_template = re.sub(r"-p\d+\.php$", "-p{page}.php", href)

    if max_page <= 1 or not page_template:
        return urls

    for page in range(2, max_page + 1):
        urls.append(normalize_url(page_template.format(page=page)))

    return urls


def get_latest_devices(brand_url):
    all_devices = []
    seen_hrefs = set()

    first_html = fetch_html(brand_url, expect_devices=True)
    if not first_html:
        return []

    first_soup = _soup(first_html)
    page_urls = get_brand_listing_urls(brand_url, first_soup)

    for page_num, page_url in enumerate(page_urls):
        if page_num == 0:
            html, soup = first_html, first_soup
        else:
            time.sleep(PAGE_DELAY_SEC)
            html = fetch_html(page_url, expect_devices=True)
            if not html:
                print(f"⚠ Skipping page {page_num + 1}/{len(page_urls)}: {page_url}")
                continue
            soup = _soup(html)

        for item in soup.select(".makers li a"):
            href = normalize_url(item["href"])
            if href in seen_hrefs:
                continue
            seen_hrefs.add(href)
            all_devices.append((href, item.text.strip().lower()))

    return all_devices


def get_first_page_devices(brand_url):
    """First brand listing page only — GSM usually shows newest phones first."""
    first_html = fetch_html(brand_url, expect_devices=True)
    if not first_html:
        return []

    soup = _soup(first_html)
    out = []
    seen_hrefs = set()
    for item in soup.select(".makers li a"):
        href = normalize_url(item["href"])
        if href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        out.append((href, item.text.strip().lower()))
    return out


def extract_device_specs(device_url):
    html = fetch_html(device_url, expect_specs=True)
    if not html:
        return {}, []

    specs = parse_spec_rows(html)
    models = extract_models_from_specs(specs)
    return specs, models


# ---------------------------------
# MAIN UPDATE
# ---------------------------------

def check_fetch_health():
    global _gsmarena_rate_limited

    test_url = BASE + "makers.php3"
    log_message(None, "Testing fetch access...")

    if FIRECRAWL_API_KEY and USE_FIRECRAWL:
        html = firecrawl_fetch(test_url)
        if html:
            log_message(None, "✓ Firecrawl is working (new key has credits).")
        elif _firecrawl_disabled:
            log_message(
                None,
                "✗ Firecrawl returned 402 — new key has no credits. "
                "Add billing at firecrawl.dev or scraping will use direct fetch only.",
            )
        else:
            if DISABLE_DIRECT_GSM:
                log_message(
                    None,
                    "✗ Firecrawl failed — direct GSM disabled (DISABLE_DIRECT_GSM); fix key or credits.",
                )
            else:
                log_message(None, "✗ Firecrawl failed — will try direct fetch.")

    if DISABLE_DIRECT_GSM:
        log_message(None, "Skipping direct GSM health check (DISABLE_DIRECT_GSM).")
    else:
        response = requests.get(test_url, headers=HTTP_HEADERS, timeout=30)
        if response.status_code == 200:
            log_message(None, "✓ Direct GSM Arena access is working.")
        elif response.status_code == 429:
            _gsmarena_rate_limited = True
            log_message(
                None,
                "✗ GSM Arena is rate-limiting your IP (429). "
                "Direct fetch disabled for this run — use Firecrawl with credits.",
            )
        else:
            log_message(None, f"✗ Direct GSM Arena returned HTTP {response.status_code}.")


def run_update():
    global _firecrawl_disabled
    _firecrawl_disabled = False

    data = load_data()
    store = get_store(data)
    print(f"Dataset: {OUTPUT_FILE} ({len(store)} entries loaded)")

    if FIRECRAWL_API_KEY and USE_FIRECRAWL:
        log_message(data, "Firecrawl API key detected — will try Firecrawl first.")
    elif FIRECRAWL_API_KEY:
        log_message(data, "Firecrawl disabled (USE_FIRECRAWL=false) — direct fetch only.")
    else:
        log_message(data, "No Firecrawl key — using direct fetch to GSM Arena only.")

    if DISABLE_DIRECT_GSM:
        log_message(
            data,
            "DISABLE_DIRECT_GSM=1 — your IP will not hit GSM Arena (Firecrawl only).",
        )

    if SAVE_EVERY_N_PHONES > 1:
        log_message(
            data,
            f"⚠ SMARTPHONE_SAVE_EVERY_N_PHONES={SAVE_EVERY_N_PHONES} "
            f"(fewer disk writes; crash can lose up to that many unsaved phones).",
        )

    check_fetch_health()

    existing_devices = store.model_keys

    brands = get_brands()
    if not brands:
        log_message(data, "❌ Could not fetch brands.")
        save_data(data)
        return

    start_index = get_effective_start_index(brands, data, devices_or_store=store)
    total_brands = len(brands)

    if start_index >= total_brands:
        log_message(
            data,
            f"All {total_brands} brands already processed. "
            f"Set progress.brand_index to 0 in {os.path.basename(PROGRESS_FILE)} to re-scan.",
        )
        save_data(data)
        return

    end_index = min(start_index + MAX_BRANDS_PER_RUN, total_brands)
    log_message(
        data,
        f"Processing brands {start_index}–{end_index - 1} of {total_brands} "
        f"({end_index - start_index} this run)",
    )

    for index in range(start_index, end_index):
        brand = brands[index]
        brand_name = brand["brand"]

        if brand_name in SKIP_VENDORS:
            stored_now = len(store.phones_for_vendor(brand_name))
            data["progress"].setdefault("listed_phones", {})[brand_name] = stored_now
            set_progress(data, index + 1)
            log_message(
                data,
                f"⏭ Skipping vendor {brand_name} (SKIP_VENDORS). "
                f"Resume targets this brand at {stored_now} phones in dataset; "
                f"next run starts around brand index {index + 1}.",
            )
            save_data(data)
            continue

        log_message(data, f"\n🔍 Checking {brand_name}")

        device_list = get_latest_devices(brand["url"])
        if not device_list:
            log_message(
                data,
                f"⚠ No devices parsed for {brand_name} — check {brand['url']}",
            )
            save_data(data)
            continue

        listing_phones = {
            normalize_device_name(raw_name, brand_name) for _, raw_name in device_list
        }
        listed_count = len(listing_phones)

        log_message(
            data,
            f"   Found {listed_count} phones across listing pages for {brand_name}",
        )

        data["progress"].setdefault("listed_phones", {})[brand_name] = listed_count

        complete_phones = merge_complete_phones(data, store, brand_name)
        phones_to_fetch = listed_count - len(complete_phones)
        log_message(
            data,
            f"   {len(complete_phones)} phones already complete, "
            f"~{max(0, phones_to_fetch)} left to fetch",
        )
        log_message(
            data,
            "   Next: walk each listing row — first Firecrawl spec fetch can take 30–120s with no new lines; "
            "skips are logged every 25 rows.",
        )

        skipped = 0
        added = 0
        fetch_failures = 0
        phones_since_save = 0
        pending_spec_fetches = 0
        total_list = len(device_list)

        for phone_index, (device_url, raw_name) in enumerate(device_list, start=1):
            clean_name = normalize_device_name(raw_name, brand_name)

            if phone_index == 1 or phone_index % 25 == 0:
                log_message(
                    data,
                    f"   … row {phone_index}/{total_list} "
                    f"(skipped={skipped}, new_rows={added}, fetch_failures={fetch_failures})",
                )

            if clean_name in complete_phones:
                skipped += 1
                if skipped > 0 and skipped % 25 == 0:
                    log_message(data, f"   … skipped {skipped} already-complete rows")
                continue

            pending_spec_fetches += 1
            if pending_spec_fetches <= 5 or pending_spec_fetches % 8 == 0:
                log_message(
                    data,
                    f"   … Firecrawl/spec fetch #{pending_spec_fetches}: {clean_name!r} "
                    f"(row {phone_index}/{total_list})…",
                )

            specs, models = extract_device_specs(device_url)
            valid_models = [m for m in models if is_valid_model_code(m)]

            if not specs:
                fetch_failures += 1
                if fetch_failures <= 5 or fetch_failures % 20 == 0:
                    log_message(
                        data,
                        f"   ⚠ Fetch failed for {clean_name} "
                        f"({fetch_failures} failures this brand)",
                    )
                continue

            models_to_add = [
                m
                for m in valid_models
                if vendor_model_dedupe_key(brand_name, m) not in existing_devices
            ]

            if not models_to_add:
                mark_phone_complete(data["progress"], brand_name, clean_name, store)
                complete_phones.add(clean_name)
                skipped += 1
                continue

            log_message(
                data,
                f"🆕 {brand_name} {clean_name}: adding {len(models_to_add)} model(s) "
                f"({phone_index}/{listed_count})",
            )

            for model_code in models_to_add:
                entry = build_device_entry(
                    brand_name, clean_name, raw_name, model_code, specs
                )
                store.add_entry(entry, existing_devices)
                added += 1

            mark_phone_complete(data["progress"], brand_name, clean_name, store)
            complete_phones.add(clean_name)

            log_message(
                data,
                f"   ➕ {clean_name}: {', '.join(models_to_add)}",
            )
            phones_since_save += 1
            if phones_since_save >= SAVE_EVERY_N_PHONES:
                save_data(data)
                phones_since_save = 0
            time.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))

        if phones_since_save:
            save_data(data)

        stored_count = len(store.phones_for_vendor(brand_name))
        log_message(
            data,
            f"   {brand_name}: {added} new entries, {skipped} phones skipped, "
            f"{stored_count}/{listed_count} phones in dataset",
        )

        if stored_count < listed_count:
            set_progress(data, index)
            save_data(data)
            log_message(
                data,
                f"   ↻ {brand_name} not complete — will continue from brand {index} next run",
            )
        else:
            set_progress(data, index + 1)
            save_data(data)
            log_message(data, f"   ✓ Finished {brand_name}, resume at brand {index + 1}")

    if end_index >= total_brands:
        set_progress(data, total_brands)
        log_message(data, f"   All {total_brands} brands processed.")

    log_message(data, "\n✅ Update completed.")
    save_data(data)


def run_quick_update():
    """For every brand: compare GSM page-1 listings to rows in the cache (hardware_vendor + hardware_name).

    Any normalized listing title missing from the dataset is spec-fetched and new (vendor, model) rows
    are appended. Progress alone does not hide a missing phone — only existing device rows do.
    """
    global _firecrawl_disabled
    _firecrawl_disabled = False

    data = load_data()
    store = get_store(data)
    print(f"Dataset: {OUTPUT_FILE} ({len(store)} entries loaded)")

    if FIRECRAWL_API_KEY and USE_FIRECRAWL:
        log_message(data, "Firecrawl API key detected — will try Firecrawl first.")
    elif FIRECRAWL_API_KEY:
        log_message(data, "Firecrawl disabled (USE_FIRECRAWL=false) — direct fetch only.")
    else:
        log_message(data, "No Firecrawl key — using direct fetch to GSM Arena only.")

    if DISABLE_DIRECT_GSM:
        log_message(
            data,
            "DISABLE_DIRECT_GSM=1 — your IP will not hit GSM Arena (Firecrawl only).",
        )

    if SAVE_EVERY_N_PHONES > 1:
        log_message(
            data,
            f"⚠ SMARTPHONE_SAVE_EVERY_N_PHONES={SAVE_EVERY_N_PHONES} "
            f"(fewer disk writes; crash can lose up to that many unsaved phones).",
        )

    check_fetch_health()

    existing_devices = store.model_keys
    brands = get_brands()
    if not brands:
        log_message(data, "❌ Could not fetch brands.")
        save_data(data)
        return

    log_message(
        data,
        f"Quick-update: page 1 vs your dataset ({len(brands)} brands). "
        "Missing normalized names are fetched and added; "
        "use full `python3 main.py` for deeper listing pages.",
    )

    grand_added = 0
    for index, brand in enumerate(brands):
        brand_name = brand["brand"]
        if brand_name in SKIP_VENDORS:
            log_message(data, f"⏭ {brand_name}: SKIP_VENDORS — skipped")
            continue

        log_message(data, f"\n📋 Quick-update: {brand_name} (listing page 1)")
        device_list = get_first_page_devices(brand["url"])
        if not device_list:
            log_message(data, f"   ⚠ No devices parsed — {brand['url']}")
            time.sleep(PAGE_DELAY_SEC)
            continue

        # Source of truth: device rows in model_parse_cache (normalized hardware_name per vendor).
        # Do not treat progress-only "complete" markers as covering a phone that has no row yet.
        phones_in_dataset = store.phones_for_vendor(brand_name)
        complete_phones = set(phones_in_dataset)
        to_process = []
        missing_from_dataset = 0
        for device_url, raw_name in device_list:
            clean_name = normalize_device_name(raw_name, brand_name)
            if clean_name not in phones_in_dataset:
                to_process.append((device_url, raw_name))
                missing_from_dataset += 1

        # Optionally re-check the first N links on page 1 for new model codes even when the
        # listing title already matches an existing hardware_name.
        recheck_extra = 0
        if QUICK_UPDATE_RECHECK_FIRST > 0:
            seen_urls = {u for u, _ in to_process}
            head = device_list[:QUICK_UPDATE_RECHECK_FIRST]
            for pair in reversed(head):
                u, _ = pair
                if u not in seen_urls:
                    to_process.insert(0, pair)
                    seen_urls.add(u)
                    recheck_extra += 1

        log_message(
            data,
            f"   Page 1: {len(device_list)} listings — "
            f"{missing_from_dataset} normalized name(s) not in model_parse_cache yet; "
            f"{recheck_extra} extra top-of-page re-fetch(es) "
            f"(QUICK_UPDATE_RECHECK_FIRST={QUICK_UPDATE_RECHECK_FIRST}); "
            f"{len(to_process)} spec fetch(es) queued.",
        )
        if not to_process:
            log_message(
                data,
                "   Nothing queued: every page-1 listing matches a hardware_name already in your "
                "dataset for this vendor, and QUICK_UPDATE_RECHECK_FIRST=0 so no forced re-fetch.",
            )
            log_message(
                data,
                "   To still re-scan the top of page 1 for new model codes (FCC/regional), run e.g.: "
                "QUICK_UPDATE_RECHECK_FIRST=3 python3 main.py --quick-update",
            )
            time.sleep(PAGE_DELAY_SEC)
            continue

        skipped = 0
        added = 0
        fetch_failures = 0
        phones_since_save = 0
        pending_spec_fetches = 0
        total_list = len(to_process)
        page_size = len(device_list)

        for phone_index, (device_url, raw_name) in enumerate(to_process, start=1):
            clean_name = normalize_device_name(raw_name, brand_name)

            if phone_index == 1 or phone_index % 10 == 0:
                log_message(
                    data,
                    f"   … quick row {phone_index}/{total_list} "
                    f"(skipped={skipped}, new_rows={added}, fetch_failures={fetch_failures})",
                )

            pending_spec_fetches += 1
            if pending_spec_fetches <= 3 or pending_spec_fetches % 6 == 0:
                log_message(
                    data,
                    f"   … spec fetch #{pending_spec_fetches}: {clean_name!r} "
                    f"({phone_index}/{total_list} queued)…",
                )

            specs, models = extract_device_specs(device_url)
            valid_models = [m for m in models if is_valid_model_code(m)]

            if not specs:
                fetch_failures += 1
                if fetch_failures <= 3 or fetch_failures % 10 == 0:
                    log_message(
                        data,
                        f"   ⚠ Fetch failed for {clean_name} ({fetch_failures} failures)",
                    )
                continue

            models_to_add = [
                m
                for m in valid_models
                if vendor_model_dedupe_key(brand_name, m) not in existing_devices
            ]

            if not models_to_add:
                if valid_models:
                    log_message(
                        data,
                        f"   ↪ {clean_name}: specs OK — model(s) {valid_models[:6]}"
                        f"{'…' if len(valid_models) > 6 else ''} already in cache (no new row)",
                    )
                else:
                    log_message(
                        data,
                        f"   ↪ {clean_name}: specs OK — no valid model codes parsed from GSM page",
                    )
                mark_phone_complete(data["progress"], brand_name, clean_name, store)
                complete_phones.add(clean_name)
                skipped += 1
                continue

            log_message(
                data,
                f"🆕 {brand_name} {clean_name}: adding {len(models_to_add)} model(s) "
                f"(quick {phone_index}/{total_list}, page1/{page_size})",
            )

            for model_code in models_to_add:
                entry = build_device_entry(
                    brand_name, clean_name, raw_name, model_code, specs
                )
                store.add_entry(entry, existing_devices)
                added += 1

            mark_phone_complete(data["progress"], brand_name, clean_name, store)
            complete_phones.add(clean_name)

            log_message(data, f"   ➕ {clean_name}: {', '.join(models_to_add)}")
            phones_since_save += 1
            if phones_since_save >= SAVE_EVERY_N_PHONES:
                save_data(data)
                phones_since_save = 0
            time.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))

        if phones_since_save:
            save_data(data)

        grand_added += added
        log_message(
            data,
            f"   {brand_name} quick summary: +{added} new rows, {skipped} skipped, "
            f"{fetch_failures} fetch failures",
        )
        time.sleep(PAGE_DELAY_SEC)

    log_message(data, f"\n✅ Quick-update finished. Total new rows this run: {grand_added}")
    save_data(data)


def fix_output():
    if not os.path.exists(OUTPUT_FILE):
        print(f"No dataset file found at {OUTPUT_FILE}.")
        return

    try:
        with open(OUTPUT_FILE, "r", encoding="utf-8") as handle:
            json.load(handle)
        print(f"Loaded {OUTPUT_FILE} (valid JSON).")
        data = load_data()
    except json.JSONDecodeError:
        print("Repairing broken JSON structure...")
        norm = normalize_loaded_data(repair_json_file(OUTPUT_FILE))
        progress = load_progress_file() or norm.get("progress", {"brand_index": 0})
        data = {
            "_store": CacheDataset(devices_list_to_map(norm["devices"])),
            "progress": progress,
        }
        migrate_progress(data)

    store = get_store(data)
    before = len(store)
    valid = []
    removed = 0
    for device in store.as_list():
        if not is_valid_device_entry(device):
            removed += 1
            continue
        valid.append(normalize_device_record(device))

    data["_store"] = CacheDataset({})
    for entry in dedupe_devices(valid):
        data["_store"].add_entry(entry)
    save_data(data)

    print(f"Fixed {OUTPUT_FILE}:")
    print(f"  Removed invalid/empty entries: {removed}")
    print(f"  Device entries: {before} → {len(data['_store'])}")
    print(f"  Resume brand index: {get_progress(data)}")
    print(f"  Listed phones: {data['progress'].get('listed_phones', {})}")


def clean_output():
    fix_output()


def repair_progress():
    """Rebuild listed_phones / complete_phones from GSM + cache file (fixes truncated progress.json)."""
    data = load_data()
    store = get_store(data)
    brands = get_brands()
    if not brands:
        print("❌ Could not fetch GSM Arena brand list.")
        return

    import sys

    force_gsm = "--force-gsm" in sys.argv
    brand_by = {b["brand"]: b for b in brands}
    progress = data["progress"]
    listed = progress.setdefault("listed_phones", {})
    vendors = sorted(store.phones_by_vendor.keys())

    print(f"Vendors in cache: {len(vendors)}")
    for i, v in enumerate(vendors, start=1):
        if v not in brand_by:
            n = len(store.phones_for_vendor(v))
            listed.setdefault(v, n)
            print(f"[{i}/{len(vendors)}] {v}: no GSM makers entry — listed_phones={listed[v]} (from dataset)")
            continue

        if not force_gsm and v in listed and listed[v] > 0:
            continue

        print(f"[{i}/{len(vendors)}] Fetching GSM listing count for {v}…")
        device_list = get_latest_devices(brand_by[v]["url"])
        if device_list:
            nlist = len(
                {normalize_device_name(raw_name, v) for _, raw_name in device_list}
            )
            listed[v] = max(listed.get(v, 0), nlist)
            print(f"   → listed_phones[{v}] = {listed[v]}")
        else:
            n = len(store.phones_for_vendor(v))
            listed[v] = max(listed.get(v, 0), n)
            print(f"   ⚠ GSM parse empty — listed_phones[{v}] = {listed[v]} (dataset floor)")

        save_data(data)
        if i < len(vendors):
            time.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))

    complete = progress.setdefault("complete_phones", {})
    for v in sorted(set(listed) | set(complete.keys()) | set(vendors)):
        complete[v] = len(store.phones_for_vendor(v))

    idx = get_effective_start_index(brands, data, quiet=True, devices_or_store=store)
    set_progress(data, idx)
    save_data(data)
    print(f"Done. Wrote {PROGRESS_FILE}; brand_index={idx}; listed_phones keys={len(listed)}")


if __name__ == "__main__":
    import sys

    if "--clean" in sys.argv or "--fix" in sys.argv:
        fix_output()
    elif "--repair-progress" in sys.argv:
        repair_progress()
    elif "--quick-update" in sys.argv:
        run_quick_update()
    else:
        run_update()
