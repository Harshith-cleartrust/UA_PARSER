import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { normalizeModelKey, resolveDevice } from "./deviceIndex.js";
import { vendorFromGsmarenaTitle } from "./gsmarenaEnrich.js";

/**
 * Strip vendor tokens at the start of the title so hvms-style `hardware_name` omits the brand
 * (e.g. "Nothing Phone (2)" + vendor `nothing` → slug `phone2`, not `nothingphone2`).
 */
function stripLeadingVendorPrefix(titleLower, vendorStorageSlug) {
  if (!vendorStorageSlug || vendorStorageSlug === "unknown" || !titleLower) return titleLower;
  let t = titleLower.trim();
  const tokens = vendorStorageSlug.toLowerCase().trim().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}\\b\\s*`, "i");
    t = t.replace(re, "").trim();
  }
  return t;
}

/**
 * Slug similar to hvms `hardware_name` (lowercase alnum).
 * @param {string} [hardwareVendorStorageSlug] — same as stored `hardware_vendor` (e.g. `nothing`); vendor prefix is removed first.
 */
export function hardwareSlugFromGsmarenaTitle(title, hardwareVendorStorageSlug) {
  if (!title || typeof title !== "string") return "device";
  let t = title.trim().toLowerCase();
  t = stripLeadingVendorPrefix(t, hardwareVendorStorageSlug || "");
  const s = t.replace(/[^a-z0-9]+/g, "").slice(0, 96);
  return s.length > 0 ? s : "device";
}

/** Map “HMD Global” → storage style closer to hvms (single-token vendor). */
function vendorSlugForStorage(displayVendor) {
  if (!displayVendor || typeof displayVendor !== "string") return "unknown";
  const v = displayVendor.trim();
  if (/^hmd\s*global$/i.test(v)) return "hmd global";
  return v.split(/\s+/)[0].toLowerCase();
}

/**
 * @param {string} modelKey — normalized (e.g. a065)
 * @param {{ name?: string, deviceId?: string }} g — GSMArena hit
 */
export function buildLearnedRowFromGsmarena(modelKey, g) {
  const title = (g?.name || "").trim() || "Unknown device";
  const dv = vendorFromGsmarenaTitle(title);
  const hardware_vendor = vendorSlugForStorage(dv || "");
  return {
    hardware_vendor,
    hardware_name: hardwareSlugFromGsmarenaTitle(title, hardware_vendor),
    model: normalizeModelKey(modelKey) || String(modelKey).toLowerCase().replace(/-/g, ""),
    learned_from: "gsmarena",
    learned_at: new Date().toISOString(),
    gsmarena_device_id: g?.deviceId ?? null,
  };
}

export function toHvmsDeviceShape(row) {
  return {
    hardware_vendor: row.hardware_vendor,
    hardware_name: row.hardware_name,
    model: row.model,
  };
}

/**
 * True if `hvms_smartphone_hardware.json` (on disk) already has this normalized model key.
 */
export function hvmsFileHasModelKey(hvmsPath, modelKey) {
  const key = normalizeModelKey(modelKey);
  if (!key) return false;
  let raw;
  try {
    raw = readFileSync(hvmsPath, "utf8");
  } catch {
    return false;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(data.devices)) return false;
  return data.devices.some((d) => normalizeModelKey(d?.model) === key);
}

/** Skip persisting a learned row when the runtime catalog or HVMS file already lists this model. */
export function learnedRowAlreadyInDataset(catalog, hvmsPath, row) {
  const key = normalizeModelKey(row.model);
  if (!key) return true;
  if (catalog?.index && resolveDevice(catalog.index, key)) return true;
  return hvmsFileHasModelKey(hvmsPath, key);
}

/**
 * Append multiple device rows in one atomic write. Skips models already in file.
 * @returns {{ added: number, appendedModelKeys: string[] }}
 */
export function appendDevicesToHvmsJsonFile(hvmsPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { added: 0, appendedModelKeys: [] };
  }

  const raw = readFileSync(hvmsPath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.devices)) return { added: 0, appendedModelKeys: [] };

  const appendedModelKeys = [];
  for (const row of rows) {
    const key = normalizeModelKey(row.model);
    if (!key) continue;
    const exists = data.devices.some((d) => normalizeModelKey(d?.model) === key);
    if (exists) continue;
    data.devices.push(toHvmsDeviceShape(row));
    appendedModelKeys.push(key);
  }

  if (appendedModelKeys.length === 0) {
    return { added: 0, appendedModelKeys: [] };
  }

  const tmp = `${hvmsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, hvmsPath);
  return { added: appendedModelKeys.length, appendedModelKeys };
}

/**
 * Append a device to the main HVMS JSON file (same schema as existing rows).
 * Re-serializes the whole file (atomic .tmp + rename). Only `hardware_*` + `model` are stored.
 * @returns {boolean} true if a new row was written
 */
export function appendDeviceToHvmsJsonFile(hvmsPath, row) {
  const { added } = appendDevicesToHvmsJsonFile(hvmsPath, [row]);
  return added > 0;
}

/**
 * Add a single catalog row if the key is not already indexed (in-memory).
 * @returns {boolean} true if the map changed
 */
export function addRowToRuntimeCatalog(catalog, row) {
  if (!catalog?.index || !(catalog.index instanceof Map)) return false;
  const key = normalizeModelKey(row.model);
  if (!key || catalog.index.has(key)) return false;

  catalog.index.set(key, row);
  catalog.size = catalog.index.size;

  const hn = row.hardware_name;
  const m = row.model;
  if (hn != null && typeof hn === "string" && m != null && typeof m === "string") {
    if (!(catalog.variantsByHardware instanceof Map)) {
      catalog.variantsByHardware = new Map();
    }
    const tok = m.trim();
    const cur = catalog.variantsByHardware.get(hn) || [];
    if (!cur.includes(tok)) {
      catalog.variantsByHardware.set(hn, [...cur, tok].sort());
    }
  }
  return true;
}
