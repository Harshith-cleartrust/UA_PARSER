/**
 * Read User-Agent Client Hints from incoming HTTP headers (Sec-CH-UA-*).
 * Browsers send these only after the origin responds with Accept-CH (see server middleware).
 */

import { parseClientHintModel } from "./parseSignals.js";

export const ACCEPT_CH_VALUE =
  "Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model";

/** Express / Node lowercases header names. */
export function clientHintsFromHttpHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  const model = headers["sec-ch-ua-model"];
  const mobile = headers["sec-ch-ua-mobile"];
  const platform = headers["sec-ch-ua-platform"];
  const platformVer = headers["sec-ch-ua-platform-version"];
  if (model != null && String(model).trim() !== "" && parseClientHintModel(model))
    out.secChUaModel = String(model).trim();
  if (mobile != null && String(mobile).trim() !== "") out.secChUaMobile = String(mobile).trim();
  if (platform != null && String(platform).trim() !== "") out.secChUaPlatform = String(platform).trim();
  if (platformVer != null && String(platformVer).trim() !== "")
    out.secChUaPlatformVersion = String(platformVer).trim();
  return out;
}

/** Only keys with non-empty string values (explicit client hints from JSON body). */
export function pickNonEmptyClientHintsFromBody(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  for (const k of ["secChUaModel", "secChUaMobile", "secChUaPlatform", "secChUaPlatformVersion"]) {
    const v = body[k];
    if (v == null || String(v).trim() === "") continue;
    if (k === "secChUaModel") {
      if (parseClientHintModel(String(v).trim())) out[k] = String(v).trim();
      continue;
    }
    out[k] = String(v).trim();
  }
  return out;
}

/**
 * Merge HTTP Sec-CH-UA-* with JSON body.clientHints.
 * Non-empty body fields win (manual / testing on desktop where browser would otherwise send Mac hints).
 * HTTP fills any key not set in the body.
 */
export function mergeClientHintsFromRequest(req) {
  const fromBodyRaw = req.body?.clientHints && typeof req.body.clientHints === "object" ? req.body.clientHints : {};
  const fromBody = pickNonEmptyClientHintsFromBody(fromBodyRaw);
  const fromHttp = clientHintsFromHttpHeaders(req.headers);
  const merged = { ...fromHttp, ...fromBody };
  if (merged.secChUaModel != null && !parseClientHintModel(String(merged.secChUaModel))) {
    delete merged.secChUaModel;
  }
  return merged;
}
