import { normalizeModelKey } from "./deviceIndex.js";

/**
 * `SM-A376B/DS` before normalize; `sma376b/ds` after (Client Hints often pre-normalized or we strip hyphens only).
 */
function samsungNormalizedSlashExpand(leftNorm, rightRaw) {
  const r = String(rightRaw).replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{1,5}$/.test(r)) return null;
  const m = String(leftNorm).match(/^sm([a-z])(\d+)([a-z0-9]*)$/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const digits = m[2];
  const tail = m[3] || "";
  return [`SM-${letter}${digits}${tail}`, `SM-${letter}${digits}${r}`];
}

/**
 * Samsung regional SKUs: `SM-A376B/DS` → datasheet rows `sma376b` and `sma376ds`
 * (dual-letter form is SM-A376 + suffix, i.e. drop trailing variant letter before /…).
 * `SM-A376B/SM-A376U` → two full models.
 *
 * @param {unknown} input — raw token from UA or GSMArena (may include hyphens, slashes)
 * @returns {string[]} distinct normalized HVMS `model` keys
 */
export function expandToHvmsModelKeys(input) {
  if (input == null) return [];
  let s = String(input).trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
  if (!s) return [];

  const slashIdx = s.indexOf("/");
  if (slashIdx !== -1) {
    const left = s.slice(0, slashIdx).trim();
    const right = s.slice(slashIdx + 1).trim();
    if (/^SM-/i.test(left) && /^SM-/i.test(right)) {
      return uniqNormFiltered([left, right]);
    }
    if (/^SM-/i.test(left) && /^[A-Za-z0-9]{1,6}$/.test(right)) {
      const second = samsungSlashSecondarySku(left, right);
      if (second) return uniqNormFiltered([left, second]);
    }
    const fromNormalized = samsungNormalizedSlashExpand(left, right);
    if (fromNormalized) return uniqNormFiltered(fromNormalized);
    return uniqNormFiltered([left, right]);
  }

  const k = normalizeModelKey(s);
  return k ? uniqNormFiltered([k]) : [];
}

/** SM-A376B + DS (suffix) → SM-A376DS */
function samsungSlashSecondarySku(left, right) {
  const r = right.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{1,5}$/.test(r)) return null;
  const m = left.trim().match(/^SM-([A-Z])(\d+)([A-Z0-9]*)$/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const digits = m[2];
  return `SM-${letter}${digits}${r}`;
}

function uniqNormFiltered(rawList) {
  const seen = new Set();
  const out = [];
  for (const x of rawList) {
    const k = normalizeModelKey(typeof x === "string" ? x : String(x));
    if (!k || k.length < 3 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Spec row titles on GSMArena that list internal / regional SKU codenames. */
const MODEL_FIELD_NAMES = [
  /^models?$/i,
  /^model\s*names?$/i,
  /^model\s*number(s)?$/i,
  /^device\s*models?$/i,
  /^(phone\s*)?models?$/i,
];

function specNameListsInternalModels(name) {
  const n = (name || "").trim();
  if (!n) return false;
  return MODEL_FIELD_NAMES.some((re) => re.test(n));
}

/** Do not split on `/` — needed so `SM-A376B/DS` stays one token and expands to two SKUs. */
const SPLIT_RE = /\s*(?:,|;|\||\n|\r\n)(?:\s*)|(?:\s+or\s+)|(?:\s+and\s+)/i;

function splitListValue(value) {
  if (!value || typeof value !== "string") return [];
  return value
    .split(SPLIT_RE)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/g, "").trim())
    .filter(Boolean);
}

const JUNK_TOKENS = new Set(
  [
    "global",
    "international",
    "worldwide",
    "europe",
    "usa",
    "china",
    "india",
    "japan",
    "korea",
    "dual",
    "sim",
    "single",
    "nano",
    "esim",
    "only",
    "none",
    "tbd",
  ].map((s) => s.toLowerCase()),
);

/**
 * Pull codename-like tokens from GSMArena `detailSpec` (e.g. Honor X6d → NALA-N32, LNA-NX1).
 * Values are normalized like HVMS `model` (lowercase, no hyphen).
 *
 * @param {unknown} detailSpec — gsmarena-api getDevice().detailSpec
 * @returns {string[]} distinct normalized keys
 */
export function extractInternalModelCodesFromDetailSpec(detailSpec) {
  const out = [];
  if (!Array.isArray(detailSpec)) return out;
  for (const block of detailSpec) {
    const specs = block?.specifications;
    if (!Array.isArray(specs)) continue;
    for (const s of specs) {
      if (!specNameListsInternalModels(s?.name)) continue;
      const raw = String(s.value || "").trim();
      if (!raw) continue;
      for (const chunk of splitListValue(raw)) {
        let piece = chunk.replace(/\s*[\[(].*$/s, "").trim();
        if (!piece) continue;
        for (const key of expandToHvmsModelKeys(piece.replace(/\s*\/\s*/g, "/"))) {
          if (!key || key.length < 3 || key.length > 64) continue;
          if (JUNK_TOKENS.has(key)) continue;
          if (/^\d+$/.test(key)) continue;
          if (key.length <= 2 && /\d/.test(key)) continue;
          if (!out.includes(key)) out.push(key);
        }
      }
    }
  }
  return out;
}

/**
 * Primary UA key + GSMArena codes; each raw value may expand (e.g. Samsung `SM-A376B/DS`).
 *
 * @param {unknown} primaryKey
 * @param {string[] | undefined} internalCodes — already normalized from extract; safe to expand again
 * @returns {string[]}
 */
export function mergeExpandedModelKeysForLearning(primaryKey, internalCodes) {
  const out = [];
  const seen = new Set();
  const list = [primaryKey, ...(Array.isArray(internalCodes) ? internalCodes : [])];
  for (const x of list) {
    if (x == null || String(x).trim() === "") continue;
    for (const k of expandToHvmsModelKeys(x)) {
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
