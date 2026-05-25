/**
 * UA / Client-Hints diagnostic rows (human-readable names) appended after core HVMS-style fields.
 * GSMArena refinements via `applyGsmaToDiagnosticRows` after live lookup.
 */

function stripHintQuotes(s) {
  if (s == null || typeof s !== "string") return "";
  return s.replace(/^["']|["']$/g, "").trim();
}

function nv(val) {
  if (val == null || val === "") return "N/A";
  return String(val);
}

function renderingEngine(ua) {
  if (!ua) return "N/A";
  if (/Gecko\//i.test(ua) && /rv:\d/i.test(ua)) return "Gecko";
  if (/AppleWebKit/i.test(ua)) {
    if (/Chrome|CriOS|Edg|SamsungBrowser/i.test(ua) && !/Version\/[\d.]+.*Safari\/[\d.]+$/i.test(ua)) {
      return "Blink (Chromium)";
    }
    return "WebKit";
  }
  return "Unknown";
}

function cpuArchitecture(ua, ch) {
  const fromHint = stripHintQuotes(ch?.secChUaArch || ch?.SecCHUAArch || ch?.["Sec-CH-UA-Arch"]);
  if (fromHint) return fromHint;
  if (!ua) return "N/A";
  if (/\barm64-v8a|aarch64|ARM64\b/i.test(ua)) return "arm64";
  const armv = ua.match(/\barmv[78][l]?\b/i);
  if (armv) return armv[0].toLowerCase();
  if (/\bx86_64|Win64|WOW64|amd64\b/i.test(ua)) return "x86_64";
  if (/\bi686|i386|x86\b/i.test(ua)) return "x86";
  return "N/A";
}

function androidWebView(ua) {
  if (!ua) return "No";
  return /;\s*wv\)/i.test(ua) || (/\bwv\b/i.test(ua) && /Android/i.test(ua)) ? "Yes" : "No";
}

function inAppBrowser(ua) {
  if (!ua) return "No";
  return /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|TwitterAndroid|musical_ly|TikTok|Snapchat|Pinterest/i.test(ua)
    ? "Yes"
    : "No";
}

export function browserTypeLabel(ua, deviceType, browserName) {
  const mobileUa = /\bMobile\b/i.test(ua || "") || /Mobile|CriOS|EdgiOS|SamsungBrowser/i.test(browserName || "");
  if (deviceType === "SmartPhone" || deviceType === "Tablet" || mobileUa) {
    return "mobile browser";
  }
  if (deviceType === "Desktop" || deviceType === "Desktop/Laptop") {
    return "desktop browser";
  }
  return browserName && browserName !== "Unknown" ? browserName : "N/A";
}

function mobileBrowserLabel(ua, deviceType, browserName) {
  const mobileUa = /\bMobile\b/i.test(ua || "") || /Mobile/i.test(browserName || "");
  if (deviceType === "SmartPhone" || deviceType === "Tablet") {
    return mobileUa || /Mobile|CriOS|EdgiOS|SamsungBrowser/i.test(browserName || "") ? "Yes" : "Likely (mobile-class device)";
  }
  return "No";
}

function propRow(property, value, source, confidence) {
  return { property, value: nv(value), source, confidence };
}

/**
 * @param {{
 *   userAgent: string,
 *   clientHints?: object,
 *   browser: { name: string, vendor: string, version: string },
 *   platform: { name: string, vendor: string, version: string },
 *   deviceType: string,
 *   crawler: { isCrawler: boolean, name: string },
 *   hardwareModelDisplay: string,
 *   hardwareVendor: string,
 * }} ctx
 */
export function buildUADiagnosticRows(ctx) {
  const ua = ctx.userAgent || "";
  const ch = ctx.clientHints || {};
  const { browser, platform, deviceType, crawler } = ctx;

  return [
    propRow("Operating System", platform.name, "evidence", "medium"),
    propRow("OS Version", platform.version, "evidence", "medium"),
    propRow("Browser Type", browserTypeLabel(ua, deviceType, browser.name), "evidence", "medium"),
    propRow("Rendering Engine", renderingEngine(ua), "evidence", "low"),
    propRow("Device Model", ctx.hardwareModelDisplay, "evidence", "medium"),
    propRow("Manufacturer", ctx.hardwareVendor, "evidence", "medium"),
    propRow("CPU Architecture", cpuArchitecture(ua, ch), "evidence", "low"),
    propRow("Mobile Browser", mobileBrowserLabel(ua, deviceType, browser.name), "evidence", "low"),
    propRow("Android WebView", androidWebView(ua), "evidence", "high"),
    propRow("In-App Browser", inAppBrowser(ua), "evidence", "medium"),
    propRow("Automation / Bots", crawler.isCrawler ? crawler.name : "None detected", "rules", "high"),
    propRow("Approx Device Age", "N/A", "none", "unknown"),
  ];
}

function pickRow(properties, name) {
  return properties.find((p) => p.property === name) || null;
}

/**
 * @param {Array<{ property: string, value: string, source: string, confidence: string }>} properties
 * @param {object} g
 * @param {{ precomputedVendor?: string | null }} [opts]
 */
export function applyGsmaToDiagnosticRows(properties, g, opts = {}) {
  if (!g?.ok || !Array.isArray(properties)) return;

  const vendor = opts.precomputedVendor ?? null;
  const year = new Date().getFullYear();

  const modelRow = pickRow(properties, "Device Model");
  if (modelRow && g.name) {
    modelRow.value = nv(g.name);
    modelRow.source = "gsmarena";
    modelRow.confidence = "low";
  }

  const manRow = pickRow(properties, "Manufacturer");
  if (manRow && vendor) {
    manRow.value = nv(vendor);
    manRow.source = "gsmarena";
    manRow.confidence = "low";
  }

  const osVer = pickRow(properties, "OS Version");
  if (osVer && g.gsmarenaLaunchOs) {
    const prev = osVer.value && osVer.value !== "N/A" ? osVer.value : "";
    osVer.value = prev ? `${prev} · ${g.gsmarenaLaunchOs}` : nv(g.gsmarenaLaunchOs);
    osVer.source = "gsmarena";
    osVer.confidence = "low";
  }

  const ageRow = pickRow(properties, "Approx Device Age");
  if (ageRow && g.gsmarenaAnnouncedYear != null && Number.isFinite(g.gsmarenaAnnouncedYear)) {
    const y = Math.max(0, year - g.gsmarenaAnnouncedYear);
    ageRow.value = `~${y}y since announced (${g.gsmarenaAnnouncedYear}, rough)`;
    ageRow.source = "gsmarena";
    ageRow.confidence = "low";
  }
}
