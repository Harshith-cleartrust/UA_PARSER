import { parseClientHintModel } from "./parseSignals.js";

/**
 * Heuristic hardware hints when hvms_smartphone_hardware.json has no row.
 * When GSMArena enrich is off (or it fails), dataset rows take precedence over this layer.
 */

const ANDROID_VENDOR_RULES = [
  [/^(SM-|SC-|SCG-|SGH-|GT-|SCH-)/i, "Samsung"],
  /** UA often omits the hyphen: "SMA576B" → marketing id SM-A576B */
  [/^SM[A-Z][A-Z0-9]{2,}$/i, "Samsung"],
  [/^Pixel/i, "Google"],
  [/^Nexus/i, "Google"],
  [/^Redmi/i, "Xiaomi"],
  [/^POCO/i, "Xiaomi"],
  [/^POCOPHONE/i, "Xiaomi"],
  [/^Mi\s|^MI\s|^Mi-/i, "Xiaomi"],
  [/^M20\d{4}/i, "Xiaomi"],
  [/^ONEPLUS/i, "OnePlus"],
  [/^CPH\d/i, "Oppo"],
  [/^RMX/i, "Realme"],
  [/^V\d{4}/i, "Vivo"],
  [/^motorola\s|^moto\s|^XT\d/i, "Motorola"],
  [/^HUAWEI/i, "Huawei"],
  [/^ANA-|NOH-|LIO-|ELS-|VOG-/i, "Huawei"],
  [/^Sony/i, "Sony"],
  [/^LG-|^LM-/i, "LG"],
  [/^Nokia/i, "HMD Global"],
];

export function inferVendorFromAndroidModelToken(token) {
  if (!token || typeof token !== "string") return null;
  const t = token.trim();
  if (!t) return null;
  for (const [re, vendor] of ANDROID_VENDOR_RULES) {
    if (re.test(t)) return vendor;
  }
  return null;
}

/**
 * @param {{
 *   userAgent: string,
 *   platformName: string,
 *   deviceType: string,
 *   modelResolve: { raw: string | null, source: string, key: string },
 *   uaIosDiag: { key: string | null, raw: string | null },
 *   androidModel: { model: string | null },
 *   clientHints?: object,
 * }} ctx
 */
export function inferHardwareWithoutDataset(ctx) {
  const ua = ctx.userAgent || "";
  const platform = ctx.platformName || "";
  const deviceType = ctx.deviceType || "";
  const mr = ctx.modelResolve || {};
  const hints = ctx.clientHints || {};

  /** @type {{ hardwareVendor?: string, oem?: string, hardwareFamily?: string, hardwareName?: string, hardwareModel?: string, notes?: string }} */
  const out = {};

  const isIos = platform === "iOS";
  const isAndroid = platform === "Android";

  if (isIos && /\biPad\b/i.test(ua)) {
    out.hardwareVendor = "Apple";
    out.oem = "Apple";
    out.hardwareFamily = "iPad";
    const pad = ua.match(/\biPad(\d+),\d+/i);
    if (pad) {
      out.hardwareName = `iPad (${pad[1]},x series)`;
      out.hardwareModel = pad[0];
    } else {
      out.hardwareName = "iPad";
      out.hardwareModel = mr.raw && mr.raw !== "Unknown" ? mr.raw : "Unknown";
    }
    out.notes = "ios_tablet_inferred";
  } else if (isIos && deviceType === "SmartPhone") {
    const isPod = /\biPod\b/i.test(ua);
    out.hardwareVendor = "Apple";
    out.oem = "Apple";
    out.hardwareFamily = isPod ? "iPod" : "iPhone";
    if (ctx.uaIosDiag?.raw && !isPod) {
      const gen = ctx.uaIosDiag.key?.replace(/^iphone/i, "") || "";
      out.hardwareName = gen ? `iPhone ${gen} family` : "iPhone";
      out.hardwareModel = ctx.uaIosDiag.raw;
    } else {
      out.hardwareName = isPod ? "iPod" : "iPhone";
      out.hardwareModel = mr.raw && mr.raw !== "Unknown" ? mr.raw : "Unknown";
    }
    out.notes = isPod ? "ios_ipod_inferred" : "ios_product_inferred";
  } else if (isIos && deviceType === "Tablet") {
    out.hardwareVendor = "Apple";
    out.oem = "Apple";
    out.hardwareFamily = "iPad";
    out.hardwareName = "iPad";
    out.hardwareModel = mr.raw && mr.raw !== "Unknown" ? mr.raw : "Unknown";
    out.notes = "ios_tablet_inferred_generic";
  } else if (isAndroid && (deviceType === "SmartPhone" || deviceType === "Tablet")) {
    const chModel = parseClientHintModel(hints.secChUaModel);
    const token = (mr.raw && String(mr.raw).trim()) || chModel || ctx.androidModel?.model || "";
    const vendor = inferVendorFromAndroidModelToken(token);

    if (vendor) {
      out.hardwareVendor = vendor;
      out.oem = vendor;
      out.hardwareFamily = deviceType === "Tablet" ? `${vendor} tablet` : `${vendor} smartphone`;
      out.hardwareName = token || (deviceType === "Tablet" ? "Android tablet" : "Android smartphone");
      out.hardwareModel = token || "Unknown";
      out.notes = "android_prefix_rules";
    } else if (token) {
      out.hardwareVendor = "Unknown";
      out.oem = "Unknown";
      out.hardwareFamily = deviceType === "Tablet" ? "Android tablet" : "Android smartphone";
      out.hardwareName = token;
      out.hardwareModel = token;
      out.notes = "android_model_only";
    } else if (/\bSamsungBrowser\b/i.test(ua)) {
      out.hardwareVendor = "Samsung";
      out.oem = "Samsung";
      out.hardwareFamily = "Smartphone";
      out.hardwareName = "Samsung (browser hint)";
      out.hardwareModel = "Unknown";
      out.notes = "samsung_browser_hint";
    }
  }

  return out;
}
