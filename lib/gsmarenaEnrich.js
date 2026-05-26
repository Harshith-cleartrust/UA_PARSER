import { createRequire } from "node:module";
import { inferVendorFromAndroidModelToken } from "./fallbackInference.js";
import { extractInternalModelCodesFromDetailSpec } from "./gsmarenaModelCodes.js";
import { normalizeModelKey } from "./deviceIndex.js";
import { prepareGsmarenaHttpTransport, firecrawlConfigured, firecrawlSearch } from "./gsmarenaFetchTransport.js";
import { applyGsmaToDiagnosticRows } from "./futureProperties.js";

const require = createRequire(import.meta.url);

/** Live GSMArena scrape via gsmarena-api; slow, cached server-side. */
let gsmarenaModule = null;

function loadGsmarena() {
  if (!gsmarenaModule) {
    prepareGsmarenaHttpTransport();
    gsmarenaModule = require("gsmarena-api");
  }
  return gsmarenaModule;
}

function enrichTimeoutMs(ctx) {
  if (ctx.timeoutMs != null && ctx.timeoutMs > 0) return ctx.timeoutMs;
  const env = Number(process.env.GSMR_ENRICH_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return firecrawlConfigured() ? 120_000 : 28_000;
}

/**
 * Turn dataset hardware_name slugs (e.g. galaxys24ultra) into GSMArena-friendly
 * search text. Tailored for Samsung Galaxy S–series; other slugs still help as raw fallback.
 */
export function slugToGsmarenaSearchQuery(slug) {
  if (!slug || typeof slug !== "string") return "";
  let s = slug.trim().toLowerCase();
  s = s.replace(/^galaxys(?=[0-9])/i, "galaxy s");
  s = s.replace(/([0-9])([a-z])/gi, "$1 $2");
  return s.replace(/\s+/g, " ").trim();
}

const MAX_CACHE = 50;
/** @type {Map<string, unknown>} */
const cache = new Map();

function cacheSet(key, val) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  while (cache.size > MAX_CACHE) {
    const k = cache.keys().next().value;
    cache.delete(k);
  }
}

function cacheGet(key) {
  return cache.get(key);
}

function pushUnique(arr, item) {
  const s = item?.trim();
  if (!s) return;
  if (!arr.includes(s)) arr.push(s);
}

function titleVendorLabel(slug) {
  if (!slug || typeof slug !== "string") return "";
  return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
}

/** UA / OEM strings often drop the hyphen: SMA576B → SM-A576B */
function hyphenateSamsungMarketingId(token) {
  if (!token || typeof token !== "string") return null;
  const t = token.trim();
  if (!t || /^SM-/i.test(t)) return null;
  const m = t.match(/^SM([A-Z][A-Z0-9]{2,})$/i);
  if (!m) return null;
  return `SM-${m[1].toUpperCase()}`;
}

/**
 * When HVMS matched, **`Vendor` + exact UA model** (e.g. Nothing A065) matches GSMArena better than bare `A065`.
 */
function buildAnchorQueries(deviceRow, modelDisplay) {
  const queries = [];
  if (!deviceRow?.hardware_vendor) return queries;
  const md = modelDisplay?.trim();
  if (!md || md === "N/A" || md === "Unknown") return queries;
  const v = titleVendorLabel(deviceRow.hardware_vendor);
  pushUnique(queries, `${v} ${md}`.replace(/\s+/g, " ").trim());
  return queries;
}

/** Preserve order, drop duplicates. */
function dedupeQueries(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const q of group) {
      const s = typeof q === "string" ? q.trim() : "";
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Prefer a hit whose title includes the dataset vendor (and optionally the model token), not always `list[0]`.
 */
function pickBestSearchHit(list, ctx) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const vendorSlug = ctx.deviceRow?.hardware_vendor?.trim().toLowerCase();
  const token = ctx.modelDisplay?.trim();
  const tokenOk = token && token !== "N/A" && token !== "Unknown";

  const nameHasVendor = (name) => {
    if (!vendorSlug || !name) return true;
    const n = name.toLowerCase();
    return vendorSlug.split(/\s+/).every((part) => part.length > 0 && n.includes(part));
  };

  let pool = list.filter((p) => p?.name && nameHasVendor(p.name));
  if (pool.length === 0) {
    // Dataset said e.g. "nothing" — do not fall back to Micromax for query "A065".
    if (vendorSlug) return null;
    pool = list;
  }

  if (tokenOk && pool.length > 1) {
    const hy = hyphenateSamsungMarketingId(token);
    const hints = [token.toLowerCase(), hy?.toLowerCase()].filter(Boolean);
    const withToken = pool.filter((p) => {
      const n = (p.name || "").toLowerCase();
      return hints.some((h) => n.includes(h));
    });
    if (withToken.length > 0) pool = withToken;
  }

  return pool.find((p) => p?.id) || null;
}

/**
 * GSMArena Phone Finder often has **no** quick hit for regional SKUs like `SM-A576B`,
 * but does list **`Galaxy A57`**. Derive a marketing query from compact `SMA…` codes.
 */
function samsungGalaxyASeriesQueriesFromModel(md) {
  const out = [];
  const compact = String(md).replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
  const m = compact.match(/^SMA(\d+)/i);
  if (!m) return out;
  const digits = m[1];
  if (digits.length < 2) return out;
  const seriesNum = digits.length >= 3 ? digits.slice(0, 2) : digits;
  const g = `Galaxy A${seriesNum}`;
  out.push(`Samsung ${g}`, g);
  return out;
}

/**
 * Search queries derived from the **model id** (UA / Client Hints).
 * @param {{ omitBareToken?: boolean }} [opts] — if true, do not add raw `md` last (avoids ambiguous short codes when HVMS disambiguates vendor).
 */
function buildModelSearchQueries(modelDisplay, opts = {}) {
  const queries = [];
  const md = modelDisplay?.trim();
  if (!md || md === "N/A" || md === "Unknown") return queries;

  const hyphenatedSam = hyphenateSamsungMarketingId(md);
  const vendor = inferVendorFromAndroidModelToken(md);

  if (vendor) {
    pushUnique(queries, `${vendor} ${md}`.replace(/\s+/g, " ").trim());
  }
  if (hyphenatedSam) {
    pushUnique(queries, `Samsung ${hyphenatedSam}`);
    pushUnique(queries, hyphenatedSam);
  }
  for (const gq of samsungGalaxyASeriesQueriesFromModel(md)) {
    pushUnique(queries, gq);
  }
  if (/^SM-/i.test(md)) pushUnique(queries, `Samsung ${md}`);
  if (/^pixel\b/i.test(md)) pushUnique(queries, `Google ${md}`);
  if (!opts.omitBareToken) pushUnique(queries, md);
  return queries;
}

/** Queries from **dataset** row (vendor + marketing slug) — high precision when HVMS matched. */
function buildDatasetSearchQueries(deviceRow) {
  const queries = [];
  const row = deviceRow;
  if (!row?.hardware_name) return queries;

  const spaced = slugToGsmarenaSearchQuery(row.hardware_name);
  const vLabel = row.hardware_vendor ? titleVendorLabel(row.hardware_vendor) : "";
  if (spaced) pushUnique(queries, spaced);
  if (vLabel && spaced) {
    pushUnique(queries, `${vLabel} ${spaced}`.replace(/\s+/g, " ").trim());
  }
  if (vLabel && row.hardware_name) {
    pushUnique(queries, `${vLabel} ${row.hardware_name}`.replace(/\s+/g, " ").trim());
  }
  return queries;
}

function absolutizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `https://www.gsmarena.com${u}`;
  return u;
}

/**
 * `gsmarena-api` search builds `id` from `a.href` after stripping `.php`.
 * When GSMArena uses absolute hrefs, that becomes `https://www.gsmarena.com/slug-12345`.
 * `catalog.getDevice` then requests `/${id}.php` → a broken double-host URL and empty specs.
 */
export function normalizeGsmarenaDeviceSlug(id) {
  if (!id || typeof id !== "string") return "";
  let s = id.trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const path = new URL(s).pathname || "";
      s = path.replace(/^\/+/u, "");
    } catch {
      return "";
    }
  } else {
    s = s.replace(/^\/+/u, "");
  }
  return s.replace(/\.php$/iu, "");
}

function looksLikeGsmarenaDeviceUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (!/gsmarena\.com$/i.test(u.hostname)) return false;
    const p = u.pathname.toLowerCase();
    return /\/[a-z0-9_]+-\d+\.php$/i.test(p) && !/-news-\d+\.php$/i.test(p) && !/-review-\d+\.php$/i.test(p);
  } catch {
    return false;
  }
}

function firecrawlDeviceCandidateFromResults(results, ctx) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const vendorSlug = ctx.deviceRow?.hardware_vendor?.trim().toLowerCase();
  const vendorLabel = vendorSlug ? titleVendorLabel(vendorSlug).toLowerCase() : "";
  const token = ctx.modelDisplay?.trim().toLowerCase();

  const scored = [];
  for (const item of results) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!looksLikeGsmarenaDeviceUrl(url)) continue;
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const desc = typeof item?.description === "string" ? item.description.trim() : "";
    const hay = `${title} ${desc}`.toLowerCase();
    let score = 0;
    if (vendorLabel && hay.includes(vendorLabel)) score += 3;
    if (token && hay.includes(token)) score += 6;
    if (!vendorLabel) score += 1;
    scored.push({ url, title, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function normalizeBrandName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function resolveBrandIdForVendor(ga, vendorLabel, timeoutMs) {
  const key = "catalog:brands";
  let brands = cacheGet(key);
  if (!brands) {
    brands = await withTimeout(ga.catalog.getBrands(), timeoutMs);
    cacheSet(key, brands);
  }
  if (!Array.isArray(brands)) return null;
  const want = normalizeBrandName(vendorLabel);
  if (!want) return null;
  const exact = brands.find((b) => normalizeBrandName(b?.name) === want);
  if (exact?.id) return exact.id;
  const partial = brands.find((b) => normalizeBrandName(b?.name).includes(want) || want.includes(normalizeBrandName(b?.name)));
  return partial?.id || null;
}

function targetModelKeysFromCtx(ctx) {
  const keys = [];
  const raw = ctx.modelDisplay?.trim();
  const primary = normalizeModelKey(raw || "");
  if (primary) keys.push(primary);
  const hy = hyphenateSamsungMarketingId(raw || "");
  const hyKey = normalizeModelKey(hy || "");
  if (hyKey && !keys.includes(hyKey)) keys.push(hyKey);
  return keys;
}

async function tryVendorCatalogModelScan(ga, ctx, timeoutMs) {
  const vendor =
    titleVendorLabel(ctx.deviceRow?.hardware_vendor || "") || inferVendorFromAndroidModelToken(ctx.modelDisplay || "");
  if (!vendor) return null;
  const brandId = await resolveBrandIdForVendor(ga, vendor, timeoutMs);
  if (!brandId) return null;

  const listKey = `brand:${brandId}`;
  let devices = cacheGet(listKey);
  if (!devices) {
    devices = await withTimeout(ga.catalog.getBrand(brandId), timeoutMs);
    cacheSet(listKey, devices);
  }
  if (!Array.isArray(devices) || devices.length === 0) return null;

  const targetKeys = new Set(targetModelKeysFromCtx(ctx));
  if (targetKeys.size === 0) return null;
  const scanLimitRaw = Number(process.env.GSMR_BRAND_SCAN_LIMIT);
  const scanLimit = Number.isFinite(scanLimitRaw) && scanLimitRaw > 0 ? Math.min(Math.trunc(scanLimitRaw), 50) : 24;

  for (const device of devices.slice(0, scanLimit)) {
    const deviceSlug = normalizeGsmarenaDeviceSlug(device?.id);
    if (!deviceSlug) continue;
    const detail = await fetchDeviceDetail(ga, deviceSlug, timeoutMs);
    const codes = extractInternalModelCodesFromDetailSpec(detail?.detailSpec).map((c) => normalizeModelKey(c));
    if (codes.some((c) => targetKeys.has(c))) {
      return buildGsmaResultFromDetail({
        detail,
        deviceSlug,
        searchQueryUsed: ctx.modelDisplay?.trim() || "",
        queryPhase: "model",
        listName: device?.name || null,
      });
    }
  }
  return null;
}

function extractLaunchSignals(detailSpec) {
  let announcedYear = null;
  let launchOs = null;
  if (!Array.isArray(detailSpec)) return { announcedYear, launchOs };
  for (const block of detailSpec) {
    if (!block?.category || !/launch/i.test(String(block.category))) continue;
    const specs = Array.isArray(block.specifications) ? block.specifications : [];
    for (const spec of specs) {
      const name = String(spec?.name || "").trim();
      const value = spec?.value ? String(spec.value).trim() : "";
      if (!value) continue;
      if (/^announced$/i.test(name)) {
        const y = value.match(/(\d{4})/);
        if (y) announcedYear = Number(y[1]);
      }
      if (/^os$/i.test(name)) {
        launchOs = value;
      }
    }
  }
  return { announcedYear, launchOs };
}

function extractRamGbFromQuickSpec(quickSpec) {
  const raw = quickSpecValue(quickSpec, /^RAM$/i);
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Chipset / CPU / GPU from Platform spec (and quick-spec fallback). */
function extractPlatformChipsetCpuGpu(detailSpec, quickSpec) {
  let chipset = quickSpecValue(quickSpec, /^chipset$/i);
  let cpu = quickSpecValue(quickSpec, /^cpu$/i);
  let gpu = quickSpecValue(quickSpec, /^gpu$/i);

  if (!Array.isArray(detailSpec)) return { chipset, cpu, gpu };
  for (const block of detailSpec) {
    if (!block?.category || !/platform/i.test(String(block.category))) continue;
    const specs = Array.isArray(block.specifications) ? block.specifications : [];
    for (const spec of specs) {
      const name = String(spec?.name || "").trim();
      const value = spec?.value ? String(spec.value).trim() : "";
      if (!value) continue;
      if (/^chipset$/i.test(name)) chipset = value;
      if (/^cpu$/i.test(name)) cpu = value;
      if (/^gpu$/i.test(name)) gpu = value;
    }
  }
  return { chipset, cpu, gpu };
}

function buildGsmaResultFromDetail({ detail, deviceSlug, searchQueryUsed, queryPhase, listName = null }) {
  const img = absolutizeUrl(detail?.img);
  const networkTechnology = extractNetworkTechnology(detail?.detailSpec);
  const displayMetrics = extractDisplayMetrics(detail?.detailSpec, detail?.quickSpec);
  const launch = extractLaunchSignals(detail?.detailSpec);
  const gsmarenaRamGb = extractRamGbFromQuickSpec(detail?.quickSpec);
  const platformSoc = extractPlatformChipsetCpuGpu(detail?.detailSpec, detail?.quickSpec);
  const fromSpec = extractInternalModelCodesFromDetailSpec(detail?.detailSpec);
  const internalModelCodes = [];
  const seenCodes = new Set();
  for (const c of fromSpec) {
    const k = normalizeModelKey(c);
    if (!k || seenCodes.has(k)) continue;
    seenCodes.add(k);
    internalModelCodes.push(k);
  }

  return {
    ok: true,
    searchQueryUsed,
    queryPhase,
    deviceId: `https://www.gsmarena.com/${deviceSlug}.php`,
    listName,
    name: detail?.name || listName,
    img,
    quickSpec: (detail?.quickSpec || []).filter((x) => x && String(x.value || "").trim()),
    networkTechnology,
    screenInchesDiagonal: displayMetrics.screenInchesDiagonal,
    screenPixelsWidth: displayMetrics.screenPixelsWidth,
    screenPixelsHeight: displayMetrics.screenPixelsHeight,
    internalModelCodes,
    gsmarenaAnnouncedYear: launch.announcedYear,
    gsmarenaLaunchOs: launch.launchOs,
    gsmarenaRamGb,
    gsmarenaChipset: platformSoc.chipset,
    gsmarenaCpu: platformSoc.cpu,
    gsmarenaGpu: platformSoc.gpu,
  };
}

async function fetchDeviceDetail(ga, deviceSlug, timeoutMs) {
  const dKey = `device:${deviceSlug}`;
  let detail = cacheGet(dKey);
  if (!detail) {
    detail = await withTimeout(ga.catalog.getDevice(deviceSlug), timeoutMs);
    cacheSet(dKey, detail);
  }
  return detail;
}

function extractNetworkTechnology(detailSpec) {
  if (!Array.isArray(detailSpec)) return null;
  for (const block of detailSpec) {
    if (!block?.category) continue;
    if (!/network/i.test(block.category)) continue;
    const specs = block.specifications;
    if (!Array.isArray(specs)) continue;
    for (const s of specs) {
      if (!s?.name) continue;
      if (/technology|tech\b/i.test(s.name) && s.value) return String(s.value).trim();
    }
  }
  return null;
}

function quickSpecValue(quickSpec, labelRe) {
  if (!Array.isArray(quickSpec)) return null;
  const hit = quickSpec.find((x) => x?.name && labelRe.test(String(x.name)));
  const val = hit?.value;
  return val ? String(val).trim() : null;
}

function extractDisplayMetrics(detailSpec, quickSpec) {
  let displaySize = quickSpecValue(quickSpec, /^display size$/i);
  let displayResolution = quickSpecValue(quickSpec, /^display resolution$/i);

  if (Array.isArray(detailSpec)) {
    for (const block of detailSpec) {
      if (!block?.category || !/display/i.test(block.category)) continue;
      const specs = Array.isArray(block.specifications) ? block.specifications : [];
      for (const spec of specs) {
        const name = String(spec?.name || "");
        const value = spec?.value ? String(spec.value).trim() : "";
        if (!value) continue;
        if (!displaySize && /^size$/i.test(name)) displaySize = value;
        if (!displayResolution && /^resolution$/i.test(name)) displayResolution = value;
      }
    }
  }

  const out = {
    screenInchesDiagonal: null,
    screenPixelsWidth: null,
    screenPixelsHeight: null,
  };

  if (displaySize) {
    const m = displaySize.match(/(\d+(?:\.\d+)?)/);
    if (m) out.screenInchesDiagonal = m[1];
  }
  if (displayResolution) {
    const m = displayResolution.match(/(\d{3,5})\s*x\s*(\d{3,5})/i);
    if (m) {
      out.screenPixelsWidth = m[1];
      out.screenPixelsHeight = m[2];
    }
  }
  return out;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("gsmarena_timeout")), ms)),
  ]);
}

/** Best-effort OEM line from GSMArena product title. */
export function vendorFromGsmarenaTitle(name) {
  if (!name || typeof name !== "string") return null;
  const n = name.toLowerCase();
  if (/\bsamsung\b/.test(n)) return "Samsung";
  if (/\bgoogle\b|\bpixel\b/.test(n)) return "Google";
  if (/\bapple\b|\biphone\b|\bipad\b/.test(n)) return "Apple";
  if (/\bxiaomi\b|\bredmi\b|\bpoco\b/.test(n)) return "Xiaomi";
  if (/\boneplus\b/.test(n)) return "OnePlus";
  if (/\boppo\b/.test(n)) return "Oppo";
  if (/\bvivo\b/.test(n)) return "Vivo";
  if (/\brealme\b/.test(n)) return "Realme";
  if (/\bmotorola\b|\bmoto\b/.test(n)) return "Motorola";
  if (/\bhuawei\b/.test(n)) return "Huawei";
  if (/\bhonor\b/.test(n)) return "Honor";
  if (/\bsony\b/.test(n)) return "Sony";
  if (/\blg\b/.test(n)) return "LG";
  if (/\bnokia\b/.test(n)) return "HMD Global";
  if (/\bnothing\b/.test(n)) return "Nothing";
  return null;
}

const VENDOR_PREFIX_FOR_FAMILY =
  /^(Samsung|Google|Apple|Xiaomi|OnePlus|OPPO|Oppo|Vivo|Realme|Motorola|Huawei|Honor|Sony|LG|Nokia|Asus|Nothing|HMD\s+Global)\s+/i;

function familyFromGsmarenaDeviceName(name) {
  if (!name || typeof name !== "string") return null;
  const n = name.replace(VENDOR_PREFIX_FOR_FAMILY, "").trim();
  return n.length > 0 ? n : name.trim();
}

/**
 * Optional live lookup via nordmarin/gsmarena-api (scrapes gsmarena.com).
 * **Order:** With HVMS match: **`Vendor` + UA model** (e.g. Nothing A065), then slug queries, then bare model.
 * Result choice prefers titles that **match dataset vendor** (and model token) instead of always `list[0]`.
 * On success, caller applies GSMArena as primary hardware identity; on failure, keep dataset/heuristics.
 *
 * @param {{
 *   deviceRow: { hardware_vendor?: string, hardware_name?: string } | null,
 *   modelDisplay: string | undefined,
 *   enabled: boolean,
 *   timeoutMs?: number,
 * }} ctx
 */
export async function tryGsmarenaEnrich(ctx) {
  if (!ctx.enabled) return null;

  const datasetQueries = buildDatasetSearchQueries(ctx.deviceRow);
  const anchorQueries = buildAnchorQueries(ctx.deviceRow, ctx.modelDisplay);
  const datasetFirst = Boolean(ctx.deviceRow?.hardware_name && datasetQueries.length > 0);
  const omitBare = datasetFirst && Boolean(ctx.deviceRow?.hardware_vendor);
  const modelQueries = buildModelSearchQueries(ctx.modelDisplay, { omitBareToken: omitBare });
  const queries = datasetFirst
    ? dedupeQueries(anchorQueries, datasetQueries, modelQueries)
    : dedupeQueries(modelQueries, anchorQueries, datasetQueries);

  if (queries.length === 0) return { ok: false, error: "no_search_query" };

  const ga = loadGsmarena();
  const timeoutMs = enrichTimeoutMs(ctx);
  const anchorAndDataset = new Set([...anchorQueries, ...datasetQueries]);
  /** @type {{ query: string, reason: string }[]} */
  const attemptLog = [];

  for (const q of queries) {
    const sKey = `search:${q}`;
    try {
      let list = cacheGet(sKey);
      if (!list) {
        list = await withTimeout(ga.search.search(q), timeoutMs);
        cacheSet(sKey, list);
      }
      if (!Array.isArray(list) || list.length === 0) {
        attemptLog.push({
          query: q,
          reason:
            "GSMArena quick search returned no phone rows for this string (HTML had 0 .makers hits — often the SKU is not in Phone Finder; a marketing name like Galaxy A57 may work).",
        });
        continue;
      }

      const pick = pickBestSearchHit(list, ctx);
      if (!pick?.id) {
        attemptLog.push({ query: q, reason: "results present but no device passed vendor/token filters" });
        continue;
      }

      const deviceSlug = normalizeGsmarenaDeviceSlug(pick.id);
      if (!deviceSlug) {
        attemptLog.push({ query: q, reason: "search hit had no usable device slug (check href shape)" });
        continue;
      }

      const detail = await fetchDeviceDetail(ga, deviceSlug, timeoutMs);
      const queryPhase = anchorAndDataset.has(q) ? "dataset" : "model";
      return buildGsmaResultFromDetail({
        detail,
        deviceSlug,
        searchQueryUsed: q,
        queryPhase,
        listName: pick.name,
      });
    } catch (err) {
      attemptLog.push({ query: q, reason: String(err?.message || err) });
    }
  }

  if (firecrawlConfigured()) {
    for (const q of queries) {
      const searchQuery = `site:gsmarena.com ${q}`;
      const sKey = `firecrawl-search:${searchQuery}`;
      try {
        let results = cacheGet(sKey);
        if (!results) {
          results = await withTimeout(firecrawlSearch(searchQuery, { limit: 5 }), timeoutMs);
          cacheSet(sKey, results);
        }
        const candidate = firecrawlDeviceCandidateFromResults(results, ctx);
        if (!candidate?.url) {
          attemptLog.push({
            query: q,
            reason: "Firecrawl site search found no probable GSMArena device page for this model code.",
          });
          continue;
        }
        const deviceSlug = normalizeGsmarenaDeviceSlug(candidate.url);
        if (!deviceSlug) {
          attemptLog.push({ query: q, reason: "Firecrawl site search returned an unusable device URL." });
          continue;
        }
        const detail = await fetchDeviceDetail(ga, deviceSlug, timeoutMs);
        const queryPhase = anchorAndDataset.has(q) ? "dataset" : "model";
        return buildGsmaResultFromDetail({
          detail,
          deviceSlug,
          searchQueryUsed: q,
          queryPhase,
          listName: candidate.title || null,
        });
      } catch (err) {
        attemptLog.push({ query: q, reason: `Firecrawl site search failed: ${String(err?.message || err)}` });
      }
    }
  }

  try {
    const scanned = await tryVendorCatalogModelScan(ga, ctx, timeoutMs);
    if (scanned) return scanned;
    attemptLog.push({
      query: ctx.modelDisplay?.trim() || "",
      reason: "Vendor catalog scan checked recent GSMArena device pages but did not find this model code in their Models section.",
    });
  } catch (err) {
    attemptLog.push({
      query: ctx.modelDisplay?.trim() || "",
      reason: `Vendor catalog scan failed: ${String(err?.message || err)}`,
    });
  }

  return {
    ok: false,
    error: "no_match_or_fetch_failed",
    attemptLog: attemptLog.slice(0, 8),
    fetchViaFirecrawl: firecrawlConfigured(),
    enrichTimeoutMs: timeoutMs,
  };
}

function clampGsmarenaText(val, maxLen = 900) {
  if (val == null || typeof val !== "string") return null;
  const t = val.trim();
  if (!t) return null;
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/**
 * When GSMArena succeeds, **replace** marketing hardware fields (dataset/heuristics are baseline if lookup failed).
 * HardwareModel stays the parsed model id from UA/hints; variants list stays from dataset when present.
 */
export function applyGsmarenaToResult(result, g) {
  if (!g?.ok || !result?.properties) return;

  const v = vendorFromGsmarenaTitle(g.name);

  for (const row of result.properties) {
    if (row.property === "HardwareName" && g.name) {
      row.value = g.name;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "HardwareFamily") {
      const fam = familyFromGsmarenaDeviceName(g.name);
      if (fam) {
        row.value = fam;
        row.source = "gsmarena";
        row.confidence = "low";
      }
    }
    if (row.property === "HardwareVendor" && v) {
      row.value = v;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "OEM" && v) {
      row.value = v;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "HardwareChipset") {
      const t = clampGsmarenaText(g.gsmarenaChipset);
      if (t) {
        row.value = t;
        row.source = "gsmarena";
        row.confidence = "low";
      }
    }
    if (row.property === "CPU") {
      const t = clampGsmarenaText(g.gsmarenaCpu);
      if (t) {
        row.value = t;
        row.source = "gsmarena";
        row.confidence = "low";
      }
    }
    if (row.property === "GPU") {
      const t = clampGsmarenaText(g.gsmarenaGpu);
      if (t) {
        row.value = t;
        row.source = "gsmarena";
        row.confidence = "low";
      }
    }
    if (row.property === "SupportedBearers" && g.networkTechnology) {
      const net = g.networkTechnology;
      row.value = net.length > 512 ? `${net.slice(0, 509)}…` : net;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "ScreenInchesDiagonal" && g.screenInchesDiagonal) {
      row.value = g.screenInchesDiagonal;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "ScreenPixelsWidth" && g.screenPixelsWidth) {
      row.value = g.screenPixelsWidth;
      row.source = "gsmarena";
      row.confidence = "low";
    }
    if (row.property === "ScreenPixelsHeight" && g.screenPixelsHeight) {
      row.value = g.screenPixelsHeight;
      row.source = "gsmarena";
      row.confidence = "low";
    }
  }

  if (result.debug) {
    result.debug.hardwareIdentitySource = "gsmarena";
    result.debug.gsmarenaQueryPhase = g.queryPhase ?? null;
  }

  applyGsmaToDiagnosticRows(result.properties, g, { precomputedVendor: v });
}
