import { normalizeModelKey } from "./deviceIndex.js";
import { detectCrawlerLabeled } from "./crawlerPatterns.js";

/**
 * iPhone hardware id in UA: "iPhone15,2" → dataset keys use "iphone15" (generation only).
 * Many modern Safari UAs omit this token (privacy), so often no match.
 */
export function extractIosIphoneGenerationFromUa(ua) {
  if (!ua || typeof ua !== "string") return { key: null, raw: null, reason: "empty" };
  if (!/\biPhone\b/i.test(ua) || /\biPad\b/i.test(ua)) {
    return { key: null, raw: null, reason: "not_iphone_phone" };
  }
  const m = ua.match(/\biPhone(\d+),\d+/i);
  if (!m) return { key: null, raw: null, reason: "iphone_comma_id_missing" };
  const gen = m[1];
  return {
    key: `iphone${gen}`.toLowerCase(),
    raw: m[0],
    reason: "ua_iphone_comma",
  };
}

/**
 * True when the Mozilla device parenthetical mixes an iPhone product token with
 * Android version + model (e.g. "(iPhone; Android 15; SM-S921B)"). Real UAs do
 * not combine these; treating them as Android would create false Samsung matches.
 */
function isSpoofedIphoneAndroidUa(ua) {
  if (!ua || typeof ua !== "string") return false;
  return /\([^)]*\biPhone\b[^)]*\bAndroid\s+[\d.]+[^)]*\)/i.test(ua);
}

/**
 * Real Android browsers (Chrome, WebView, Samsung Internet, …) include a Chrome-family
 * or other known product token. "Safari" + Apple vendor on an Android UA without any
 * of those is impossible for a normal phone — treat as contradictory / forged UA string.
 * @param {string} ua
 * @param {{ name: string, vendor: string, version: string }} browser
 * @param {{ name: string, vendor: string, version: string }} platform
 */
export function reconcileAndroidUaBrowser(ua, browser, platform) {
  if (!ua || typeof ua !== "string") return browser;
  if (platform?.name !== "Android") return browser;
  if (!/\bAndroid\s+[\d.]+/i.test(ua)) return browser;
  if (browser?.name !== "Safari" || browser?.vendor !== "Apple") return browser;
  if (/(?:Chrome|CriOS|Edg(?:A|iOS)?|SamsungBrowser|Firefox|OPR|Opera|UCBrowser|MiuiBrowser|MQQBrowser)\//i.test(ua)) {
    return browser;
  }
  return { name: "Unknown", vendor: "N/A", version: "N/A" };
}

/**
 * Android model from the device segment: either "... MODEL Build/..." or
 * "... MODEL)" (Samsung Internet / compact UAs omit Build/).
 */
export function extractAndroidModelFromUa(ua) {
  if (!ua || typeof ua !== "string") return { model: null, reason: "empty" };

  if (isSpoofedIphoneAndroidUa(ua)) {
    return { model: null, reason: "ua_iphone_android_spoof" };
  }

  if (isChromeReducedAndroidUa(ua)) {
    return { model: null, reason: "chrome_reduced_ua" };
  }

  const androidVer = matchAndroidVersion(ua);
  if (!androidVer && !/\bAndroid\b/i.test(ua)) {
    return { model: null, reason: "not_android" };
  }

  const buildMatch = ua.match(/Android\s+[\d.]+;\s*(?:[^;)]+;\s*)*([^;)]+?)\s+Build\//i);
  if (buildMatch) {
    const token = stripParenthetical(buildMatch[1]).trim();
    if (token && !isLocaleLike(token)) return { model: token, reason: "ua_build_segment" };
  }

  const paren = ua.match(/\(([^)]*Linux[^)]*)\)/i);
  if (paren) {
    const inner = paren[1];
    const m = inner.match(/Android\s+[\d.]+;\s*(?:[^;)]+;\s*)*([^;)]+?)\s+Build\//i);
    if (m) {
      const token = stripParenthetical(m[1]).trim();
      if (token && !isLocaleLike(token)) return { model: token, reason: "ua_paren_build" };
    }
    if (/Android/i.test(inner)) {
      const token = extractModelTokenAfterAndroidVersion(inner);
      if (token) return { model: token, reason: "ua_paren_no_build" };
    }
  }

  const parenAndroid = ua.match(/\(([^)]*\bAndroid\s+[\d.]+[^)]*)\)/i);
  if (parenAndroid && (!paren || parenAndroid[1] !== paren[1])) {
    const inner2 = parenAndroid[1];
    const token2 = extractModelTokenAfterAndroidVersion(inner2);
    if (token2) return { model: token2, reason: "ua_android_paren" };
  }

  const token = extractModelTokenAfterAndroidVersion(ua);
  if (token) return { model: token, reason: "ua_no_build" };

  if (/Android/i.test(ua)) {
    const sm = ua.match(/\b(SM-[A-Z0-9]{2,})\b/i);
    if (sm) return { model: sm[1], reason: "ua_sm_token" };
  }

  return { model: null, reason: "android_model_unknown" };
}

/**
 * Text after "Android {ver};" up to Build/ or closing paren — last non-locale segment.
 */
function extractModelTokenAfterAndroidVersion(text) {
  const m = text.match(/Android\s+[\d.]+;\s*(.*)$/is);
  if (!m) return null;
  let segment = m[1].trim();
  const closeIdx = segment.indexOf(")");
  if (closeIdx >= 0) segment = segment.slice(0, closeIdx).trim();
  segment = segment.replace(/\)\s*$/u, "").trim();
  const buildIdx = segment.search(/\s+Build\//i);
  if (buildIdx >= 0) segment = segment.slice(0, buildIdx).trim();
  const parts = segment.split(/\s*;\s*/).map((p) => p.trim()).filter(Boolean);
  let token = parts.length ? parts[parts.length - 1] : null;
  while (token && isLocaleLike(token) && parts.length > 1) {
    parts.pop();
    token = parts[parts.length - 1];
  }
  while (token && isAndroidUaJunkToken(token) && parts.length > 1) {
    parts.pop();
    token = parts[parts.length - 1];
  }
  if (!token || isLocaleLike(token) || isAndroidUaJunkToken(token)) return null;
  return token;
}

function isAndroidUaJunkToken(s) {
  const t = String(s).trim();
  // Chrome reduced / GREASE UA uses a single letter where the model used to be (e.g. "Android 10; K").
  if (/^k$/i.test(t)) return true;
  if (t.length === 1 && /^[a-z]$/i.test(t)) return true;
  return /^(wv|mobile|tablet|linux|aarch64|arm64|x86_64|en-us|en-gb)$/i.test(t);
}

/** True when Chrome (or similar) replaced the device model with the GREASE token "K". */
export function isChromeReducedAndroidUa(ua) {
  if (!ua || typeof ua !== "string") return false;
  return /\bAndroid\s+[\d.]+;\s*K\b/i.test(ua) || /\bAndroid\s+[\d.]+;\s*K\s*\)/i.test(ua);
}

function stripParenthetical(s) {
  return s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function isLocaleLike(s) {
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(s.trim());
}

function matchAndroidVersion(ua) {
  const m = ua?.match(/Android\s+([\d.]+)/i);
  return m ? m[1] : null;
}

export function detectCrawler(ua) {
  return detectCrawlerLabeled(ua);
}

export function parseBrowser(ua) {
  if (!ua) return { name: "Unknown", vendor: "N/A", version: "N/A" };

  if (/EdgiOS\//i.test(ua)) {
    return { name: "Edge Mobile", vendor: "Microsoft", version: firstVersion(ua, /EdgiOS\/(\d+)/i) };
  }
  if (/Edg\//i.test(ua)) {
    return { name: "Edge", vendor: "Microsoft", version: firstVersion(ua, /Edg\/(\d+)/i) };
  }
  if (/CriOS\//i.test(ua)) {
    return { name: "Chrome Mobile", vendor: "Google", version: firstVersion(ua, /CriOS\/(\d+)/i) };
  }
  if (/SamsungBrowser\//i.test(ua)) {
    return {
      name: "Samsung Internet",
      vendor: "Samsung",
      version: firstVersion(ua, /SamsungBrowser\/(\d+)/i),
    };
  }
  if (/Chrome\//i.test(ua) && /Mobile/i.test(ua) && !/Edg/i.test(ua)) {
    return { name: "Chrome Mobile", vendor: "Google", version: firstVersion(ua, /Chrome\/(\d+)/i) };
  }
  if (/Chrome\//i.test(ua) && !/Edg/i.test(ua)) {
    return { name: "Chrome", vendor: "Google", version: firstVersion(ua, /Chrome\/(\d+)/i) };
  }
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
    return { name: "Safari", vendor: "Apple", version: firstVersion(ua, /Version\/(\d+)/i) };
  }
  if (/Firefox\//i.test(ua)) {
    return { name: "Firefox", vendor: "Mozilla", version: firstVersion(ua, /Firefox\/(\d+)/i) };
  }

  return { name: "Unknown", vendor: "N/A", version: "N/A" };
}

function firstVersion(ua, re) {
  const m = ua.match(re);
  return m ? m[1] : "N/A";
}

export function parsePlatform(ua, clientHints) {
  const uaAndroid = matchAndroidVersion(ua);
  const chPlatform = stripHintQuotes(clientHints?.secChUaPlatform);
  const chPlatVer = stripHintQuotes(clientHints?.secChUaPlatformVersion);

  if (uaAndroid || /Android/i.test(ua || "")) {
    return {
      name: "Android",
      vendor: "Google",
      /** UA `Android 12` wins over `Sec-CH-UA-Platform-Version` so pasted captures match the string; CH fills gaps when UA omits the version. */
      version: uaAndroid || chPlatVer || "N/A",
    };
  }

  if (/iPhone|iPad|iPod/i.test(ua || "")) {
    const v = firstVersion(ua || "", /OS (\d+[._]\d+)/i)?.replace("_", ".") || "N/A";
    return { name: "iOS", vendor: "Apple", version: v };
  }

  const chMobile = stripHintQuotes(clientHints?.secChUaMobile);
  const looksIosMobileFromClientHints =
    /^iOS$/i.test(chPlatform) &&
    chMobile === "?1" &&
    (/like Mac OS X/i.test(ua || "") ||
      (/Version\//i.test(ua || "") && /\bMobile\//i.test(ua || "")));
  if (looksIosMobileFromClientHints) {
    const v =
      firstVersion(ua || "", /Version\/(\d+(?:\.\d+)?)/i) ||
      firstVersion(ua || "", /OS (\d+[._]\d+)/i)?.replace("_", ".") ||
      chPlatVer ||
      "N/A";
    return { name: "iOS", vendor: "Apple", version: v };
  }

  if (/Mac OS X/i.test(ua || "")) {
    const v =
      firstVersion(ua || "", /Mac OS X (\d+[._]\d+)/i)?.replace(/_/g, ".") || "N/A";
    return { name: "macOS", vendor: "Apple", version: v };
  }

  if (/Windows NT/i.test(ua || "")) {
    return { name: "Windows", vendor: "Microsoft", version: "N/A" };
  }

  if (/\bLinux\b/i.test(ua || "") && !/\bAndroid\b/i.test(ua || "")) {
    return { name: "Linux", vendor: "N/A", version: "N/A" };
  }

  if (chPlatform) {
    return { name: chPlatform, vendor: "N/A", version: chPlatVer || "N/A" };
  }

  return { name: "Unknown", vendor: "N/A", version: "N/A" };
}

function stripHintQuotes(s) {
  if (s == null || typeof s !== "string") return "";
  let t = String(s).trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return t.replace(/^["']|["']$/g, "").trim();
}

export function parseClientHintModel(raw) {
  const s = stripHintQuotes(raw);
  if (!s) return null;
  if (isAndroidUaJunkToken(s)) return null;
  return s;
}

export function deviceClassFromSignals(ua, clientHints) {
  const chPlatform = stripHintQuotes(clientHints?.secChUaPlatform);
  const chMobile = stripHintQuotes(clientHints?.secChUaMobile);
  if (/^iOS$/i.test(chPlatform) && chMobile === "?1") {
    if (/iPad|Tablet/i.test(ua || "")) return "Tablet";
    return "SmartPhone";
  }

  const mobile =
    /\bMobile\b/i.test(ua || "") ||
    stripHintQuotes(clientHints?.secChUaMobile) === "?1" ||
    /iPhone|iPod|Mobile/i.test(ua || "");
  const tablet = /iPad|Tablet/i.test(ua || "");
  if (tablet) return "Tablet";
  if (mobile || /Android.*Mobile/i.test(ua || "")) return "SmartPhone";
  if (/Android/i.test(ua || "")) return "SmartPhone";
  if (/Macintosh|Windows|X11|Linux(?!.*Android)/i.test(ua || "")) return "Desktop";
  return "Unknown";
}

function iosGenerationKeyFromString(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/\biPhone\s*(\d+),\d+/i);
  if (m) return `iphone${m[1]}`.toLowerCase();
  return null;
}

function modelKeyFromHardwareToken(token) {
  if (!token || typeof token !== "string") return "";
  const iosKey = iosGenerationKeyFromString(token);
  return iosKey || normalizeModelKey(token);
}

/**
 * Both UA and Client Hints report a concrete model that normalizes to different keys
 * (e.g. V2068A in UA vs V2068B in Sec-CH-UA-Model). Real devices keep these aligned.
 */
export function detectModelSourceConflict({ userAgent, clientHints }) {
  const ua = userAgent || "";
  const iosHit = extractIosIphoneGenerationFromUa(ua);
  const uaHit = extractAndroidModelFromUa(ua);
  const uaToken = iosHit.raw || uaHit.model;
  if (!uaToken) return null;

  const chModel = parseClientHintModel(clientHints?.secChUaModel);
  if (!chModel) return null;

  const uaKey = iosHit.key || modelKeyFromHardwareToken(uaHit.model);
  const chKey = modelKeyFromHardwareToken(chModel);
  if (!uaKey || !chKey || uaKey === chKey) return null;

  return {
    reason: "ua_client_hint_model_mismatch",
    uaModel: uaToken,
    chModel,
    uaKey,
    chKey,
  };
}

/**
 * Prefer a concrete UA model. Use Sec-CH-UA-Model only when the UA is generic,
 * reduced, or missing a usable hardware token (for example Android's "K").
 */
export function resolveHardwareModelKey({ userAgent, clientHints }) {
  const iosHit = extractIosIphoneGenerationFromUa(userAgent || "");
  if (iosHit.key) {
    return {
      key: iosHit.key,
      raw: iosHit.raw,
      source: "user_agent",
    };
  }
  const uaHit = extractAndroidModelFromUa(userAgent || "");
  if (uaHit.model) {
    return {
      key: normalizeModelKey(uaHit.model),
      raw: uaHit.model,
      source: "user_agent",
    };
  }
  const chModel = parseClientHintModel(clientHints?.secChUaModel);
  if (chModel) {
    const iosKey = iosGenerationKeyFromString(chModel);
    return {
      key: iosKey || normalizeModelKey(chModel),
      raw: chModel,
      source: "client_hint",
    };
  }
  return { key: "", raw: null, source: "none" };
}
