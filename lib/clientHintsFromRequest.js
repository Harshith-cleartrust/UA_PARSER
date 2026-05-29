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

/**
 * Copy alternate property names (e.g. `Sec-CH-UA-Model`) onto the canonical keys this
 * server expects, so `/api/parse` and `/api/ai-analyze` see the same model Client Hints
 * callers intended to send.
 */
export function normalizeClientHintsBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out = { ...body };
  const trim = (v) => (v == null ? "" : String(v).trim());

  const modelPrimary = trim(out.secChUaModel);
  if (!modelPrimary || !parseClientHintModel(modelPrimary)) {
    for (const k of ["Sec-CH-UA-Model", "sec-ch-ua-model", "sec_ch_ua_model", "Sec_CH_UA_Model"]) {
      const t = trim(out[k]);
      if (t && parseClientHintModel(t)) {
        out.secChUaModel = t.replace(/^["']|["']$/g, "").trim();
        break;
      }
    }
  }

  if (!trim(out.secChUaMobile) && trim(out["Sec-CH-UA-Mobile"])) {
    out.secChUaMobile = trim(out["Sec-CH-UA-Mobile"]);
  }
  if (!trim(out.secChUaPlatform) && trim(out["Sec-CH-UA-Platform"])) {
    out.secChUaPlatform = trim(out["Sec-CH-UA-Platform"]);
  }
  if (!trim(out.secChUaPlatformVersion) && trim(out["Sec-CH-UA-Platform-Version"])) {
    out.secChUaPlatformVersion = trim(out["Sec-CH-UA-Platform-Version"]);
  }

  return out;
}

/** Only keys with non-empty string values (explicit client hints from JSON body). */
export function pickNonEmptyClientHintsFromBody(body) {
  const out = {};
  const normalized = normalizeClientHintsBody(body);
  if (!normalized || typeof normalized !== "object") return out;
  for (const k of ["secChUaModel", "secChUaMobile", "secChUaPlatform", "secChUaPlatformVersion"]) {
    const v = normalized[k];
    if (v == null || String(v).trim() === "") continue;
    if (k === "secChUaModel") {
      if (parseClientHintModel(String(v).trim())) out[k] = String(v).trim();
      continue;
    }
    out[k] = String(v).trim();
  }
  return out;
}

