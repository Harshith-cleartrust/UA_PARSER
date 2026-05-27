import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDevice, normalizeModelKey, defaultDatasetPath } from "./deviceIndex.js";
import { prettifyHardwareSlug } from "./buildResult.js";

const CACHE_VERSION = 1;

function cacheEnabled() {
  return process.env.UA_PARSE_CACHE === "1";
}

function resolvedDatasetFilePath() {
  const d = process.env.DEVICE_DATASET?.trim();
  if (d) return path.resolve(process.cwd(), d);
  return defaultDatasetPath();
}

/** Same directory as `hvms_smartphone_hardware.json` (or `DEVICE_DATASET`), named `ua_parse_cache.json`. */
export function uaParseCachePath() {
  const p = process.env.UA_PARSE_CACHE_PATH?.trim();
  if (p) return path.resolve(p);
  return path.join(path.dirname(resolvedDatasetFilePath()), "ua_parse_cache.json");
}

function maxCacheEntries() {
  const n = Number(process.env.UA_PARSE_CACHE_MAX_ENTRIES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 400;
}

function ttlMs() {
  const days = Number(process.env.UA_PARSE_CACHE_TTL_DAYS);
  const d = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;
  return d * 24 * 60 * 60 * 1000;
}

/** Stable key: normalized UA + sorted JSON of client hints */
export function uaParseCacheKey(userAgent, clientHints) {
  const ua = String(userAgent || "")
    .trim()
    .replace(/\s+/g, " ");
  const hints = clientHints && typeof clientHints === "object" ? clientHints : {};
  const stableHints = JSON.stringify(hints, Object.keys(hints).sort());
  return createHash("sha256").update(`${ua}\n${stableHints}`).digest("hex");
}

/** Flat map for `ua_parse_cache.json`: { "BrowserName": "Chrome Mobile", … } */
export function propertiesMapForCache(result) {
  const map = {};
  if (!Array.isArray(result?.properties)) return map;
  for (const row of result.properties) {
    if (!row?.property) continue;
    map[row.property] = row.value == null || row.value === "" ? "N/A" : String(row.value);
  }
  return map;
}

function isLegacyPropertyArray(props) {
  return (
    Array.isArray(props) &&
    props.length > 0 &&
    props[0] != null &&
    typeof props[0] === "object" &&
    "property" in props[0]
  );
}

/** Normalize cache entry `properties` to a flat map (supports legacy array format). */
function cachedPropertyMapFromEntry(cacheEntry) {
  const raw = cacheEntry?.properties ?? cacheEntry?.payload?.properties;
  if (!raw) return null;
  if (isLegacyPropertyArray(raw)) {
    const map = {};
    for (const row of raw) {
      if (!row?.property) continue;
      map[row.property] = row.value == null || row.value === "" ? "N/A" : String(row.value);
    }
    return map;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return null;
}

let writeChain = Promise.resolve();

function emptyCacheStore() {
  return { version: CACHE_VERSION, entries: {} };
}

async function readStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return emptyCacheStore();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error(
        "UA parse cache: invalid JSON, treating as empty:",
        parseErr?.message || parseErr,
        `(${filePath})`,
      );
      return emptyCacheStore();
    }
    if (!data || data.version !== CACHE_VERSION || typeof data.entries !== "object") {
      return emptyCacheStore();
    }
    return data;
  } catch (e) {
    if (e?.code === "ENOENT") return emptyCacheStore();
    throw e;
  }
}

async function writeStore(filePath, store) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function pruneEntries(entries, max) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  const scored = keys.map((k) => ({
    k,
    t: Date.parse(entries[k]?.savedAt || "") || 0,
  }));
  scored.sort((a, b) => a.t - b.t);
  const drop = scored.length - max;
  const next = { ...entries };
  for (let i = 0; i < drop; i++) delete next[scored[i].k];
  return next;
}

/**
 * Fill `result.properties` from a prior snapshot when the fresh row is still N/A / none.
 * @returns {number} number of cells merged
 */
export function mergeUaParseCacheIntoResult(result, cacheEntry) {
  const cachedMap = cachedPropertyMapFromEntry(cacheEntry);
  if (!result?.properties || !cachedMap) return 0;
  const savedMs = Date.parse(cacheEntry.savedAt || "");
  if (!Number.isFinite(savedMs) || Date.now() - savedMs > ttlMs()) return 0;

  let merged = 0;
  for (const row of result.properties) {
    const prevVal = cachedMap[row.property];
    if (prevVal == null || prevVal === "" || prevVal === "N/A") continue;
    const curEmpty = row.value == null || row.value === "" || row.value === "N/A";
    if (!curEmpty) continue;
    row.value = String(prevVal);
    row.source = "ua_parse_cache";
    merged += 1;
  }
  if (result.debug && merged > 0) {
    result.debug.uaParseCacheMergedFields = merged;
    result.debug.uaParseCacheSavedAt = cacheEntry.savedAt;
  }
  return merged;
}

export async function readUaParseCacheEntry(userAgent, clientHints) {
  if (!cacheEnabled()) return null;
  const filePath = uaParseCachePath();
  const key = uaParseCacheKey(userAgent, clientHints);
  const store = await readStore(filePath);
  const hit = store.entries[key];
  if (!hit) return null;
  const savedMs = Date.parse(hit.savedAt || "");
  if (!Number.isFinite(savedMs) || Date.now() - savedMs > ttlMs()) return null;
  return hit;
}

export async function writeUaParseCache(userAgent, clientHints, result) {
  if (!cacheEnabled()) return;
  const filePath = uaParseCachePath();
  const key = uaParseCacheKey(userAgent, clientHints);
  const entry = {
    savedAt: new Date().toISOString(),
    key,
    userAgent: String(userAgent || "")
      .trim()
      .replace(/\s+/g, " "),
    clientHints: clientHints && typeof clientHints === "object" ? clientHints : {},
    properties: propertiesMapForCache(result),
  };

  writeChain = writeChain.then(async () => {
    const store = await readStore(filePath);
    store.entries[key] = entry;
    store.entries = pruneEntries(store.entries, maxCacheEntries());
    await writeStore(filePath, store);
  });
  await writeChain.catch((err) => {
    console.error("UA parse cache write error:", err?.message || err);
  });
}

export function uaParseCacheStatus() {
  return {
    enabled: cacheEnabled(),
    path: cacheEnabled() ? uaParseCachePath() : null,
    ttlDays: cacheEnabled() ? ttlMs() / (24 * 60 * 60 * 1000) : null,
    maxEntries: cacheEnabled() ? maxCacheEntries() : null,
    /** When cache is on: JSON merge → GSMArena → HVMS dataset for hardware gaps */
    layeredSourceOrder: cacheEnabled(),
  };
}

function titleVendorFromSlug(slug) {
  if (!slug || slug === "N/A") return "N/A";
  return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
}

function rowByProperty(result, name) {
  return result.properties?.find((p) => p.property === name) || null;
}

const LAYERED_HARDWARE_PROPERTIES = new Set([
  "HardwareFamily",
  "HardwareModel",
  "HardwareName",
  "HardwareNameVersion",
  "HardwareVendor",
  "OEM",
  "SoC",
  "CPU",
  "GPU",
  "ScreenInchesDiagonal",
  "ScreenPixelsWidth",
  "ScreenPixelsHeight",
  "SupportedBearers",
]);

function cacheEntryHasMergeableHardware(cacheEntry) {
  const cachedMap = cachedPropertyMapFromEntry(cacheEntry);
  if (!cachedMap) return false;
  for (const name of LAYERED_HARDWARE_PROPERTIES) {
    const v = cachedMap[name];
    if (v != null && v !== "" && v !== "N/A") return true;
  }
  return false;
}

/**
 * Remove HVMS `device_db` rows only when a cache snapshot will replace them (avoids blanking HVMS on empty cache).
 */
export function stripDeviceDbHardwareForLayeredOrder(result) {
  if (!cacheEnabled() || !Array.isArray(result.properties)) return;
  for (const row of result.properties) {
    if (row.source !== "device_db") continue;
    if (!LAYERED_HARDWARE_PROPERTIES.has(row.property)) continue;
    row.value = "N/A";
    row.source = "none";
    row.confidence = "unknown";
  }
}

/** Do not persist the fast response while GSMArena is still running in the background. */
export function shouldWriteUaParseCacheForResult(result) {
  if (!cacheEnabled()) return false;
  const job = result?.lookupJob;
  if (job?.status === "queued" || job?.status === "running") return false;
  if (result?.gsmarena?.scheduled === true && result?.gsmarena?.match !== true) return false;
  return true;
}

function shouldSkipHvmsFallbackOverwrite(row) {
  if (!row) return true;
  if (row.source === "gsmarena") return true;
  if (typeof row.source === "string" && row.source.startsWith("ua_parse_cache")) return true;
  return false;
}

/**
 * After JSON + GSMArena, fill remaining hardware gaps from `hvms_smartphone_hardware.json` when `modelKey` matches.
 * @returns {number} rows touched
 */
export function applyHvmsDatasetHardwareFallback(result, deviceCatalog) {
  if (!cacheEnabled() || !result?.properties || !deviceCatalog?.index) return 0;
  const mk = normalizeModelKey(result.debug?.modelKey || "");
  if (!mk) return 0;
  const deviceRow = resolveDevice(deviceCatalog.index, mk);
  if (!deviceRow) return 0;

  const hwSlug = deviceRow.hardware_name || "";

  let hc = "medium";
  const ms = result.debug?.modelSource;
  if (ms === "client_hint") hc = "high";
  else if (ms === "user_agent") hc = "medium";

  let touched = 0;
  const setIfGap = (prop, value, source, confidence) => {
    const row = rowByProperty(result, prop);
    if (!row) return;
    if (shouldSkipHvmsFallbackOverwrite(row)) return;
    const empty = row.value == null || row.value === "" || row.value === "N/A";
    if (!empty) return;
    if (value == null || value === "N/A") return;
    row.value = String(value);
    row.source = source;
    row.confidence = confidence;
    touched += 1;
  };

  setIfGap("HardwareFamily", prettifyHardwareSlug(hwSlug), "device_db", hc);
  setIfGap("HardwareName", prettifyHardwareSlug(hwSlug), "device_db", hc);
  setIfGap("HardwareVendor", titleVendorFromSlug(deviceRow.hardware_vendor), "device_db", hc);
  setIfGap("OEM", titleVendorFromSlug(deviceRow.hardware_vendor), "device_db", hc);

  const hnv = rowByProperty(result, "HardwareNameVersion");
  if (hnv && !shouldSkipHvmsFallbackOverwrite(hnv) && (hnv.value === "N/A" || hnv.value == null || hnv.value === "")) {
    hnv.value = "";
    hnv.source = "device_db";
    hnv.confidence = hc;
    touched += 1;
  }

  return touched;
}

export function applyJsonFirstHardwareLayer(result, cacheHit) {
  if (cacheEntryHasMergeableHardware(cacheHit)) {
    stripDeviceDbHardwareForLayeredOrder(result);
  }
  return mergeUaParseCacheIntoResult(result, cacheHit);
}
