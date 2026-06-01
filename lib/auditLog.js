import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DIR = path.join(__dirname, "..", "data", "audit");
const MAX_UA_CHARS = Number(process.env.AUDIT_LOG_UA_MAX_CHARS) || 2048;

export function auditLogEnabled() {
  return process.env.AUDIT_LOG === "1";
}

/** Local calendar date `YYYY-MM-DD` for daily log file names. */
export function auditLogDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Directory that holds daily files (`YYYY-MM-DD.jsonl`). */
export function auditLogDir() {
  const p = process.env.AUDIT_LOG_PATH?.trim();
  if (!p) return DEFAULT_DIR;
  const resolved = path.resolve(process.cwd(), p);
  if (resolved.endsWith(".jsonl")) return path.dirname(resolved);
  return resolved;
}

/** Path for one day's audit log. */
export function auditLogPathForDate(date = new Date()) {
  return path.join(auditLogDir(), `${auditLogDateKey(date)}.jsonl`);
}

/** Today's log file (used at startup and in health). */
export function auditLogPath() {
  return auditLogPathForDate(new Date());
}

/** `full` | `truncate` (default) | `hash` */
function uaMode() {
  const m = String(process.env.AUDIT_LOG_UA_MODE || "truncate").toLowerCase();
  if (m === "full" || m === "hash") return m;
  return "truncate";
}

export function clientIpFromRequest(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
}

function recordUserAgent(raw) {
  const ua = String(raw ?? "");
  if (!ua) return { mode: uaMode(), length: 0, value: "" };
  const mode = uaMode();
  if (mode === "hash") {
    return {
      mode,
      length: ua.length,
      value: createHash("sha256").update(ua).digest("hex"),
    };
  }
  if (mode === "full" || ua.length <= MAX_UA_CHARS) {
    return { mode: mode === "full" ? "full" : "truncate", length: ua.length, value: ua };
  }
  return { mode: "truncate", length: ua.length, value: ua.slice(0, MAX_UA_CHARS) };
}

export function clientHintKeysFromBody(body) {
  if (!body || typeof body !== "object") return [];
  return Object.keys(body).filter((k) => {
    const v = body[k];
    return v != null && String(v).trim() !== "";
  });
}

/**
 * Append one JSON line to today's file. Failures go to stderr only.
 * @param {Record<string, unknown>} entry
 */
export function writeAuditEntry(entry) {
  if (!auditLogEnabled()) return;
  const at = entry.at ? new Date(String(entry.at)) : new Date();
  const filePath = auditLogPathForDate(at);
  const line = `${JSON.stringify(entry)}\n`;
  void (async () => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    } catch (err) {
      console.error("[audit-log] write failed:", err?.message || err);
    }
  })();
}

export function auditLogStatus() {
  const today = auditLogDateKey();
  return {
    enabled: auditLogEnabled(),
    dir: auditLogEnabled() ? auditLogDir() : null,
    filePattern: "YYYY-MM-DD.jsonl",
    todayFile: auditLogEnabled() ? auditLogPath() : null,
    today,
    uaMode: uaMode(),
    uaMaxChars: MAX_UA_CHARS,
  };
}

/**
 * @param {import('express').Request} req
 * @param {object} opts
 */
export function auditParseRequest(req, opts) {
  const {
    ok,
    status,
    durationMs,
    error,
    result,
    clientHintsPicked = {},
  } = opts;

  const debug = result?.debug || {};
  const props =
    result?.properties && !Array.isArray(result.properties)
      ? result.properties
      : null;
  const hardwareModel =
    props?.HardwareModel ??
    result?.properties?.find?.((p) => p.property === "HardwareModel")?.value;

  writeAuditEntry({
    at: new Date().toISOString(),
    type: "parse",
    endpoint: "/api/parse",
    method: req.method,
    ip: clientIpFromRequest(req),
    ok: Boolean(ok),
    status: status ?? (ok ? 200 : 500),
    durationMs,
    responseFormat: String(req.query?.format ?? req.body?.format ?? "slim"),
    userAgent: recordUserAgent(req.body?.userAgent),
    clientHintKeys: clientHintKeysFromBody(clientHintsPicked),
    modelKey: debug.modelKey ?? null,
    modelSource: debug.modelSource ?? null,
    modelParseCacheHit: debug.modelParseCacheHit ?? false,
    modelSourceConflict: debug.modelSourceConflict?.reason ?? null,
    hardwareModel: hardwareModel && hardwareModel !== "N/A" ? hardwareModel : null,
    isCrawler:
      props?.IsCrawler ??
      result?.properties?.find?.((p) => p.property === "IsCrawler")?.value ??
      null,
    parserVersion: result?.meta?.parserVersion ?? null,
    parseTimeMs: result?.meta?.parseTimeMs ?? null,
    error: error ? String(error) : null,
  });
}

/**
 * @param {import('express').Request} req
 * @param {object} opts
 */
export function auditAiAnalyzeRequest(req, opts) {
  const {
    ok,
    status,
    durationMs,
    error,
    riskLevel,
    riskScore,
    riskParserAdjusted,
    localDetection,
  } = opts;

  const debug = localDetection?.debug || {};

  writeAuditEntry({
    at: new Date().toISOString(),
    type: "ai_analyze",
    endpoint: "/api/ai-analyze",
    method: req.method,
    ip: clientIpFromRequest(req),
    ok: Boolean(ok),
    status: status ?? (ok ? 200 : 500),
    durationMs,
    userAgent: recordUserAgent(req.body?.userAgent),
    clientHintKeys: clientHintKeysFromBody(
      opts.clientHintsPicked ?? req.body?.clientHints ?? {},
    ),
    modelKey: debug.modelKey ?? null,
    modelSourceConflict: debug.modelSourceConflict?.reason ?? null,
    riskLevel: riskLevel ?? null,
    riskScore: riskScore ?? null,
    riskParserAdjusted: riskParserAdjusted ?? false,
    error: error ? String(error) : null,
  });
}
