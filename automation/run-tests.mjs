#!/usr/bin/env node
/**
 * UA / Client Hints automation runner.
 * Usage:
 *   npm run test:automation
 *   npm run test:automation -- --offline
 *   BASE_URL=http://localhost:3001 node automation/run-tests.mjs
 *   node automation/run-tests.mjs --offline --tags=apple
 *   node automation/run-tests.mjs --offline --tags=proof,crawler
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CASES_PATH = path.join(__dirname, "cases.json");
const OUTPUT_DIR = path.join(__dirname, "output");

/** One log file per UTC calendar day: one JSON line per UA (each test case), JSONL. */
function dailyLogPath(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  return path.join(OUTPUT_DIR, `daily-${ymd}.jsonl`);
}

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline") || args.includes("-o");
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

/** @returns {string[]} lowercased tags from `--tags=a,b` or `TAGS=a,b` */
function parseTagsFilter(argv) {
  const fromEnv = process.env.TAGS?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) || [];
  const prefix = "--tags=";
  const fromArg = [];
  for (const a of argv) {
    if (a.startsWith(prefix)) {
      fromArg.push(
        ...a
          .slice(prefix.length)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
    }
  }
  return [...new Set([...fromEnv, ...fromArg])];
}

const TAGS_FILTER = parseTagsFilter(args);

function readCases() {
  const raw = fs.readFileSync(CASES_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!data.cases || !Array.isArray(data.cases)) {
    throw new Error("cases.json must contain a \"cases\" array");
  }
  return data;
}

function filterCasesByTags(cases) {
  if (!TAGS_FILTER.length) return cases;
  return cases.filter((c) => {
    const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t).toLowerCase()) : [];
    return tags.some((t) => TAGS_FILTER.includes(t));
  });
}

function getProp(result, name) {
  const row = result.properties?.find((p) => p.property === name);
  return row ? row.value : undefined;
}

function matchValue(actual, rule) {
  if (rule == null || typeof rule !== "object") return { ok: false, detail: "invalid rule" };
  if ("equals" in rule) {
    const exp = rule.equals;
    if (typeof exp === "boolean") return { ok: actual === exp, detail: `expected ${exp}, got ${actual}` };
    if (typeof exp === "number" && typeof actual === "number") return { ok: actual === exp, detail: `expected ${exp}, got ${actual}` };
    const a = actual == null ? "" : String(actual);
    const b = exp == null ? "" : String(exp);
    return { ok: a === b, detail: `expected equals "${b}", got "${a}"` };
  }
  if ("includes" in rule) {
    const a = String(actual ?? "");
    const sub = String(rule.includes ?? "");
    return { ok: a.includes(sub), detail: `expected to include "${sub}", got "${a}"` };
  }
  if ("regex" in rule) {
    try {
      const re = new RegExp(rule.regex);
      const a = String(actual ?? "");
      return { ok: re.test(a), detail: `regex /${rule.regex}/ did not match "${a}"` };
    } catch (e) {
      return { ok: false, detail: `bad regex: ${e?.message || e}` };
    }
  }
  if ("exists" in rule) {
    const empty = actual == null || actual === "" || actual === "N/A";
    const want = Boolean(rule.exists);
    return { ok: want ? !empty : empty, detail: want ? "expected non-empty value" : "expected empty/N/A" };
  }
  return { ok: false, detail: "unknown rule keys: " + Object.keys(rule).join(", ") };
}

function runExpectations(caseId, body, expect) {
  const failures = [];
  if (!expect || typeof expect !== "object") return failures;

  if (expect.httpStatus != null && expect.httpStatus !== body._httpStatus) {
    failures.push({
      path: "httpStatus",
      message: `HTTP status ${body._httpStatus} !== ${expect.httpStatus}`,
      actual: body._httpStatus,
      expected: expect.httpStatus,
    });
  }

  if (expect.debug && typeof expect.debug === "object") {
    for (const [key, rule] of Object.entries(expect.debug)) {
      const actual = body.debug?.[key];
      const { ok, detail } = matchValue(actual, rule);
      if (!ok) failures.push({ path: `debug.${key}`, message: detail, actual, expected: rule });
    }
  }

  if (expect.properties && typeof expect.properties === "object") {
    for (const [propName, rule] of Object.entries(expect.properties)) {
      const actual = getProp(body, propName);
      const { ok, detail } = matchValue(actual, rule);
      if (!ok) failures.push({ path: `properties.${propName}`, message: detail, actual, expected: rule });
    }
  }

  if (expect.gsmarena && typeof expect.gsmarena === "object") {
    for (const [key, rule] of Object.entries(expect.gsmarena)) {
      const actual = body.gsmarena?.[key];
      const { ok, detail } = matchValue(actual, rule);
      if (!ok) failures.push({ path: `gsmarena.${key}`, message: detail, actual, expected: rule });
    }
  }

  if (Array.isArray(expect.propertyNamesContain)) {
    const names = new Set((body.properties || []).map((p) => p.property));
    for (const n of expect.propertyNamesContain) {
      if (!names.has(n)) {
        failures.push({
          path: `propertyNamesContain`,
          message: `missing property row: ${n}`,
          actual: [...names].filter((x) => x.includes(n.slice(0, 4)))?.slice(0, 5),
          expected: n,
        });
      }
    }
  }

  if (Array.isArray(expect.propertyNamesNotContain)) {
    const names = new Set((body.properties || []).map((p) => p.property));
    for (const n of expect.propertyNamesNotContain) {
      if (names.has(n)) {
        failures.push({
          path: `propertyNamesNotContain`,
          message: `property should not be present: ${n}`,
          actual: true,
          expected: false,
        });
      }
    }
  }

  return failures;
}

async function runIntegration(caseItem) {
  const url = `${BASE_URL}/api/parse`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAgent: caseItem.userAgent || "",
        clientHints: caseItem.clientHints || {},
      }),
    });
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: String(e?.message || e),
      body: null,
    };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _parseError: true, raw: text.slice(0, 2000) };
  }
  if (json && typeof json === "object") json._httpStatus = res.status;
  return {
    ok: res.ok,
    durationMs: Date.now() - started,
    error: res.ok ? null : `HTTP ${res.status}`,
    body: json,
  };
}

async function runOffline(caseItem) {
  process.env.MODEL_PARSE_CACHE = process.env.MODEL_PARSE_CACHE || "1";
  const { loadDeviceIndex, defaultDatasetPath } = await import("../lib/deviceIndex.js");
  const { buildDetectionResult } = await import("../lib/buildResult.js");
  const { loadModelParseCacheAtStartup, resolveHardwareFromModelParseCache } = await import("../lib/modelParseCache.js");

  const started = Date.now();
  try {
    await loadModelParseCacheAtStartup();
    const catalog = loadDeviceIndex(defaultDatasetPath());
    const result = buildDetectionResult(
      { userAgent: caseItem.userAgent || "", clientHints: caseItem.clientHints || {} },
      catalog,
      { allowHardwareInferenceWithoutDataset: false, skipDatasetHardware: true },
    );
    await resolveHardwareFromModelParseCache(result);
    result.gsmarena = {
      skipped: true,
      attempted: false,
      match: false,
      reason: "model_parse_cache_only",
      message: "Hardware resolved from model_parse_cache.json only (offline runner).",
    };
    if (result.debug) {
      result.debug.hardwareIdentitySource = result.debug.modelParseCacheHit ? "model_parse_cache" : "none";
      result.debug.datasetMatch = false;
    }
    result._httpStatus = 200;
    return { ok: true, durationMs: Date.now() - started, error: null, body: result };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: String(e?.message || e),
      body: null,
    };
  }
}

async function main() {
  const suite = readCases();
  let cases = filterCasesByTags(suite.cases);
  const startedAt = new Date().toISOString();
  const mode = OFFLINE ? "offline" : "integration";
  const logPath = dailyLogPath(new Date(startedAt));

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const id = c.id || `case-${i}`;
    const run = OFFLINE ? await runOffline(c) : await runIntegration(c);
    const body = run.body;
    let failures = [];
    let passed = null;

    if (run.ok && body && c.expect) {
      failures = runExpectations(id, body, c.expect);
      passed = failures.length === 0;
      if (!passed) failed += 1;
    } else if (run.ok && body && !c.expect) {
      passed = null;
    } else {
      failed += 1;
      passed = false;
      failures = [{ path: "request", message: run.error || "request failed", actual: null, expected: "ok response" }];
    }

    const ok = run.ok && failures.length === 0;

    const ch = c.clientHints && typeof c.clientHints === "object" ? c.clientHints : {};
    const hasCh = Object.keys(ch).length > 0;
    const lineObj = {
      ts: new Date().toISOString(),
      run: startedAt,
      mode,
      id,
      ok,
      ms: run.durationMs,
      ua: c.userAgent || "",
    };
    if (hasCh) lineObj.ch = ch;
    if (failures.length) lineObj.failures = failures;
    if (run.error) lineObj.error = run.error;
    if (body?.debug) {
      lineObj.dbg = {
        modelKey: body.debug.modelKey ?? null,
        modelParseCacheHit: body.debug.modelParseCacheHit ?? null,
        modelSource: body.debug.modelSource ?? null,
      };
    }
    if (c.captureFullResponse && body) lineObj.response = body;
    const line = JSON.stringify(lineObj);
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
    console.log(line);
  }

  const finishedAt = new Date().toISOString();
  const logRelative = path.relative(ROOT, logPath).split(path.sep).join("/");
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  console.log(
    JSON.stringify({
      ts: finishedAt,
      kind: "suite",
      ok: failed === 0,
      total: cases.length,
      failed,
      durationMs,
      log: logRelative,
    }),
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ error: String(e?.message || e), stack: e?.stack }));
  process.exit(1);
});
