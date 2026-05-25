import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load hvms_smartphone_hardware.json and build an exact index: normalizedModel -> device row.
 * Multiple rows for same model: keep the first (dataset should be one marketing codename per SKU).
 */
export function loadDeviceIndex(datasetPath) {
  const raw = readFileSync(datasetPath, "utf8");
  const data = JSON.parse(raw);
  const index = new Map();
  /** @type {Map<string, Set<string>>} */
  const variantSets = new Map();

  for (const row of data.devices || []) {
    const m = row.model;
    if (m != null && typeof m === "string") {
      const hn = row.hardware_name;
      if (hn != null && typeof hn === "string" && hn.length > 0) {
        if (!variantSets.has(hn)) variantSets.set(hn, new Set());
        variantSets.get(hn).add(m.trim());
      }
    }
    if (m == null || typeof m !== "string") continue;
    const key = normalizeModelKey(m);
    if (!key) continue;
    if (!index.has(key)) index.set(key, row);
  }

  /** @type {Map<string, string[]>} hardware_name → sorted distinct model ids (SKU / regional codes) */
  const variantsByHardware = new Map();
  for (const [hn, set] of variantSets) {
    variantsByHardware.set(hn, [...set].sort());
  }

  return {
    meta: data.meta || {},
    index,
    size: index.size,
    variantsByHardware,
  };
}

export function resolveDevice(index, normalizedKey) {
  const key = normalizeModelKey(
    normalizedKey == null || normalizedKey === "" ? "" : String(normalizedKey),
  );
  if (!key) return null;
  return index.get(key) || null;
}

/**
 * Canonical key for UA / Client-Hints model tokens vs dataset `model` (e.g. SM-S928B → sms928b).
 * Dataset uses compact ids without hyphens; UAs often include SM-… with dashes.
 */
export function normalizeModelKey(model) {
  if (!model || typeof model !== "string") return "";
  return model
    .trim()
    .toLowerCase()
    .replace(/-/g, "");
}

export function defaultDatasetPath() {
  return path.join(__dirname, "..", "dataset_files", "hvms_smartphone_hardware.json");
}
