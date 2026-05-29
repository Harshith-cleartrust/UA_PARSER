import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeviceIndex, defaultDatasetPath, resolveDevice, normalizeModelKey } from "./lib/deviceIndex.js";
import { mergeExpandedModelKeysForLearning } from "./lib/gsmarenaModelCodes.js";
import { buildDetectionResult, PARSER_API_VERSION } from "./lib/buildResult.js";
import { detectModelSourceConflict } from "./lib/parseSignals.js";
import { tryGsmarenaEnrich, applyGsmarenaToResult } from "./lib/gsmarenaEnrich.js";
import { firecrawlConfigured } from "./lib/gsmarenaFetchTransport.js";
import {
  appendDevicesToHvmsJsonFile,
  addRowToRuntimeCatalog,
  buildLearnedRowFromGsmarena,
  toHvmsDeviceShape,
  learnedRowAlreadyInDataset,
} from "./lib/learnedDevices.js";
import {
  readUaParseCacheEntry,
  applyJsonFirstHardwareLayer,
  applyHvmsDatasetHardwareFallback,
  writeUaParseCache,
  shouldWriteUaParseCacheForResult,
  uaParseCacheStatus,
} from "./lib/uaParseCache.js";
import {
  loadModelParseCacheAtStartup,
  readModelParseCacheEntry,
  applyModelParseCacheLayer,
  resolveHardwareFromModelParseCache,
  writeModelParseCacheFromResult,
  modelParseCacheStatus,
  modelParseCacheOnlyMode,
} from "./lib/modelParseCache.js";
import {
  ACCEPT_CH_VALUE,
  clientHintsFromHttpHeaders,
  pickNonEmptyClientHintsFromBody,
} from "./lib/clientHintsFromRequest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USE_HTTPS = process.env.USE_HTTPS === "1";
const DEV_CERT = path.join(__dirname, ".dev", "cert.pem");
const DEV_KEY = path.join(__dirname, ".dev", "key.pem");
const firstPort = Number(process.env.PORT) || 3000;
const portLocked = Boolean(process.env.PORT);
const portAttempts = portLocked ? 1 : 15;
const AI_ANALYZE_BASE_URL = (process.env.AI_ANALYZE_BASE_URL || "https://api.konsole.one").replace(/\/$/, "");
const AI_ANALYZE_ENDPOINT =
  process.env.AI_ANALYZE_ENDPOINT?.trim() || `${AI_ANALYZE_BASE_URL}/v1/chat/completions`;
const AI_ANALYZE_API_KEY = process.env.AI_ANALYZE_API_KEY?.trim() || process.env.KONSOLE_API_KEY?.trim() || "";
const AI_ANALYZE_MODEL = process.env.AI_ANALYZE_MODEL?.trim() || "gpt-5.4";

/** HVMS dataset; GSMArena learns append new rows here when `LEARN_DEVICE_DB` is on. Override with `DEVICE_DATASET`. */
const datasetPath = process.env.DEVICE_DATASET || defaultDatasetPath();

/** Persist unknown models after a successful GSMArena hit into `datasetPath`. Set `LEARN_DEVICE_DB=0` to disable. */
const LEARN_DEVICE_DB = process.env.LEARN_DEVICE_DB !== "0";

/** Live GSMArena calls can rate-limit or block your IP. Default off; enable with GSMR_ENRICH_ALLOWED=1 when safe. */
const GSMR_ENRICH_ALLOWED = process.env.GSMR_ENRICH_ALLOWED === "1";
const LOOKUP_JOB_TTL_MS = 15 * 60 * 1000;
const LOOKUP_JOB_MAX = 200;
/** @type {Map<string, { id: string, status: "queued" | "running" | "completed" | "failed", createdAt: string, startedAt: string | null, finishedAt: string | null, input: { userAgent: string, clientHints: object }, error: string | null, result: any }>} */
const lookupJobs = new Map();
/** @type {Map<string, any>} */
const gsmarenaResultCache = new Map();

let deviceCatalog;
try {
  deviceCatalog = loadDeviceIndex(datasetPath);
  console.error(`Loaded device index: ${deviceCatalog.size} models (${path.resolve(datasetPath)})`);
  if (LEARN_DEVICE_DB) {
    console.error(`Learn persistence: ON — new models append to ${path.resolve(datasetPath)}`);
  } else {
    console.error("Learn persistence: OFF (LEARN_DEVICE_DB=0).");
  }
  console.error(
    GSMR_ENRICH_ALLOWED
      ? `GSMArena enrich: allowed (GSMR_ENRICH_ALLOWED=1). Fetch: ${
          firecrawlConfigured() ? "Firecrawl (FIRECRAWL_API_KEY set)" : "direct to gsmarena.com"
        }.`
      : "GSMArena enrich: OFF (default — avoids IP blocks). Set GSMR_ENRICH_ALLOWED=1 to enable.",
  );
  if (GSMR_ENRICH_ALLOWED && !firecrawlConfigured()) {
    console.error(
      "If gsmarena.com blocks your IP, set FIRECRAWL_API_KEY in .env (see https://firecrawl.dev).",
    );
  }
  const cacheSt = uaParseCacheStatus();
  if (cacheSt.enabled) {
    console.error(
      `UA parse cache: ON — ${cacheSt.path} (TTL ~${cacheSt.ttlDays}d, max ${cacheSt.maxEntries} entries). Source order when filling hardware: JSON snapshot → GSMArena → HVMS. Full UA stored — treat as sensitive.`,
    );
  }
  const modelCacheSt = modelParseCacheStatus();
  if (modelCacheSt.enabled) {
    await loadModelParseCacheAtStartup();
    const loaded = modelParseCacheStatus();
    console.error(
      `Model parse cache: ON — ${loaded.path} (${loaded.entryCount ?? "?"} entries, TTL ~${loaded.ttlDays}d). ` +
        `Hardware source: model_parse_cache.json only (no GSMArena/HVMS/UA cache on parse).`,
    );
  }
} catch (e) {
  console.error("Failed to load device dataset:", e.message);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "256kb" }));

/** Ask the browser to send Sec-CH-UA-Model (and related) on later same-origin requests (e.g. POST /api/parse). */
app.use((_req, res, next) => {
  res.setHeader("Accept-CH", ACCEPT_CH_VALUE);
  res.setHeader(
    "Permissions-Policy",
    "ch-ua-model=(self), ch-ua-platform=(self), ch-ua-platform-version=(self), ch-ua-mobile=(self)",
  );
  next();
});

app.use((req, res, next) => {
  if (/^\/app\.js/.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

/** Echo Sec-CH-UA-* request headers (GET often carries low-entropy hints after Accept-CH). */
app.get("/api/ch-probe", (req, res) => {
  res.json({ clientHintsFromHeaders: clientHintsFromHttpHeaders(req.headers) });
});

function cleanupLookupJobs() {
  const now = Date.now();
  for (const [id, job] of lookupJobs) {
    const refMs = Date.parse(job.finishedAt || job.createdAt);
    if (Number.isFinite(refMs) && now - refMs > LOOKUP_JOB_TTL_MS) {
      lookupJobs.delete(id);
    }
  }
  while (lookupJobs.size > LOOKUP_JOB_MAX) {
    const oldest = lookupJobs.keys().next().value;
    if (!oldest) break;
    lookupJobs.delete(oldest);
  }
}

function publicLookupJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    pollUrl: `/api/parse-jobs/${job.id}`,
    error: job.error,
    resultReady: job.status === "completed" && Boolean(job.result),
  };
}

function cacheLiveLookupResult(result, g) {
  const modelKeys = mergeExpandedModelKeysForLearning(result.debug?.modelKey || "", g?.internalModelCodes);
  for (const key of modelKeys) {
    const norm = normalizeModelKey(key);
    if (!norm) continue;
    gsmarenaResultCache.set(norm, g);
  }
}

function cachedLiveLookupForResult(result) {
  const modelKey = normalizeModelKey(result.debug?.modelKey || "");
  if (!modelKey) return null;
  return gsmarenaResultCache.get(modelKey) || null;
}

function modelForLiveLookupFromResult(result) {
  const modelDisplayCell = result.properties.find((p) => p.property === "HardwareModel")?.value;
  const modelRaw = result.debug?.modelRaw;
  return modelDisplayCell && modelDisplayCell !== "N/A" && modelDisplayCell !== "Unknown"
    ? modelDisplayCell
    : modelRaw && modelRaw !== "N/A" && modelRaw !== "Unknown"
      ? modelRaw
      : null;
}

async function applyLiveLookupAndLearning(result) {
  const modelKey = result.debug?.modelKey;
  const deviceRow = modelKey ? resolveDevice(deviceCatalog.index, modelKey) : null;
  const modelForGsmarena = modelForLiveLookupFromResult(result);

  if (!modelForGsmarena) {
    result.gsmarena = {
      ok: false,
      skipped: true,
      attempted: false,
      match: false,
      reason: "no_model_token",
      message:
        "GSMArena was not run: no model id in UA or Client Hints. Nothing was inferred from GSMArena.",
      hint: "Add Client Hints or a phone UA with a model token for automatic GSMArena lookup of unknown devices.",
    };
    if (result.debug) {
      result.debug.hardwareIdentitySource = result.debug.datasetMatch
        ? "device_db"
        : result.debug.hardwareFallback
          ? "inferred"
          : "none";
    }
    return result;
  }

  const g = await tryGsmarenaEnrich({
    deviceRow: deviceRow || null,
    modelDisplay: modelForGsmarena,
    enabled: true,
  });

  if (g?.ok) {
    cacheLiveLookupResult(result, g);
    applyGsmarenaToResult(result, g);
    result.gsmarena = { ...g, attempted: true, match: true, hardwareIdentity: "gsmarena" };

    if (
      LEARN_DEVICE_DB &&
      (result.debug?.modelKey || (Array.isArray(g.internalModelCodes) && g.internalModelCodes.length > 0))
    ) {
      const modelKeys = mergeExpandedModelKeysForLearning(result.debug?.modelKey || "", g.internalModelCodes);
      const rowsToAdd = [];
      for (const mk of modelKeys) {
        const row = buildLearnedRowFromGsmarena(mk, g);
        if (!learnedRowAlreadyInDataset(deviceCatalog, datasetPath, row)) {
          rowsToAdd.push(row);
        }
      }
      if (result.debug) {
        result.debug.learnedModelKeysConsidered = modelKeys;
        result.debug.learnedRowsPreview = rowsToAdd.map(toHvmsDeviceShape);
        result.debug.learnedDeviceSkippedExisting = rowsToAdd.length === 0;
      }
      let appendResult = { added: 0, appendedModelKeys: [] };
      if (rowsToAdd.length > 0) {
        try {
          appendResult = appendDevicesToHvmsJsonFile(datasetPath, rowsToAdd);
        } catch (persistErr) {
          console.error("Learned device persist error:", persistErr?.message || persistErr);
          if (result.debug) {
            result.debug.learnedDeviceError = String(persistErr?.message || persistErr);
          }
        }
      }
      const addedKeySet = new Set(appendResult.appendedModelKeys);
      for (const row of rowsToAdd) {
        if (addedKeySet.has(normalizeModelKey(row.model))) {
          addRowToRuntimeCatalog(deviceCatalog, toHvmsDeviceShape(row));
        }
      }
      if (result.debug) {
        result.debug.learnedDevicePersisted = appendResult.added > 0;
        result.debug.learnedDevicesAppendedCount = appendResult.added;
      }
    }
    return result;
  }

  const noMatchMsg =
    "GSMArena: no match. No device was selected; do not treat hardware name, vendor, or family as GSMArena results—they were not confirmed there.";
  result.gsmarena = {
    ...(g && typeof g === "object" ? g : {}),
    ok: false,
    attempted: true,
    match: false,
    message: noMatchMsg,
    hint: noMatchMsg,
  };
  if (result.debug) {
    result.debug.gsmarenaAttempted = true;
    result.debug.gsmarenaMatch = false;
    result.debug.hardwareIdentitySource = result.debug.datasetMatch
      ? "device_db"
      : result.debug.hardwareFallback
        ? "inferred"
        : "none";
    result.debug.gsmarenaQueryPhase = null;
  }
  return result;
}

async function runLookupJob(jobId) {
  const job = lookupJobs.get(jobId);
  if (!job || job.status !== "queued") return;
  job.status = "running";
  job.startedAt = new Date().toISOString();

  try {
    const startedMs = Date.now();
    const result = buildDetectionResult(
      { userAgent: job.input.userAgent, clientHints: job.input.clientHints },
      deviceCatalog,
      { allowHardwareInferenceWithoutDataset: false },
    );
    const jobCacheHit = await readUaParseCacheEntry(job.input.userAgent, job.input.clientHints);
    applyJsonFirstHardwareLayer(result, jobCacheHit);
    if (modelParseCacheOnlyMode()) {
      await resolveHardwareFromModelParseCache(result);
      result.gsmarena = {
        skipped: true,
        attempted: false,
        match: false,
        reason: "model_parse_cache_only",
        message: "GSMArena skipped — hardware comes from model_parse_cache.json only.",
      };
    } else {
      const jobModelKey = result.debug?.modelKey;
      if (jobModelKey) {
        const jobModelCacheHit = await readModelParseCacheEntry(jobModelKey);
        applyModelParseCacheLayer(result, jobModelCacheHit);
      }
      await applyLiveLookupAndLearning(result);
      applyHvmsDatasetHardwareFallback(result, deviceCatalog);
    }
    result.meta.parseTimeMs = Date.now() - startedMs;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.result = result;
    job.result.lookupJob = publicLookupJob(job);
    await writeUaParseCache(job.input.userAgent, job.input.clientHints, job.result);
    await writeModelParseCacheFromResult(job.result);
  } catch (err) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = String(err?.message || err);
  } finally {
    cleanupLookupJobs();
  }
}

function queueLookupJob(input) {
  cleanupLookupJobs();
  const job = {
    id: randomUUID(),
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    input,
    error: null,
    result: null,
  };
  lookupJobs.set(job.id, job);
  queueMicrotask(() => {
    void runLookupJob(job.id);
  });
  return job;
}

app.get("/api/health", (_req, res) => {
  cleanupLookupJobs();
  res.json({
    ok: true,
    parserVersion: PARSER_API_VERSION,
    indexedModels: deviceCatalog.size,
    deviceDbVersion: deviceCatalog.meta?.version,
    gsmarenaAllowed: GSMR_ENRICH_ALLOWED,
    gsmarenaFetchViaFirecrawl: firecrawlConfigured(),
    learnDeviceDb: LEARN_DEVICE_DB,
    learnDeviceTarget: LEARN_DEVICE_DB ? "hvms" : null,
    datasetFile: path.basename(datasetPath),
    learnHvmsDatasetPath: path.resolve(datasetPath),
    liveLookupJobsInMemory: lookupJobs.size,
    cachedLiveSpecsInMemory: gsmarenaResultCache.size,
    uaParseCache: uaParseCacheStatus(),
    modelParseCache: modelParseCacheStatus(),
  });
});

app.get("/api/parse-jobs/:jobId", (req, res) => {
  cleanupLookupJobs();
  const job = lookupJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "lookup_job_not_found" });
    return;
  }
  res.json({
    ok: true,
    lookupJob: publicLookupJob(job),
    result: job.status === "completed" ? job.result : null,
  });
});

/** AI Analyze omits platform-version hints (frozen UA vs real OS from CH confuses risk scoring). */
function clientHintsWithoutPlatformVersionForAi(hints) {
  const base = hints && typeof hints === "object" && !Array.isArray(hints) ? { ...hints } : {};
  delete base.secChUaPlatformVersion;
  delete base["Sec-CH-UA-Platform-Version"];
  delete base["sec-ch-ua-platform-version"];
  delete base.sec_ch_ua_platform_version;
  return base;
}

/** Omit PlatformVersion from the JSON sent to the AI so it cannot quote a CH-derived OS level. */
function localDetectionSnapshotForAiPrompt(local) {
  if (!local || typeof local !== "object") return local;
  const props = { ...(local.properties || {}) };
  delete props.PlatformVersion;
  return { ...local, properties: props };
}

/**
 * Upstream models often hallucinate "UA Android 10 vs CH platform version 16" even when that
 * header was stripped from the prompt. Drop those claims from the user-visible fields.
 */
function scrubChPlatformVersionClaimsFromAiRisk(parsed) {
  const out = {
    ...parsed,
    reasons: Array.isArray(parsed.reasons) ? [...parsed.reasons] : [],
  };
  const chPlatVer = /sec[\s_-]*ch[\s_-]*ua[\s_-]*platform[\s_-]*version/i;
  const platVerContra = /platform[\s_-]*version\s+contradiction/i;
  const ua10vsCh16 =
    /android\s*10[^\n]{0,220}(16\.0|android\s*16)|(?:16\.0|android\s*16)[^\n]{0,220}android\s*10/i;

  const badReason = (r) =>
    typeof r !== "string" || chPlatVer.test(r) || platVerContra.test(r) || ua10vsCh16.test(r);

  out.reasons = out.reasons.filter((r) => !badReason(r));

  if (typeof out.summary === "string" && (chPlatVer.test(out.summary) || platVerContra.test(out.summary) || ua10vsCh16.test(out.summary))) {
    out.summary =
      "Risk from device/browser identity and parser signals only; this analysis intentionally does not use Client Hints platform OS version.";
  }
  if (
    typeof out.recommendation === "string" &&
    (chPlatVer.test(out.recommendation) || platVerContra.test(out.recommendation) || ua10vsCh16.test(out.recommendation))
  ) {
    out.recommendation =
      "Correlate model, crawler, and UA-structure signals; do not treat UA Android level vs Client Hints platform version as a risk signal here.";
  }

  out.analysis = buildRiskAnalysisMarkdown(out);
  return out;
}

function buildRiskAnalysisMarkdown({ riskLevel, riskScore, summary, reasons, recommendation }) {
  const reasonsList = Array.isArray(reasons) ? reasons : [];
  return [
    `**Risk: ${riskLevel.toUpperCase()} (${riskScore}/10)**`,
    "",
    `**Summary**`,
    `- ${summary}`,
    reasonsList.length ? `**Reasons**\n${reasonsList.map((r) => `- ${r}`).join("\n")}` : "",
    recommendation ? `**Recommendation**\n- ${recommendation}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * When the upstream model returns a generic medium score, align the UI with
 * deterministic parser signals (model UA vs Client Hints conflict, etc.).
 */
function isCleanLocalRiskContext(local) {
  const p = local?.properties;
  if (!p || typeof p !== "object") return false;
  if (local?.debug?.modelSourceConflict) return false;
  if (String(p.IsCrawler || "").toLowerCase() === "true") return false;
  if (String(p.BrowserName || "") === "Unknown") return false;
  if (String(p.PlatformName || "") === "Unknown") return false;
  return true;
}

function mergeAiRiskWithLocalDetection(parsed, localDetection, opts = {}) {
  const out = { ...parsed };
  const notes = [];
  const userAgent = String(opts.userAgent || "");
  const clientHintsRaw =
    opts.clientHintsRaw && typeof opts.clientHintsRaw === "object" ? opts.clientHintsRaw : {};
  const repicked = pickNonEmptyClientHintsFromBody(clientHintsRaw);
  const conflict =
    (userAgent && detectModelSourceConflict({ userAgent, clientHints: repicked })) ||
    localDetection?.debug?.modelSourceConflict;

  if (conflict) {
    const before = { level: out.riskLevel, score: out.riskScore };
    out.riskLevel = "high";
    out.riskScore = Math.max(out.riskScore, 8);
    const line = `Parser: User-Agent model "${conflict.uaModel}" disagrees with Sec-CH-UA-Model "${conflict.chModel}" (spoofing / mixed signals).`;
    out.reasons = [line, ...(out.reasons || [])].filter(Boolean).slice(0, 8);
    out.summary = `Contradictory device identifiers: UA reports ${conflict.uaModel} but Client Hints report ${conflict.chModel}.`;
    if (before.level !== out.riskLevel || before.score !== out.riskScore) {
      notes.push("raised_to_match_parser_model_conflict");
    }
  } else if (
    isCleanLocalRiskContext(localDetection) &&
    out.riskLevel !== "high" &&
    out.riskScore <= 5
  ) {
    const before = { level: out.riskLevel, score: out.riskScore };
    out.riskScore = Math.min(3, out.riskScore);
    out.riskLevel = "low";
    const soft = "Local parser found no UA vs Client Hints model conflict and no crawler signals; baseline harm score lowered.";
    out.reasons = [soft, ...(out.reasons || [])].filter(Boolean).slice(0, 8);
    if (before.level !== out.riskLevel || before.score !== out.riskScore) {
      notes.push("lowered_for_coherent_local_parse");
    }
  }

  out.analysis = buildRiskAnalysisMarkdown(out);
  return { parsed: out, riskAdjustNotes: notes };
}

function parseAiRiskAnalysis(raw) {
  const fallback = {
    riskLevel: "medium",
    riskScore: 5,
    summary: "AI returned an unstructured risk analysis.",
    reasons: [],
    recommendation: "Review the raw analysis manually.",
    analysis: String(raw || ""),
  };
  if (!raw) return fallback;

  const text = String(raw).trim();
  const jsonText = text.match(/```json\s*([\s\S]*?)```/i)?.[1] || text.match(/\{[\s\S]*\}/)?.[0] || text;
  try {
    const data = JSON.parse(jsonText);
    const risk = String(data.riskLevel || data.risk || "").toLowerCase();
    const riskLevel = ["high", "medium", "low"].includes(risk) ? risk : fallback.riskLevel;
    const scoreRaw = Number(data.riskScore ?? data.score ?? data.harmScore);
    const riskScore = Number.isFinite(scoreRaw)
      ? Math.max(1, Math.min(10, Math.round(scoreRaw)))
      : riskLevel === "high"
        ? 9
        : riskLevel === "medium"
          ? 5
          : 2;
    const reasons = Array.isArray(data.reasons)
      ? data.reasons.map((r) => String(r)).filter(Boolean).slice(0, 6)
      : [];
    const summary = String(data.summary || fallback.summary);
    const recommendation = String(data.recommendation || "");
    return {
      riskLevel,
      riskScore,
      summary,
      reasons,
      recommendation,
      analysis: buildRiskAnalysisMarkdown({ riskLevel, riskScore, summary, reasons, recommendation }),
    };
  } catch {
    return fallback;
  }
}

function propertyMap(result) {
  const out = {};
  for (const row of result?.properties || []) {
    if (row?.property) out[row.property] = row.value;
  }
  return out;
}

async function buildLocalDetectionContext(userAgent, clientHints) {
  const modelCacheOnly = modelParseCacheOnlyMode();
  const result = buildDetectionResult(
    { userAgent, clientHints },
    deviceCatalog,
    {
      allowHardwareInferenceWithoutDataset: false,
      skipDatasetHardware: modelCacheOnly,
    },
  );

  if (modelCacheOnly) {
    await resolveHardwareFromModelParseCache(result);
  } else {
    const modelKey = result.debug?.modelKey;
    if (modelKey) {
      const modelCacheHit = await readModelParseCacheEntry(modelKey);
      applyModelParseCacheLayer(result, modelCacheHit);
    }
    applyHvmsDatasetHardwareFallback(result, deviceCatalog);
  }

  const props = propertyMap(result);
  return {
    meta: {
      parserVersion: result.meta?.parserVersion,
      modelParseCacheOnly: modelCacheOnly,
      indexedModels: result.meta?.indexedModels,
    },
    debug: {
      modelKey: result.debug?.modelKey ?? null,
      modelRaw: result.debug?.modelRaw ?? null,
      modelSource: result.debug?.modelSource ?? "none",
      modelSourceConflict: result.debug?.modelSourceConflict ?? null,
      modelParseCacheHit: result.debug?.modelParseCacheHit ?? false,
      datasetMatch: result.debug?.datasetMatch ?? false,
      uaAndroidModelReason: result.debug?.uaAndroidModelReason ?? null,
      uaIosHardwareHint: result.debug?.uaIosHardwareHint ?? null,
    },
    properties: {
      BrowserName: props.BrowserName,
      BrowserVendor: props.BrowserVendor,
      BrowserVersion: props.BrowserVersion,
      PlatformName: props.PlatformName,
      PlatformVersion: props.PlatformVersion,
      DeviceType: props.DeviceType,
      HardwareVendor: props.HardwareVendor,
      HardwareFamily: props.HardwareFamily,
      HardwareModel: props.HardwareModel,
      HardwareName: props.HardwareName,
      SoC: props.SoC,
      CPU: props.CPU,
      GPU: props.GPU,
      IsCrawler: props.IsCrawler,
      CrawlerName: props.CrawlerName,
    },
  };
}

/**
 * POST /api/ai-analyze
 * Separate API from `/api/parse`. This endpoint is reserved for AI commentary and
 * never runs the normal parser/detect flow.
 */
app.post("/api/ai-analyze", async (req, res) => {
  const userAgent = String(req.body?.userAgent ?? "");
  const clientHints =
    req.body?.clientHints && typeof req.body.clientHints === "object" ? req.body.clientHints : {};

  if (!AI_ANALYZE_API_KEY) {
    res.status(501).json({
      ok: false,
      error: "ai_analyze_not_configured",
      message:
        "AI Analyze is a separate API and is not configured on this server. Set AI_ANALYZE_API_KEY (or KONSOLE_API_KEY) to enable it.",
      received: {
        hasUserAgent: userAgent.trim().length > 0,
        clientHintKeys: Object.keys(clientHints),
      },
    });
    return;
  }

  try {
    const clientHintsPicked = pickNonEmptyClientHintsFromBody(clientHints);
    const clientHintsUsedForAi = { ...clientHintsPicked };
    delete clientHintsUsedForAi.secChUaPlatformVersion;
    const clientHintsForPrompt = clientHintsWithoutPlatformVersionForAi(clientHints);
    const localDetection = await buildLocalDetectionContext(userAgent, clientHintsUsedForAi);
    const localForPrompt = localDetectionSnapshotForAiPrompt(localDetection);
    const prompt = [
      "Risk-analyze this User-Agent and optional Client Hints using the local parser/dataset result as evidence.",
      "Sec-CH-UA-Platform-Version is intentionally omitted for this analysis (do not infer risk from it).",
      "Do not mention Sec-CH-UA-Platform-Version, Client Hints platform OS version, or any UA-vs-CH Android API contradiction — those signals are out of scope and were not supplied to the model.",
      "Chromium often freezes Android 10 + model K in the legacy UA while the real device is newer; that alone is not spoofing.",
      "Classify the UA risk as exactly one of: high, medium, low.",
      "High risk = clear spoofing/contradictions (including UA model vs Sec-CH-UA-Model mismatch such as V2068A vs V2068B), impossible OS/browser/device mix, automation/crawler/tooling, or suspicious malformed UA.",
      "Medium risk = local parser has weak confidence, stale/ambiguous WebView/OEM browser, missing model for reduced UA, or weak/conflicting but plausible signals.",
      "Low risk = local parser/dataset result matches coherent browser/platform/device signals with no meaningful conflict.",
      "Also assign riskScore as an integer from 1 to 10: 1 safest/lowest harm, 10 most harmful/highest risk.",
      "Compare the raw UA/Client Hints against localDetection. If localDetection shows a contradiction reason or no hardware match where one is expected, factor that into risk.",
      "Return ONLY valid JSON with this shape:",
      "{\"riskLevel\":\"high|medium|low\",\"riskScore\":1-10,\"summary\":\"one short sentence\",\"reasons\":[\"reason 1\",\"reason 2\"],\"recommendation\":\"short practical action\"}",
      "",
      `User-Agent: ${userAgent || "(empty)"}`,
      `Client Hints JSON from request body (platform version stripped for this AI call): ${JSON.stringify(clientHintsForPrompt)}`,
      `Client Hints actually used for local detection in this AI call: ${JSON.stringify(clientHintsUsedForAi)}`,
      `Local parser/dataset result JSON (PlatformVersion field omitted on purpose): ${JSON.stringify(localForPrompt)}`,
    ].join("\n");

    const upstream = await fetch(AI_ANALYZE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-key": AI_ANALYZE_API_KEY,
        "Authorization": `Bearer ${AI_ANALYZE_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_ANALYZE_MODEL,
        messages: [
          {
            role: "system",
            content: [
              "You are a User-Agent risk analyst. Return only valid JSON.",
              "The server merges your score with parser flags (e.g. UA vs Sec-CH-UA-Model mismatch).",
              "Never mention Sec-CH-UA-Platform-Version, never claim risk from UA Android version disagreeing with Client Hints OS/platform version, and never invent a CH platform version the JSON did not include.",
              "Frozen or reduced Android in the legacy User-Agent string is normal for Chromium and is not evidence of spoofing by itself.",
              "Do not default every case to medium; stay within the JSON schema.",
            ].join(" "),
          },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
    });
    const text = await upstream.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      res.status(upstream.status).json({
        ok: false,
        error: "ai_analyze_upstream_error",
        status: upstream.status,
        message: data?.error?.message || data?.message || text.slice(0, 1000) || "AI API request failed.",
      });
      return;
    }

    const analysis =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.message ||
      data?.analysis ||
      "";
    const riskRaw = parseAiRiskAnalysis(analysis);
    const { parsed: risk, riskAdjustNotes } = mergeAiRiskWithLocalDetection(riskRaw, localDetection, {
      userAgent,
      clientHintsRaw: clientHintsForPrompt,
    });
    const riskOut = scrubChPlatformVersionClaimsFromAiRisk(risk);

    res.json({
      ok: true,
      provider: "konsole",
      model: AI_ANALYZE_MODEL,
      localDetection,
      riskLevel: riskOut.riskLevel,
      riskScore: riskOut.riskScore,
      summary: riskOut.summary,
      reasons: riskOut.reasons,
      recommendation: riskOut.recommendation,
      analysis: riskOut.analysis || analysis || "AI API returned no analysis text.",
      riskFromModel: {
        riskLevel: riskRaw.riskLevel,
        riskScore: riskRaw.riskScore,
      },
      riskParserAdjusted: riskAdjustNotes.length > 0,
      riskAdjustNotes,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: "ai_analyze_upstream_failed",
      message: String(err?.message || err),
    });
  }
});

/**
 * POST /api/parse
 * body: { userAgent, clientHints? }
 * Returns the fast local parse immediately. If the model is not in HVMS and live lookup is allowed,
 * a background job is queued and the client can poll `lookupJob.pollUrl` for the final enriched result.
 */
app.post("/api/parse", async (req, res) => {
  try {
    const parseT0 = Date.now();
    const userAgent = req.body?.userAgent ?? "";
    const chFromHttp = clientHintsFromHttpHeaders(req.headers);
    const chFromBodyRaw =
      req.body?.clientHints && typeof req.body.clientHints === "object" ? req.body.clientHints : {};
    const chFromBodyPicked = pickNonEmptyClientHintsFromBody(chFromBodyRaw);
    // Detect only trusts Client Hints explicitly sent in JSON body (visible form
    // fields). Browser-added HTTP Sec-CH-UA-* is only used by /api/ch-probe to
    // fill the form when "Use this device" is clicked.
    const clientHints = chFromBodyPicked;
    const modelCacheOnly = modelParseCacheOnlyMode();

    const result = buildDetectionResult(
      { userAgent, clientHints },
      deviceCatalog,
      {
        allowHardwareInferenceWithoutDataset: false,
        skipDatasetHardware: modelCacheOnly,
      },
    );

    if (result.debug) {
      result.debug.clientHintsFromHeaders = chFromHttp;
      result.debug.clientHintsFromJs = chFromBodyRaw;
      result.debug.clientHintsBodyPicked = chFromBodyPicked;
      result.debug.clientHintsUsed = clientHints;
      result.debug.secChUaModelFromHeader = false;
      /** Model hint originated from JSON body (manual paste or client-collected), not from Sec-CH-UA-Model header alone. */
      result.debug.secChUaModelFromJs = Boolean(chFromBodyPicked.secChUaModel);
    }

    if (modelCacheOnly) {
      await resolveHardwareFromModelParseCache(result);
      result.gsmarena = {
        skipped: true,
        attempted: false,
        match: false,
        reason: "model_parse_cache_only",
        message: "Hardware resolved from model_parse_cache.json only.",
        hint: `Lookup key: ${result.debug?.modelKey || "(no model in UA/CH)"}`,
      };
      if (result.debug) {
        result.debug.hardwareIdentitySource = result.debug.modelParseCacheHit
          ? "model_parse_cache"
          : "none";
        result.debug.datasetMatch = false;
      }
    } else {
      const cacheHit = await readUaParseCacheEntry(userAgent, clientHints);
      applyJsonFirstHardwareLayer(result, cacheHit);

      const modelKey = result.debug?.modelKey;
      if (modelKey) {
        const modelCacheHit = await readModelParseCacheEntry(modelKey);
        applyModelParseCacheLayer(result, modelCacheHit);
      }

      const modelForGsmarena = modelForLiveLookupFromResult(result);
      const cachedLive = cachedLiveLookupForResult(result);

      if (!GSMR_ENRICH_ALLOWED) {
        result.gsmarena = {
          skipped: true,
          attempted: false,
          match: false,
          disabledAtServer: true,
          message: "GSMArena did not run (disabled on this server).",
          hint:
            "GSMArena is disabled (avoids IP blocks). Start with GSMR_ENRICH_ALLOWED=1 (e.g. npm run start:gsmarena) to look up unknown models automatically.",
        };
      } else if (result.debug.datasetMatch) {
        if (cachedLive?.ok) {
          applyGsmarenaToResult(result, cachedLive);
          result.gsmarena = {
            ...cachedLive,
            attempted: false,
            match: true,
            cached: true,
            hardwareIdentity: "gsmarena",
            message: "Using cached live specs for this known model.",
            hint: "Cached live specs were reused without calling GSMArena again.",
          };
        } else if (modelForGsmarena) {
          const job = queueLookupJob({ userAgent, clientHints });
          result.gsmarena = {
            skipped: false,
            attempted: false,
            match: false,
            scheduled: true,
            status: "queued",
            reason: "supplemental_specs",
            message: "Fetching extra live specs in the background for this known model.",
            hint: "Poll `lookupJob.pollUrl` until the background specs fetch completes.",
          };
          result.lookupJob = publicLookupJob(job);
          if (result.debug) {
            result.debug.liveLookupQueued = true;
            result.debug.liveLookupSupplemental = true;
          }
        } else {
          result.gsmarena = {
            skipped: true,
            attempted: false,
            match: false,
            reason: "device_in_dataset",
            message:
              "GSMArena was not called: this model is already in hvms_smartphone_hardware.json (dataset hit).",
            hint: "No live specs were requested because no model token was available.",
          };
        }
      } else if (modelForGsmarena) {
        const job = queueLookupJob({ userAgent, clientHints });
        result.gsmarena = {
          skipped: false,
          attempted: false,
          match: false,
          scheduled: true,
          status: "queued",
          message: "Live lookup queued and running in the background.",
          hint: "Poll `lookupJob.pollUrl` until the job completes.",
        };
        result.lookupJob = publicLookupJob(job);
        if (result.debug) {
          result.debug.liveLookupQueued = true;
        }
      } else {
        result.gsmarena = {
          ok: false,
          skipped: true,
          attempted: false,
          match: false,
          reason: "no_model_token",
          message:
            "GSMArena was not run: no model id in UA or Client Hints. Nothing was inferred from GSMArena.",
          hint: "Add Client Hints or a phone UA with a model token for automatic GSMArena lookup of unknown devices.",
        };
        if (result.debug) {
          result.debug.hardwareIdentitySource = result.debug.datasetMatch
            ? "device_db"
            : result.debug.hardwareFallback
              ? "inferred"
              : "none";
        }
      }

      applyHvmsDatasetHardwareFallback(result, deviceCatalog);

      if (shouldWriteUaParseCacheForResult(result)) {
        void writeUaParseCache(userAgent, clientHints, result);
      }
      void writeModelParseCacheFromResult(result);
    }

    result.meta.parseTimeMs = Date.now() - parseT0;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

function createAppServer() {
  if (USE_HTTPS && fs.existsSync(DEV_CERT) && fs.existsSync(DEV_KEY)) {
    return https.createServer(
      { cert: fs.readFileSync(DEV_CERT), key: fs.readFileSync(DEV_KEY) },
      app,
    );
  }
  return http.createServer(app);
}

let listened = false;
for (let attempt = 0; attempt < portAttempts; attempt++) {
  const port = portLocked ? firstPort : firstPort + attempt;
  const server = createAppServer();
  const scheme = USE_HTTPS && fs.existsSync(DEV_CERT) ? "https" : "http";
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    console.error(`${scheme}://localhost:${port}  (parser API ${PARSER_API_VERSION})`);
    if (scheme === "https") {
      console.error(
        "HTTPS dev cert — on your phone open this URL, accept the certificate warning, then Detect for real Sec-CH-UA-Model.",
      );
    }
    if (!portLocked && port !== firstPort) {
      console.error(
        `\n⚠️  This server is on port ${port} because ${firstPort} was already in use.\n` +
          `   Your browser may still be hitting an OLD app on http://localhost:${firstPort}\n` +
          `   Stop that process:  lsof -i :${firstPort} -t | xargs kill\n` +
          `   Or open: http://localhost:${port}\n`,
      );
    }
    listened = true;
    break;
  } catch (err) {
    const next = port + 1;
    if (err.code === "EADDRINUSE" && attempt < portAttempts - 1) {
      if (!portLocked) console.error(`Port ${port} busy; trying ${next}…`);
      continue;
    }
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Stop the other process, or run:\n` +
          `  PORT=${next} npm start\n` +
          `Find PID: lsof -i :${port} -t`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

if (!listened) {
  console.error("Could not bind to a port.");
  process.exit(1);
}
