import { resolveDevice } from "./deviceIndex.js";
import { inferHardwareWithoutDataset } from "./fallbackInference.js";
import {
  parseBrowser,
  parsePlatform,
  deviceClassFromSignals,
  resolveHardwareModelKey,
  extractAndroidModelFromUa,
  extractIosIphoneGenerationFromUa,
} from "./parseSignals.js";
import { buildUADiagnosticRows } from "./futureProperties.js";
import { detectCrawlerLabeled } from "./crawlerPatterns.js";

export { detectCrawlerLabeled };

/** Bumped when API output / parsing behavior changes; shown in meta + /api/health. */
export const PARSER_API_VERSION = "0.3.47";

function titleVendor(slug) {
  if (!slug || slug === "N/A") return "N/A";
  return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
}

export function prettifyHardwareSlug(slug) {
  if (!slug) return "N/A";
  const spaced = slug
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2");
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function nv(val) {
  if (val == null || val === "") return "N/A";
  return String(val);
}

function propRow(property, value, source, confidence) {
  return { property, value: nv(value), source, confidence };
}

/**
 * @param {{ userAgent: string, clientHints?: object }} input
 * @param {{ index: Map, meta: object, size?: number, variantsByHardware?: Map<string, string[]> }} deviceCatalog
 * @param {{ allowHardwareInferenceWithoutDataset?: boolean, skipDatasetHardware?: boolean }} [opts] — when `false` and there is no dataset row, hardware marketing fields stay N/A (avoids false positives when GSMArena is not used for this request). `skipDatasetHardware` leaves hardware N/A until model_parse_cache is applied.
 */
export function buildDetectionResult(input, deviceCatalog, opts = {}) {
  const ua = input.userAgent || "";
  const ch = input.clientHints || {};
  const allowHardwareInferenceWithoutDataset = opts.allowHardwareInferenceWithoutDataset !== false;
  const skipDatasetHardware = opts.skipDatasetHardware === true;

  const browser = parseBrowser(ua);
  const platform = parsePlatform(ua, ch);
  const crawler = detectCrawlerLabeled(ua);
  const deviceType = deviceClassFromSignals(ua, ch);

  const modelResolve = resolveHardwareModelKey({ userAgent: ua, clientHints: ch });
  const deviceRow =
    !skipDatasetHardware && modelResolve.key
      ? resolveDevice(deviceCatalog.index, modelResolve.key)
      : null;

  const uaModelDiag = extractAndroidModelFromUa(ua);
  const uaIosDiag = extractIosIphoneGenerationFromUa(ua);

  let hardwareConfidence = "unknown";
  if (deviceRow) {
    if (modelResolve.source === "client_hint") hardwareConfidence = "high";
    else if (modelResolve.source === "user_agent") hardwareConfidence = "medium";
  }

  let hwVendor = deviceRow ? titleVendor(deviceRow.hardware_vendor) : "N/A";
  const hwSlug = deviceRow?.hardware_name || "";
  let hwFamily = deviceRow ? prettifyHardwareSlug(hwSlug) : "N/A";
  let hwName = deviceRow ? prettifyHardwareSlug(hwSlug) : "N/A";
  let hwModelDisplay = modelResolve.raw || "N/A";
  let hwSourceFamily = deviceRow ? "device_db" : "none";
  let hwSourceName = deviceRow ? "device_db" : "none";
  let hwSourceVendor = deviceRow ? "device_db" : "none";
  let hwSourceModel = modelResolve.source === "none" ? "none" : "evidence";

  const suppressHeuristic = !deviceRow && !allowHardwareInferenceWithoutDataset;

  const fallback =
    !deviceRow && !suppressHeuristic
      ? inferHardwareWithoutDataset({
          userAgent: ua,
          platformName: platform.name,
          deviceType,
          modelResolve,
          uaIosDiag,
          androidModel: uaModelDiag,
          clientHints: ch,
        })
      : null;

  if (suppressHeuristic) {
    hwVendor = "N/A";
    hwFamily = "N/A";
    hwName = "N/A";
    hwSourceFamily = "none";
    hwSourceName = "none";
    hwSourceVendor = "none";
    hardwareConfidence = "unknown";
  } else if (!deviceRow && fallback?.notes) {
    if (fallback.hardwareVendor) {
      hwVendor = fallback.hardwareVendor;
      hwSourceVendor = "inferred";
    }
    if (fallback.hardwareFamily) {
      hwFamily = fallback.hardwareFamily;
      hwSourceFamily = "inferred";
    }
    if (fallback.hardwareName) {
      hwName = fallback.hardwareName;
      hwSourceName = "inferred";
    }
    if (fallback.hardwareModel != null && fallback.hardwareModel !== "") {
      hwModelDisplay = fallback.hardwareModel;
      hwSourceModel = "inferred";
    }
    hardwareConfidence = "low";
  }

  const hwOem = hwVendor;
  const hwSourceOem = hwSourceVendor;

  const properties = [
    propRow("BrowserName", browser.name, "evidence", "medium"),
    propRow("BrowserVendor", browser.vendor, "evidence", "medium"),
    propRow("BrowserVersion", browser.version, "evidence", "medium"),
    propRow("HardwareFamily", hwFamily, hwSourceFamily, hardwareConfidence),
    propRow("HardwareModel", hwModelDisplay, hwSourceModel, hardwareConfidence),
    propRow("HardwareName", hwName, hwSourceName, hardwareConfidence),
    propRow("HardwareNameVersion", deviceRow ? "" : "N/A", "none", "unknown"),
    propRow("HardwareVendor", hwVendor, hwSourceVendor, hardwareConfidence),
    propRow("OEM", hwOem, hwSourceOem, hardwareConfidence),
    propRow("HardwareChipset", "N/A", "none", "unknown"),
    propRow("HardwareCpu", "N/A", "none", "unknown"),
    propRow("HardwareGpu", "N/A", "none", "unknown"),
    propRow("PlatformName", platform.name, "evidence", "medium"),
    propRow("PlatformVendor", platform.vendor, "evidence", "medium"),
    propRow("PlatformVersion", platform.version, "evidence", "medium"),
    propRow("DeviceType", deviceType, "evidence", "medium"),
    propRow("IsCrawler", crawler.isCrawler ? "True" : "False", "rules", "high"),
    ...(crawler.isCrawler
      ? [
          propRow("CrawlerName", crawler.name, "rules", "high"),
          propRow("CrawlerProductTokens", "N/A", "none", "unknown"),
          propRow("CrawlerUrl", "N/A", "none", "unknown"),
          propRow("CrawlerUsage", "N/A", "none", "unknown"),
        ]
      : []),
    propRow("ScreenInchesDiagonal", "N/A", "none", "unknown"),
    propRow("ScreenPixelsWidth", "N/A", "none", "unknown"),
    propRow("ScreenPixelsHeight", "N/A", "none", "unknown"),
    propRow("SupportedBearers", "N/A", "none", "unknown"),
    propRow("IsWebApp", "False", "none", "unknown"),
    ...buildUADiagnosticRows({
      userAgent: ua,
      clientHints: ch,
      browser,
      platform,
      deviceType,
      crawler,
      hardwareModelDisplay: hwModelDisplay,
      hardwareVendor: hwVendor,
    }),
  ];

  return {
    meta: {
      parserVersion: PARSER_API_VERSION,
      deviceSet: deviceCatalog.meta?.dataset ?? "unknown",
      deviceDbVersion: deviceCatalog.meta?.version ?? "unknown",
      deviceDbLastUpdated: deviceCatalog.meta?.last_updated ?? "unknown",
      indexedModels: deviceCatalog.size,
    },
    properties,
    debug: {
      modelKey: modelResolve.key || null,
      modelRaw: modelResolve.raw || null,
      modelSource: modelResolve.source,
      uaAndroidModelReason: uaModelDiag.reason,
      uaIosHardwareHint: uaIosDiag.reason,
      hardwareMatch: hardwareConfidence,
      datasetHardwareSlug: deviceRow?.hardware_name ?? null,
      hardwareFallback: fallback?.notes ?? null,
      hardwareInferenceSuppressed: suppressHeuristic,
      datasetMatch: Boolean(deviceRow),
    },
  };
}
