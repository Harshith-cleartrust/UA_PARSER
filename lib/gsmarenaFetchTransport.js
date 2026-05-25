/**
 * HTTP layer for gsmarena-api: Firecrawl when FIRECRAWL_API_KEY is set (bypasses your blocked IP),
 * otherwise direct GET. GSMArena search URLs always get `sName` encoding.
 *
 * GSMArena often blocks simple/datacenter fetches. Mitigations (env):
 * - FIRECRAWL_PROXY=enhanced | auto | basic (default: enhanced for harder sites)
 * - FIRECRAWL_MAX_AGE_MS=0 — skip cache (avoid stale “blocked” HTML)
 * - FIRECRAWL_WAIT_MS — extra ms before capture (default 2500)
 *
 * @see https://docs.firecrawl.dev/features/scrape
 * @see https://docs.firecrawl.dev/features/enhanced-mode
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const axios = require("axios");

const RESULTS_PREFIX = "/results.php3?sQuickSearch=yes&sName=";

let prepared = false;

export function firecrawlConfigured() {
  const k = process.env.FIRECRAWL_API_KEY;
  return Boolean(k && String(k).trim());
}

/**
 * Use Firecrawl web search to resolve a GSMArena device URL when GSMArena's own quick search
 * can't find a page by raw model code (e.g. RMX5366 indexed only inside a device page body).
 *
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ url?: string, title?: string, description?: string }>>}
 */
export async function firecrawlSearch(query, opts = {}) {
  const apiKey = (process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) return [];

  const searchUrl = (process.env.FIRECRAWL_SEARCH_API_URL || "").trim() || "https://api.firecrawl.dev/v2/search";
  const limitRaw = Number(opts.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 10) : 5;
  const timeoutMs =
    Number(process.env.FIRECRAWL_TIMEOUT_MS) > 0 ? Number(process.env.FIRECRAWL_TIMEOUT_MS) : 120_000;

  const res = await axios.post(
    searchUrl,
    {
      query,
      limit,
      includeDomains: ["www.gsmarena.com", "gsmarena.com"],
      sources: [{ type: "web" }],
    },
    {
      timeout: timeoutMs,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    },
  );

  if (res.status < 200 || res.status >= 300) {
    const errSnip = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`Firecrawl search HTTP ${res.status}: ${errSnip?.slice(0, 400) || ""}`);
  }

  const resBody = res.data;
  if (!resBody?.success) {
    const msg =
      typeof resBody?.error === "string"
        ? resBody.error
        : resBody?.message || JSON.stringify(resBody)?.slice(0, 400) || "unknown";
    throw new Error(`Firecrawl search: ${msg}`);
  }

  return Array.isArray(resBody.data?.web) ? resBody.data.web : [];
}

function fixGsmarenaSearchPath(urlPath) {
  const s = String(urlPath);
  if (!s.startsWith(RESULTS_PREFIX)) return urlPath;
  return RESULTS_PREFIX + encodeURIComponent(s.slice(RESULTS_PREFIX.length));
}

/** Roughly detect challenge / block HTML so we don’t silently return empty search results. */
function assertLikelyRealGsmarkenaHtml(html) {
  if (typeof html !== "string" || html.length < 200) {
    throw new Error("Firecrawl returned very short HTML — likely error or empty body");
  }
  const head = html.slice(0, 12000).toLowerCase();
  const signals = [
    "verify you are a human",
    "verify you are human",
    "just a moment",
    "attention required",
    "access denied",
    "cf-browser-verification",
    "cf-challenge",
    "challenge-platform",
    "checking your browser",
    "enable javascript",
    "incapsula incident",
    "request blocked",
    "too many requests",
  ];
  for (const sig of signals) {
    if (head.includes(sig)) {
      throw new Error(
        `GSMArena returned a block/challenge page (matched “${sig.slice(0, 40)}…”). ` +
          `Try FIRECRAWL_PROXY=enhanced, FIRECRAWL_MAX_AGE_MS=0 (fresh fetch), or increase FIRECRAWL_WAIT_MS.`,
      );
    }
  }
}

export function prepareGsmarenaHttpTransport() {
  if (prepared) return;
  prepared = true;

  const apiKey = (process.env.FIRECRAWL_API_KEY || "").trim();
  const scrapeUrl = (process.env.FIRECRAWL_API_URL || "").trim() || "https://api.firecrawl.dev/v2/scrape";

  const pkgRoot = path.dirname(require.resolve("gsmarena-api/package.json"));
  const utils = require(path.join(pkgRoot, "src", "services", "utils.js"));
  const directTimeout =
    Number(process.env.GSMR_HTTP_TIMEOUT_MS) > 0 ? Number(process.env.GSMR_HTTP_TIMEOUT_MS) : 30_000;

  const defaultUa =
    process.env.FIRECRAWL_HEADER_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  utils.getDataFromUrl = async (urlPath) => {
    const pathFixed = fixGsmarenaSearchPath(urlPath);
    const targetUrl = `https://www.gsmarena.com${pathFixed}`;

    if (apiKey) {
      const fireTimeout =
        Number(process.env.FIRECRAWL_TIMEOUT_MS) > 0 ? Number(process.env.FIRECRAWL_TIMEOUT_MS) : 120_000;

      const proxyRaw = (process.env.FIRECRAWL_PROXY || "auto").trim().toLowerCase();
      const proxy = ["basic", "auto", "enhanced"].includes(proxyRaw) ? proxyRaw : "enhanced";

      const waitFor = Number(process.env.FIRECRAWL_WAIT_MS);
      const waitMs = Number.isFinite(waitFor) && waitFor >= 0 ? waitFor : 2500;

      const body = {
        url: targetUrl,
        formats: ["rawHtml", "html"],
        onlyMainContent: false,
        proxy,
        location: { country: (process.env.FIRECRAWL_LOCATION_COUNTRY || "US").trim(), languages: ["en"] },
        waitFor: waitMs,
        headers: {
          "User-Agent": defaultUa,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      };

      const maxAgeEnv = process.env.FIRECRAWL_MAX_AGE_MS;
      if (maxAgeEnv !== undefined && String(maxAgeEnv).trim() !== "") {
        const n = Number(maxAgeEnv);
        if (Number.isFinite(n)) body.maxAge = n;
      }

      const res = await axios.post(scrapeUrl, body, {
        timeout: fireTimeout,
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      });

      if (res.status < 200 || res.status >= 300) {
        const errSnip = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
        throw new Error(`Firecrawl HTTP ${res.status}: ${errSnip?.slice(0, 400) || ""}`);
      }

      const resBody = res.data;
      if (!resBody?.success) {
        const msg =
          typeof resBody?.error === "string"
            ? resBody.error
            : resBody?.message || JSON.stringify(resBody)?.slice(0, 400) || "unknown";
        throw new Error(`Firecrawl: ${msg}`);
      }

      const html =
        (typeof resBody.data?.rawHtml === "string" && resBody.data.rawHtml.length > 0
          ? resBody.data.rawHtml
          : null) ||
        (typeof resBody.data?.html === "string" && resBody.data.html.length > 0 ? resBody.data.html : null);

      if (!html) {
        throw new Error("Firecrawl returned empty HTML (no rawHtml/html in response)");
      }

      assertLikelyRealGsmarkenaHtml(html);
      return html;
    }

    const html = await axios({
      method: "get",
      url: targetUrl,
      timeout: directTimeout,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
    });
    return html.data;
  };
}
