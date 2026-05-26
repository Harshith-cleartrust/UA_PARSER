const uaEl = document.getElementById("ua");
const hintModel = document.getElementById("hintModel");
const hintMobile = document.getElementById("hintMobile");
const hintPlat = document.getElementById("hintPlat");
const hintPlatVer = document.getElementById("hintPlatVer");
const tblBody = document.querySelector("#tbl tbody");
const errEl = document.getElementById("err");
const chStatus = document.getElementById("chStatus");
const httpsBanner = document.getElementById("httpsBanner");
const resultNote = document.getElementById("resultNote");
const tableEmptyState = document.getElementById("tableEmptyState");
let activeRunToken = 0;
let currentViewData = null;
let currentViewRoundTripMs = null;
const PENDING_HARDWARE_PROPERTIES = new Set([
  "HardwareFamily",
  "HardwareModel",
  "HardwareName",
  "HardwareNameVersion",
  "HardwareVendor",
  "OEM",
  "HardwareChipset",
  "CPU",
  "GPU",
  "ScreenInchesDiagonal",
  "ScreenPixelsWidth",
  "ScreenPixelsHeight",
  "SupportedBearers",
]);

const PENDING_DIAGNOSTIC_GSMA_PROPERTIES = new Set(["Device Model", "Manufacturer", "Approx Device Age"]);

function stripInvisible(s) {
  return String(s).replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function readClientHintsFromFields() {
  const map = [
    ["secChUaModel", "hintModel"],
    ["secChUaMobile", "hintMobile"],
    ["secChUaPlatform", "hintPlat"],
    ["secChUaPlatformVersion", "hintPlatVer"],
  ];
  const out = {};
  for (const [key, id] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    let v = stripInvisible(el.value).trim();
    if (!v) continue;
    if (key === "secChUaModel") {
      v = v.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    }
    out[key] = v;
  }
  return out;
}

document.getElementById("run").addEventListener("click", run);
document.getElementById("useDevice").addEventListener("click", () => {
  void useThisDevice();
});

function clearClientHintFields() {
  for (const el of [hintModel, hintMobile, hintPlat, hintPlatVer]) {
    el.value = "";
    el.removeAttribute("data-source");
  }
}

function isChromeReducedAndroidUa(ua) {
  return /\bAndroid\s+[\d.]+;\s*K\b/i.test(ua || "") || /\bAndroid\s+[\d.]+;\s*K\s*\)/i.test(ua || "");
}

function setHintField(el, value, source) {
  if (!el) return;
  if (value != null && String(value).trim() !== "") {
    el.value = value;
    if (source) el.dataset.source = source;
    else el.removeAttribute("data-source");
  } else {
    el.value = "";
    el.removeAttribute("data-source");
  }
}

/** Only real browser data: HTTP Sec-CH-UA-* headers and navigator.userAgentData (never UA string guessing). */
function mergeRealClientHints(http, js) {
  return { ...js, ...http };
}

function applyRealClientHintsToFields(ch) {
  if (!ch || typeof ch !== "object") return;
  setHintField(hintModel, ch.secChUaModel, ch._srcModel);
  setHintField(hintMobile, ch.secChUaMobile, ch._srcMobile);
  setHintField(hintPlat, ch.secChUaPlatform, ch._srcPlat);
  setHintField(hintPlatVer, ch.secChUaPlatformVersion, ch._srcPlatVer);
}

function tagHintSources(ch, http, js) {
  const out = { ...ch };
  const from = (key, httpKey, jsKey) => {
    if (http[httpKey]) return "http";
    if (js[jsKey]) return "js";
    return "";
  };
  out._srcModel = from("model", "secChUaModel", "secChUaModel");
  out._srcMobile = from("mobile", "secChUaMobile", "secChUaMobile");
  out._srcPlat = from("plat", "secChUaPlatform", "secChUaPlatform");
  out._srcPlatVer = from("ver", "secChUaPlatformVersion", "secChUaPlatformVersion");
  return out;
}

/** Fresh Client Hints from navigator.userAgentData only. */
async function collectClientHintsFromNavigator() {
  const out = {};
  const d = navigator.userAgentData;
  if (!d) return out;
  if (d.mobile != null) out.secChUaMobile = d.mobile ? "?1" : "?0";
  if (d.platform) out.secChUaPlatform = `"${d.platform}"`;
  try {
    if (typeof d.getHighEntropyValues === "function") {
      const h = await d.getHighEntropyValues(["model", "platformVersion"]);
      const model = typeof h.model === "string" ? h.model.trim() : "";
      if (model.length > 0 && !/^k$/i.test(model)) out.secChUaModel = `"${model}"`;
      if (typeof h.platformVersion === "string" && h.platformVersion.length > 0) {
        out.secChUaPlatformVersion = `"${h.platformVersion}"`;
      }
    }
  } catch {
    /* blocked */
  }
  return out;
}

async function fetchClientHintsFromHttpProbe() {
  try {
    const res = await fetch("/api/ch-probe", { credentials: "same-origin" });
    if (!res.ok) return {};
    const data = await res.json();
    return data?.clientHintsFromHeaders && typeof data.clientHintsFromHeaders === "object"
      ? data.clientHintsFromHeaders
      : {};
  } catch {
    return {};
  }
}

function updateHttpsBanner() {
  if (!httpsBanner) return;
  if (window.isSecureContext) {
    httpsBanner.hidden = true;
    return;
  }
  const host = location.hostname;
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const httpsPort = port === "80" ? "3000" : port;
  httpsBanner.hidden = false;
  httpsBanner.innerHTML = [
    "<strong>Real device model needs HTTPS.</strong>",
    ` On your phone you are on <code>${location.protocol}//${host}</code> (not secure).`,
    ` On the Mac run <code>npm run start:https</code>, then open`,
    ` <code>https://${host}:${httpsPort}</code>, accept the certificate warning, and tap Detect again.`,
  ].join("");
}

function updateChStatus(data) {
  if (!chStatus) return;
  const lines = [];
  const ua = uaEl.value || "";
  const modelKey = data?.debug?.modelKey;
  const modelSource = data?.debug?.modelSource;

  lines.push(
    "Detect uses only what you typed in the fields below, plus Sec-CH-UA-* headers the browser adds to this request. Use this device fills these fields from this browser (and clears them first).",
  );

  if (data?.debug) {
    const raw = data.debug.clientHintsFromJs;
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
      lines.push(`Server received clientHints in JSON body: ${JSON.stringify(raw)}`);
    } else {
      lines.push(
        "Server received no keys inside JSON clientHints (empty object). Only HTTP headers were used for hints. Expand “Client hints”, type the model again, hard-refresh the page, and restart the Node server if this persists.",
      );
    }
  }

  if (isChromeReducedAndroidUa(ua)) {
    lines.push("Chrome hid the model in the UA (… K …). You need HTTPS + Sec-CH-UA-Model for your exact device id.");
  }

  if (data?.debug?.secChUaModelFromHeader) {
    lines.push("Model for lookup: Sec-CH-UA-Model HTTP header from this device.");
  } else if (data?.debug?.secChUaModelFromJs) {
    lines.push("Model for lookup: from the JSON request body (typed in the form or filled by Use this device).");
  } else if (modelSource === "client_hint" && data?.debug?.modelRaw) {
    lines.push(`Model for lookup: Client Hints / body (${data.debug.modelRaw}).`);
  } else if (modelSource === "user_agent" && data?.debug?.modelRaw) {
    lines.push(`Model for lookup: parsed from UA text (${data.debug.modelRaw}).`);
  } else {
    lines.push("No model id yet — hardware cache cannot match this device.");
  }

  if (modelKey) lines.push(`Lookup key: ${modelKey}.`);

  if (data?.debug?.clientHintsUsed) {
    const u = data.debug.clientHintsUsed;
    const parts = [];
    if (u.secChUaModel) {
      const inner = String(u.secChUaModel).replace(/^["']|["']$/g, "").trim();
      if (inner.length) parts.push(`model=${u.secChUaModel}`);
    }
    if (u.secChUaMobile) parts.push(`mobile=${u.secChUaMobile}`);
    if (u.secChUaPlatform) parts.push(`platform=${u.secChUaPlatform}`);
    if (u.secChUaPlatformVersion) parts.push(`platformVersion=${u.secChUaPlatformVersion}`);
    if (parts.length) {
      lines.push(`Merged hints used for this parse: ${parts.join(", ")}. The form above is not overwritten after Detect.`);
    }
  }

  if (!navigator.userAgentData) {
    lines.push("No navigator.userAgentData — use Chrome on Android.");
  }

  if (!window.isSecureContext) {
    lines.push("Not a secure page — Chrome blocks high-entropy hints (model) on http://LAN.");
  }

  chStatus.hidden = false;
  chStatus.textContent = lines.join(" ");
}

async function useThisDevice() {
  uaEl.value = navigator.userAgent || "";
  clearClientHintFields();
  const [js, http] = await Promise.all([collectClientHintsFromNavigator(), fetchClientHintsFromHttpProbe()]);
  applyRealClientHintsToFields(tagHintSources(mergeRealClientHints(http, js), http, js));
  updateHttpsBanner();
  errEl.hidden = true;
  errEl.textContent = "";
  updateChStatus(null);
}

async function run() {
  const runToken = ++activeRunToken;

  resetUi();
  updateHttpsBanner();

  try {
    const ua = uaEl.value || navigator.userAgent || "";
    if (!uaEl.value.trim()) uaEl.value = ua;

    /** Detect sends only what is in the form; auto Client Hints are filled only by "Use this device". */
    const hintsForApi = readClientHintsFromFields();

    const clientT0 = performance.now();
    const res = await fetch("/api/parse", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAgent: ua, clientHints: hintsForApi }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (runToken !== activeRunToken) return;
    const roundTripMs = Math.round(performance.now() - clientT0);
    updateChStatus(data);
    renderParseResult(data, { roundTripMs, lookupJob: data.lookupJob || null });
    if (shouldPollLookupJob(data.lookupJob)) {
      void pollLookupJob(data.lookupJob, runToken);
    }
  } catch (e) {
    if (runToken !== activeRunToken) return;
    errEl.hidden = false;
    errEl.textContent = e.message || String(e);
    resultNote.hidden = true;
  }
}

function resetUi() {
  currentViewData = null;
  currentViewRoundTripMs = null;
  errEl.hidden = true;
  errEl.textContent = "";
  resultNote.hidden = true;
  resultNote.textContent = "";
  tblBody.replaceChildren();
  tableEmptyState.hidden = false;
}

function renderParseResult(data, { roundTripMs = null, lookupJob = null } = {}) {
  currentViewData = data;
  if (roundTripMs != null) currentViewRoundTripMs = roundTripMs;
  renderResultNote(data, lookupJob);
  renderProperties(data.properties || [], data, lookupJob);
}

function renderResultNote(data, lookupJob) {
  const props = data.properties || [];
  const pick = (name) => props.find((p) => p.property === name)?.value;
  const deviceType = pick("DeviceType");
  const platform = pick("PlatformName");
  const notes = [];

  if (lookupJob?.status === "queued" || lookupJob?.status === "running") {
    notes.push(
      '<p class="gsm-running"><strong>Live lookup running…</strong> Showing the fast local result now; the table below will refresh automatically when background lookup completes.</p>',
    );
  }
  if (lookupJob?.status === "failed") {
    notes.push(
      `<p class="gsm-no-match"><strong>Live lookup failed.</strong> ${escapeHtml(lookupJob.error || "Background lookup did not complete.")}</p>`,
    );
  }

  if (data.gsmarena?.match === true) {
    if (data.gsmarena?.cached) {
      notes.push("<strong>Hardware confirmed</strong> using cached live specs for this known model.");
    } else {
      notes.push("<strong>Hardware confirmed</strong> by live lookup. The rows below are using the matched device details.");
    }
  } else if (data.debug?.datasetMatch) {
    if (isLookupPending(lookupJob) && data.gsmarena?.reason === "supplemental_specs") {
      notes.push(
        "<strong>Hardware matched</strong> the smartphone dataset for this model. Fetching extra live specs now, so screen and device detail rows below will update automatically.",
      );
    } else {
      notes.push("<strong>Hardware matched</strong> the smartphone dataset for this model. OEM / family rows come from that join.");
    }
  } else if (data.debug?.hardwareInferenceSuppressed) {
    if (lookupJob?.status === "queued" || lookupJob?.status === "running") {
      notes.push(
        "<strong>Hardware not in dataset.</strong> Looking up hardware details now. The pending hardware fields below will update automatically when live lookup finishes.",
      );
    } else if (data.gsmarena?.disabledAtServer) {
      notes.push(
        "<strong>Hardware not in dataset.</strong> Hardware stays <code>N/A</code> because live lookup is <strong>disabled on this server</strong>. Start with <code>npm run start:gsmarena</code> to resolve unknown models automatically, or add rows to <code>hvms_smartphone_hardware.json</code>.",
      );
    } else if (data.gsmarena?.attempted === true && data.gsmarena?.match === false) {
      notes.push(
        "<strong>Hardware not confirmed.</strong> The model was not found in the dataset or live lookup, so hardware stays <code>N/A</code>.",
      );
    } else {
      notes.push(
        "<strong>Hardware not in dataset.</strong> Hardware stays <code>N/A</code> until it is confirmed by the dataset or live lookup.",
      );
    }
  } else if (data.debug?.hardwareFallback) {
    notes.push(
      "<strong>Hardware / OEM</strong> below use <strong>heuristics</strong> (UA + Client Hints), not only <code>hvms_smartphone_hardware.json</code>. Treat as low-precision hints. When the model id is in the dataset, those rows override this layer.",
    );
  } else if (data.debug?.modelSource && data.debug.modelSource !== "none") {
    notes.push(
      "A device <strong>model id</strong> was taken from the UA or Client Hints, but it is <strong>not in</strong> <code>hvms_smartphone_hardware.json</code>. Browser and OS are still valid.",
    );
  } else if (data.debug?.modelSource === "none") {
    if (
      deviceType === "Desktop" ||
      platform === "macOS" ||
      platform === "Windows" ||
      platform === "Linux"
    ) {
      notes.push("<strong>Desktop browser</strong> — no smartphone hardware model expected.");
    } else if (!window.isSecureContext && isChromeReducedAndroidUa(uaEl.value)) {
      notes.push(
        '<strong>No hardware match.</strong> Use <code>npm run start:https</code> on the Mac and open the site as <code>https://…</code> on the phone so Chrome sends your real <code>Sec-CH-UA-Model</code>.',
      );
    } else {
      notes.push(
        "<strong>No hardware match.</strong> Chrome did not expose a device model id (UA is reduced or Client Hints blocked).",
      );
    }
  }

  if (notes.length === 0) {
    resultNote.hidden = true;
    return;
  }
  resultNote.hidden = false;
  resultNote.innerHTML = notes.join(" ");
}

function isLookupPending(lookupJob) {
  return lookupJob?.status === "queued" || lookupJob?.status === "running";
}

function shouldPollLookupJob(lookupJob) {
  return isLookupPending(lookupJob) && lookupJob?.pollUrl;
}

async function pollLookupJob(lookupJob, runToken) {
  const url = lookupJob.pollUrl;
  const intervalMs = Math.max(500, Number(lookupJob.pollIntervalMs) || 1500);
  const maxAttempts = Math.max(5, Number(lookupJob.maxAttempts) || 40);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (runToken !== activeRunToken) return;
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) continue;
      const job = await res.json();
      if (runToken !== activeRunToken) return;
      if (job.status === "completed" && job.result) {
        renderParseResult(job.result, { roundTripMs: currentViewRoundTripMs, lookupJob: job });
        return;
      }
      if (job.status === "failed") {
        if (currentViewData) {
          renderParseResult(currentViewData, { roundTripMs: currentViewRoundTripMs, lookupJob: job });
        }
        return;
      }
    } catch {
      /* retry */
    }
  }
}

function renderProperties(properties, data, lookupJob) {
  tblBody.replaceChildren();
  if (!properties.length) {
    tableEmptyState.hidden = false;
    return;
  }
  tableEmptyState.hidden = true;

  const pendingHw = isLookupPending(lookupJob);
  for (const row of properties) {
    const tr = document.createElement("tr");
    const pending =
      pendingHw &&
      (PENDING_HARDWARE_PROPERTIES.has(row.property) ||
        (data?.gsmarena?.reason === "supplemental_specs" &&
          PENDING_DIAGNOSTIC_GSMA_PROPERTIES.has(row.property)));
    const value = pending ? "…" : row.value ?? "N/A";
    const source = pending ? "pending" : row.source ?? "";
    tr.innerHTML = `<td>${escapeHtml(row.property)}</td><td>${escapeHtml(String(value))}</td><td>${escapeHtml(String(source))}</td>`;
    tblBody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

updateHttpsBanner();
