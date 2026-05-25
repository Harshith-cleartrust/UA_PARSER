import fs from "node:fs/promises";
import path from "node:path";
import { normalizeModelKey, defaultDatasetPath } from "./deviceIndex.js";
import { prettifyHardwareSlug } from "./buildResult.js";

const CACHE_VERSION = 1;
const SOURCE = "model_parse_cache";

/**
 * Filled from live UA + Client Hints on every request — never read from or written to model cache.
 */
export const DYNAMIC_CACHE_FIELDS = new Set([
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
]);

/** API property name → snake_case cache field (hardware / device specs only) */
const PROPERTY_TO_CACHE_FIELD = {
  HardwareVendor: "hardware_vendor",
  OEM: "oem",
  HardwareFamily: "hardware_family",
  HardwareName: "hardware_name",
  HardwareNameVersion: "hardware_name_version",
  HardwareChipset: "hardware_chipset",
  HardwareCpu: "hardware_cpu",
  HardwareGpu: "hardware_gpu",
  DeviceType: "device_type",
  ScreenInchesDiagonal: "screen_inches_diagonal",
  ScreenPixelsWidth: "screen_pixels_width",
  ScreenPixelsHeight: "screen_pixels_height",
  SupportedBearers: "supported_bearers",
  "CPU Architecture": "cpu_architecture",
  "Approx Device Age": "approx_device_age",
};

/** snake_case cache field → API property names (one cache field may fill several rows) */
const CACHE_FIELD_TO_PROPERTIES = (() => {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const [prop, field] of Object.entries(PROPERTY_TO_CACHE_FIELD)) {
    const list = map.get(field) || [];
    list.push(prop);
    map.set(field, list);
  }
  return map;
})();

const HARDWARE_CACHE_FIELDS = new Set([
  "hardware_vendor",
  "oem",
  "hardware_name",
  "hardware_family",
  "hardware_name_version",
  "hardware_chipset",
  "hardware_cpu",
  "hardware_gpu",
  "screen_inches_diagonal",
  "screen_pixels_width",
  "screen_pixels_height",
  "supported_bearers",
]);

function cacheEnabled() {
  return process.env.MODEL_PARSE_CACHE === "1";
}

/** When on, hardware is read only from `model_parse_cache.json` (no HVMS / UA cache / GSMArena on the request path). */
export function modelParseCacheOnlyMode() {
  return cacheEnabled();
}

function cacheWritesEnabled() {
  return process.env.MODEL_PARSE_CACHE_WRITE === "1";
}

/** @type {{ version: number, entries: Record<string, object> } | null} */
let memoryStore = null;

function resolvedDatasetFilePath() {
  const d = process.env.DEVICE_DATASET?.trim();
  if (d) return path.resolve(process.cwd(), d);
  return defaultDatasetPath();
}

/** Default: `dataset_files/model_parse_cache.json` next to the HVMS dataset. */
export function modelParseCachePath() {
  const p = process.env.MODEL_PARSE_CACHE_PATH?.trim();
  if (p) return path.resolve(p);
  return path.join(path.dirname(resolvedDatasetFilePath()), "model_parse_cache.json");
}

function ttlMs() {
  const days = Number(process.env.MODEL_PARSE_CACHE_TTL_DAYS);
  const d = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 365;
  return d * 24 * 60 * 60 * 1000;
}

let writeChain = Promise.resolve();

function emptyStore() {
  return { version: CACHE_VERSION, entries: {} };
}

async function readStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return emptyStore();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error(
        "Model parse cache: invalid JSON, treating as empty:",
        parseErr?.message || parseErr,
        `(${filePath})`,
      );
      return emptyStore();
    }
    if (!data || data.version !== CACHE_VERSION || typeof data.entries !== "object") {
      return emptyStore();
    }
    return data;
  } catch (e) {
    if (e?.code === "ENOENT") return emptyStore();
    throw e;
  }
}

async function writeStore(filePath, store) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function rowByProperty(result, name) {
  return result.properties?.find((p) => p.property === name) || null;
}

function isEmptyValue(v) {
  return v == null || v === "" || v === "N/A";
}

function titleVendorFromSlug(slug) {
  if (!slug || slug === "N/A") return "N/A";
  return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
}

function vendorToCacheSlug(display) {
  if (!display || display === "N/A") return "";
  return String(display).trim().toLowerCase();
}

function androidWebViewToCache(val) {
  if (val == null || val === "") return "";
  const s = String(val).toLowerCase();
  if (s === "yes" || s === "true" || s === "1") return "true";
  if (s === "no" || s === "false" || s === "0") return "false";
  return s;
}

function androidWebViewFromCache(val) {
  if (val == null || val === "") return null;
  const s = String(val).toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return "Yes";
  if (s === "false" || s === "0" || s === "no") return "No";
  return String(val);
}

function cacheRawForField(field, cacheEntry) {
  if (!cacheEntry || typeof cacheEntry !== "object") return null;
  if (field === "hardware_family") {
    return cacheEntry.hardware_family ?? cacheEntry.hardware_name ?? null;
  }
  if (field === "oem") {
    return cacheEntry.oem ?? cacheEntry.hardware_vendor ?? null;
  }
  return cacheEntry[field] ?? null;
}

function cacheValueToProperty(field, raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw);
  if (field === "hardware_vendor" || field === "oem") return titleVendorFromSlug(s);
  if (field === "hardware_name" || field === "hardware_family") return prettifyHardwareSlug(s);
  if (field === "android_webview") return androidWebViewFromCache(s);
  return s;
}

function propertyValueToCache(field, propName, raw, result) {
  if (isEmptyValue(raw)) return null;
  if (field === "hardware_vendor" || field === "oem") return vendorToCacheSlug(raw);
  if (field === "hardware_name" || field === "hardware_family") {
    const slug = result?.debug?.datasetHardwareSlug;
    if (slug) return String(slug).toLowerCase();
    return String(raw)
      .toLowerCase()
      .replace(/\s+/g, "");
  }
  if (field === "android_webview") return androidWebViewToCache(raw);
  if (field === "model") return normalizeModelKey(result?.debug?.modelKey || raw);
  return String(raw);
}

function entryExpired(entry) {
  const savedMs = Date.parse(entry?.savedAt || "");
  if (!Number.isFinite(savedMs)) return false;
  return Date.now() - savedMs > ttlMs();
}

export function modelParseCacheStatus() {
  return {
    enabled: cacheEnabled(),
    onlyMode: modelParseCacheOnlyMode(),
    path: cacheEnabled() ? modelParseCachePath() : null,
    entryCount: memoryStore?.entries ? Object.keys(memoryStore.entries).length : null,
    ttlDays: cacheEnabled() ? ttlMs() / (24 * 60 * 60 * 1000) : null,
    keyFormat: "normalized model id (e.g. sms721u from SM-S721U)",
    writesEnabled: cacheWritesEnabled(),
  };
}

/** Load `model_parse_cache.json` into memory at startup (when MODEL_PARSE_CACHE=1). */
export async function loadModelParseCacheAtStartup() {
  if (!cacheEnabled()) return;
  memoryStore = await readStore(modelParseCachePath());
}

async function getStore() {
  if (memoryStore) return memoryStore;
  return readStore(modelParseCachePath());
}

export async function readModelParseCacheEntry(modelKey) {
  if (!cacheEnabled()) return null;
  const key = normalizeModelKey(modelKey);
  if (!key) return null;
  const store = await getStore();
  const hit = store.entries[key];
  if (!hit || typeof hit !== "object") return null;
  if (entryExpired(hit)) return null;
  return hit;
}

function cacheEntryHasMergeableHardware(entry) {
  if (!entry || typeof entry !== "object") return false;
  for (const field of HARDWARE_CACHE_FIELDS) {
    const v = entry[field];
    if (v != null && v !== "" && v !== "N/A") return true;
  }
  return false;
}

function shouldSkipOverwrite(row) {
  if (!row) return true;
  if (row.source === "gsmarena") return true;
  if (row.source === "ua_parse_cache" || row.source === SOURCE) return true;
  if (typeof row.source === "string" && row.source.startsWith("ua_parse_cache")) return true;
  return false;
}

/**
 * Fill empty property cells from a model-keyed snapshot (`entries[sms721u]`).
 * @returns {number} cells merged
 */
export function applyModelParseCacheToResult(result, cacheEntry, { forceOverwrite = false } = {}) {
  if (!cacheEnabled() || !result?.properties) {
    return 0;
  }
  if (!cacheEntry || typeof cacheEntry !== "object") {
    if (result.debug) {
      result.debug.modelParseCacheHit = false;
    }
    return 0;
  }

  let hc = "medium";
  const ms = result.debug?.modelSource;
  if (ms === "client_hint") hc = "high";
  else if (ms === "user_agent") hc = "medium";

  let merged = 0;
  const appliedProps = new Set();

  for (const [field, propNames] of CACHE_FIELD_TO_PROPERTIES) {
    const raw = cacheRawForField(field, cacheEntry);
    if (isEmptyValue(raw)) continue;
    const value = cacheValueToProperty(field, raw);
    if (value == null || value === "") continue;

    for (const propName of propNames) {
      if (appliedProps.has(propName)) continue;
      const row = rowByProperty(result, propName);
      if (!row) continue;
      if (!forceOverwrite && shouldSkipOverwrite(row)) continue;

      const curEmpty = isEmptyValue(row.value);
      if (!forceOverwrite && !curEmpty) continue;

      row.value = value;
      row.source = SOURCE;
      row.confidence = hc;
      appliedProps.add(propName);
      merged += 1;
    }
  }

  const vendor = rowByProperty(result, "HardwareVendor");
  const manufacturer = rowByProperty(result, "Manufacturer");
  if (
    manufacturer &&
    vendor &&
    !isEmptyValue(vendor.value) &&
    vendor.source === SOURCE &&
    (forceOverwrite || isEmptyValue(manufacturer.value) || manufacturer.source === "evidence")
  ) {
    manufacturer.value = vendor.value;
    manufacturer.source = SOURCE;
    manufacturer.confidence = hc;
    if (!appliedProps.has("Manufacturer")) merged += 1;
  }

  const hnv = rowByProperty(result, "HardwareNameVersion");
  if (
    hnv &&
    (forceOverwrite || !shouldSkipOverwrite(hnv)) &&
    (forceOverwrite || isEmptyValue(hnv.value)) &&
    !isEmptyValue(cacheEntry.hardware_name_version)
  ) {
    hnv.value = String(cacheEntry.hardware_name_version);
    hnv.source = SOURCE;
    hnv.confidence = hc;
    merged += 1;
  }

  if (result.debug) {
    if (merged > 0) {
      result.debug.modelParseCacheMergedFields = merged;
      result.debug.modelParseCacheSavedAt = cacheEntry.savedAt ?? null;
    }
    result.debug.modelParseCacheHit = merged > 0;
  }

  return merged;
}

export function stripDeviceDbForModelCacheLayer(result) {
  if (!cacheEnabled() || !Array.isArray(result.properties)) return;
  const stripProps = new Set([
    "HardwareFamily",
    "HardwareName",
    "HardwareNameVersion",
    "HardwareVendor",
    "OEM",
    "HardwareChipset",
    "HardwareCpu",
    "HardwareGpu",
    "ScreenInchesDiagonal",
    "ScreenPixelsWidth",
    "ScreenPixelsHeight",
    "SupportedBearers",
  ]);
  for (const row of result.properties) {
    if (row.source !== "device_db") continue;
    if (!stripProps.has(row.property)) continue;
    row.value = "N/A";
    row.source = "none";
    row.confidence = "unknown";
  }
}

export function applyModelParseCacheLayer(result, cacheEntry) {
  const force = modelParseCacheOnlyMode();
  if (cacheEntryHasMergeableHardware(cacheEntry)) {
    stripDeviceDbForModelCacheLayer(result);
  }
  return applyModelParseCacheToResult(result, cacheEntry, { forceOverwrite: force });
}

/** Apply hardware from model cache file only; returns cache entry or null. */
export async function resolveHardwareFromModelParseCache(result) {
  const modelKey = result?.debug?.modelKey;
  if (!modelKey) {
    if (result?.debug) result.debug.modelParseCacheHit = false;
    return null;
  }
  const cacheEntry = await readModelParseCacheEntry(modelKey);
  applyModelParseCacheLayer(result, cacheEntry);
  return cacheEntry;
}

/** Normalize a cache entry shape (adds hardware_family / oem, stable key order). */
export function normalizeModelCacheEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const model = entry.model ? String(entry.model).toLowerCase().replace(/-/g, "") : "";
  const hardware_vendor = entry.hardware_vendor || "";
  const hardware_name = entry.hardware_name || "";
  const normalized = {
    model,
    hardware_vendor,
    oem: entry.oem || hardware_vendor,
    hardware_name,
    hardware_family: entry.hardware_family || hardware_name,
    hardware_name_version: entry.hardware_name_version ?? "",
    hardware_chipset: entry.hardware_chipset ?? "",
    hardware_cpu: entry.hardware_cpu ?? "",
    hardware_gpu: entry.hardware_gpu ?? "",
    device_type: entry.device_type ?? "",
    screen_inches_diagonal: entry.screen_inches_diagonal ?? "",
    screen_pixels_width: entry.screen_pixels_width ?? "",
    screen_pixels_height: entry.screen_pixels_height ?? "",
    supported_bearers: entry.supported_bearers ?? "",
    cpu_architecture: entry.cpu_architecture ?? "",
    approx_device_age: entry.approx_device_age ?? "",
  };
  if (entry.savedAt) normalized.savedAt = entry.savedAt;
  return normalized;
}

/** Build snake_case record for `entries[modelKey]` from a completed parse result. */
export function modelCacheRecordFromResult(result) {
  const modelKey = normalizeModelKey(result?.debug?.modelKey || "");
  if (!modelKey) return null;

  const record = { model: modelKey };
  const seenFields = new Set();

  for (const row of result.properties || []) {
    const field = PROPERTY_TO_CACHE_FIELD[row.property];
    if (!field || seenFields.has(field) || DYNAMIC_CACHE_FIELDS.has(field)) continue;
    const v = propertyValueToCache(field, row.property, row.value, result);
    if (v == null || v === "") continue;
    record[field] = v;
    seenFields.add(field);
  }

  return normalizeModelCacheEntry(record);
}

export function shouldWriteModelParseCacheForResult(result) {
  if (!cacheEnabled() || !cacheWritesEnabled()) return false;
  const job = result?.lookupJob;
  if (job?.status === "queued" || job?.status === "running") return false;
  if (result?.gsmarena?.scheduled === true && result?.gsmarena?.match !== true) return false;
  const record = modelCacheRecordFromResult(result);
  if (!record?.model) return false;
  return Object.keys(record).length > 1;
}

export async function writeModelParseCacheFromResult(result) {
  if (!shouldWriteModelParseCacheForResult(result)) return;
  const record = modelCacheRecordFromResult(result);
  const key = record.model;
  const filePath = modelParseCachePath();
  const entry = {
    ...record,
    savedAt: new Date().toISOString(),
  };

  writeChain = writeChain.then(async () => {
    const store = memoryStore || (await readStore(filePath));
    store.entries[key] = entry;
    memoryStore = store;
    await writeStore(filePath, store);
  });
  await writeChain.catch((err) => {
    console.error("Model parse cache write error:", err?.message || err);
  });
}
