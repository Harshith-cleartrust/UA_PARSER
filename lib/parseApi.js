import { buildDetectionResult } from "./buildResult.js";
import {
  readUaParseCacheEntry,
  applyJsonFirstHardwareLayer,
  applyHvmsDatasetHardwareFallback,
  writeUaParseCache,
  shouldWriteUaParseCacheForResult,
} from "./uaParseCache.js";
import {
  readModelParseCacheEntry,
  applyModelParseCacheLayer,
  resolveHardwareFromModelParseCache,
  writeModelParseCacheFromResult,
  modelParseCacheOnlyMode,
} from "./modelParseCache.js";
import { pickNonEmptyClientHintsFromBody } from "./clientHintsFromRequest.js";

export function propertyMap(result) {
  const out = {};
  for (const row of result?.properties || []) {
    if (row?.property) out[row.property] = row.value;
  }
  return out;
}

/** Public API shape: only meta + flat properties. */
export function slimParseApiResponse(result) {
  const meta = result?.meta || {};
  return {
    meta: {
      parserVersion: meta.parserVersion,
      deviceSet: meta.deviceSet,
      deviceDbVersion: meta.deviceDbVersion,
      deviceDbLastUpdated: meta.deviceDbLastUpdated,
      indexedModels: meta.indexedModels,
      parseTimeMs: meta.parseTimeMs,
    },
    properties: propertyMap(result),
  };
}

export function parseApiResponseBody(result, format) {
  if (String(format || "").toLowerCase() === "detailed") {
    return result;
  }
  return slimParseApiResponse(result);
}

/**
 * Run the same parse pipeline as POST /api/parse (without Express req/res).
 * @param {{ userAgent: string, clientHints?: object }} input
 * @param {{ deviceCatalog: object, gsmrEnrichAllowed: boolean, queueLookupJob?: Function, applyLivePath?: boolean }} runtime
 */
export async function executeParse(input, runtime) {
  const parseT0 = Date.now();
  const userAgent = input?.userAgent ?? "";
  const chFromBodyRaw =
    input?.clientHints && typeof input.clientHints === "object" ? input.clientHints : {};
  const clientHints = pickNonEmptyClientHintsFromBody(chFromBodyRaw);
  const modelCacheOnly = modelParseCacheOnlyMode();
  const { deviceCatalog, gsmrEnrichAllowed = false, queueLookupJob, applyLivePath = true } =
    runtime || {};

  const result = buildDetectionResult(
    { userAgent, clientHints },
    deviceCatalog,
    {
      allowHardwareInferenceWithoutDataset: false,
      skipDatasetHardware: modelCacheOnly,
    },
  );

  if (result.debug) {
    result.debug.clientHintsBodyPicked = clientHints;
    result.debug.clientHintsUsed = clientHints;
    result.debug.secChUaModelFromJs = Boolean(clientHints.secChUaModel);
  }

  if (modelCacheOnly) {
    await resolveHardwareFromModelParseCache(result);
    result.gsmarena = {
      skipped: true,
      attempted: false,
      match: false,
      reason: "model_parse_cache_only",
      message: "Hardware resolved from model_parse_cache.json only.",
    };
    if (result.debug) {
      result.debug.hardwareIdentitySource = result.debug.modelParseCacheHit
        ? "model_parse_cache"
        : "none";
      result.debug.datasetMatch = false;
    }
  } else if (applyLivePath) {
    const cacheHit = await readUaParseCacheEntry(userAgent, clientHints);
    applyJsonFirstHardwareLayer(result, cacheHit);

    const modelKey = result.debug?.modelKey;
    if (modelKey) {
      const modelCacheHit = await readModelParseCacheEntry(modelKey);
      applyModelParseCacheLayer(result, modelCacheHit);
    }

    if (!gsmrEnrichAllowed) {
      result.gsmarena = {
        skipped: true,
        attempted: false,
        match: false,
        disabledAtServer: true,
        message: "GSMArena did not run (disabled on this server).",
      };
    } else if (typeof queueLookupJob === "function") {
      const modelForGsmarena =
        result.properties?.find((p) => p.property === "HardwareModel")?.value;
      const hasModel =
        modelForGsmarena && modelForGsmarena !== "N/A" && modelForGsmarena !== "Unknown";
      if (hasModel && !result.debug?.datasetMatch) {
        result.lookupJob = queueLookupJob({ userAgent, clientHints });
        result.gsmarena = {
          skipped: false,
          scheduled: true,
          status: "queued",
          message: "Live lookup queued.",
        };
      }
    }

    applyHvmsDatasetHardwareFallback(result, deviceCatalog);

    if (shouldWriteUaParseCacheForResult(result)) {
      void writeUaParseCache(userAgent, clientHints, result);
    }
    void writeModelParseCacheFromResult(result);
  }

  result.meta.parseTimeMs = Date.now() - parseT0;
  return { result, clientHintsPicked: clientHints };
}
