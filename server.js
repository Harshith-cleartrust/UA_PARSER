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
  mergeClientHintsFromRequest,
  pickNonEmptyClientHintsFromBody,
} from "./lib/clientHintsFromRequest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USE_HTTPS = process.env.USE_HTTPS === "1";
const DEV_CERT = path.join(__dirname, ".dev", "cert.pem");
const DEV_KEY = path.join(__dirname, ".dev", "key.pem");
const firstPort = Number(process.env.PORT) || 3000;
const portLocked = Boolean(process.env.PORT);
const portAttempts = portLocked ? 1 : 15;

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
    const clientHints = mergeClientHintsFromRequest(req);
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
      result.debug.secChUaModelFromHeader = Boolean(chFromHttp.secChUaModel && !chFromBodyPicked.secChUaModel);
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
