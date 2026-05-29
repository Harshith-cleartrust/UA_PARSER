const uaEl = document.getElementById("ua");
const copyUaBtn = document.getElementById("copyUa");
const clearUaBtn = document.getElementById("clearUa");
const aiAnalyzeBtn = document.getElementById("aiAnalyze");
const hintModel = document.getElementById("hintModel");
const hintMobile = document.getElementById("hintMobile");
const hintPlat = document.getElementById("hintPlat");
const hintPlatVer = document.getElementById("hintPlatVer");
const propertySections = document.getElementById("propertySections");
const errEl = document.getElementById("err");
const chStatus = document.getElementById("chStatus");
const httpsBanner = document.getElementById("httpsBanner");
const resultNote = document.getElementById("resultNote");
const tableEmptyState = document.getElementById("tableEmptyState");
let activeRunToken = 0;
let currentViewData = null;
let currentViewRoundTripMs = null;
let loadingMessageTimer = null;
const PENDING_HARDWARE_PROPERTIES = new Set([
  "HardwareFamily",
  "HardwareModel",
  "HardwareName",
  "HardwareNameVersion",
  "HardwareVendor",
  "OEM",
  "SoC",
  "CPU",
  "GPU",
  "ScreenInchesDiagonal",
  "ScreenPixelsWidth",
  "ScreenPixelsHeight",
  "SupportedBearers",
]);

const PENDING_DIAGNOSTIC_GSMA_PROPERTIES = new Set(["Device Model", "Manufacturer", "Approx Device Age"]);
const PROPERTY_SECTIONS = [
  {
    title: "Browser",
    fields: [
      ["BrowserName", "Browser Name"],
      ["BrowserVendor", "Browser Vendor"],
      ["BrowserVersion", "Browser Version"],
      ["Browser Type", "Browser Type"],
      ["Rendering Engine", "Rendering Engine"],
      ["Mobile Browser", "Mobile Browser"],
      ["Android WebView", "Android WebView"],
      ["In-App Browser", "In-App Browser"],
    ],
  },
  {
    title: "Hardware",
    fields: [
      ["HardwareFamily", "Hardware Family"],
      ["HardwareModel", "Hardware Model"],
      ["HardwareName", "Hardware Name"],
      ["HardwareNameVersion", "Hardware Name Version"],
      ["HardwareVendor", "Hardware Vendor"],
      ["Manufacturer", "Manufacturer"],
      ["Device Model", "Device Model"],
      ["DeviceType", "Device Type"],
      ["Approx Device Age", "Approx Device Age"],
    ],
  },
  {
    title: "Display",
    fields: [
      ["ScreenInchesDiagonal", "Screen Size"],
      ["ScreenPixelsWidth", "Screen Width"],
      ["ScreenPixelsHeight", "Screen Height"],
    ],
  },
  {
    title: "Chipset & Performance",
    fields: [
      ["SoC", "SoC"],
      ["CPU", "CPU"],
      ["GPU", "GPU"],
      ["CPU Architecture", "CPU Architecture"],
    ],
  },
  {
    title: "Platform / Operating System",
    fields: [
      ["PlatformName", "Platform Name"],
      ["PlatformVendor", "Platform Vendor"],
      ["PlatformVersion", "Platform Version"],
      ["Operating System", "Operating System"],
      ["OS Version", "OS Version"],
    ],
  },
  {
    title: "Network & Connectivity",
    fields: [["SupportedBearers", "Supported Bearers"]],
  },
  {
    title: "Detection & Classification",
    fields: [
      ["IsCrawler", "Is Crawler"],
      ["IsWebApp", "Is Web App"],
      ["Automation / Bots", "Automation Bots"],
    ],
  },
];
const HUMANIZED_VALUE_PROPERTIES = new Set([
  "HardwareFamily",
  "HardwareName",
  "HardwareNameVersion",
  "HardwareVendor",
  "Manufacturer",
  "Device Model",
  "DeviceType",
  "BrowserName",
  "BrowserVendor",
  "PlatformName",
  "PlatformVendor",
  "Operating System",
]);
const LOADING_MESSAGES = [
  "🧩 Untangling your browser identity...",
  "👀 Looking for suspicious combinations...",
  "📱 Tap your device if it’s actually real.",
  "🧠 Teaching AI to trust your headers...",
  "🔍 Finding out who your browser truly is...",
  "⚠️ Your browser may be lying to us...",
  "🎲 Rolling dice on whether this is genuine Chrome...",
  "🛡️ Human or headless? Let’s see...",
  "📡 Sending your UA to the interrogation room...",
  "🧪 Testing for browser shapeshifting...",
  "🕶️ Detecting fake mustaches on headless Chrome...",
  "📖 Reading your browser’s backstory...",
  "🎯 Can you fool the parser? Probably not.",
  "🚨 Suspicious Safari activity detected...",
  "🧬 Analyzing browser DNA...",
  "🤝 Be honest… are you spoofing?",
  "🎮 Browser identity mini-game starting...",
  "🧠 AI is judging your User-Agent choices...",
  "🔐 Verifying you’re not a smart fridge...",
  "📞 Your headers are under investigation...",
  "🛠️ Repairing broken browser identities...",
  "😅 Trying not to crash on malformed UAs...",
];

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
copyUaBtn?.addEventListener("click", () => {
  void copyUserAgent();
});
clearUaBtn?.addEventListener("click", clearUserAgent);
aiAnalyzeBtn?.addEventListener("click", () => {
  void aiAnalyze();
});
setAiAnalyzeEnabled(false);

function clearUserAgent() {
  uaEl.value = "";
  errEl.hidden = true;
  errEl.textContent = "";
  setAiAnalyzeEnabled(false);
  uaEl.focus();
}

async function copyUserAgent() {
  const value = uaEl.value || "";
  if (!value.trim()) return;

  try {
    await navigator.clipboard.writeText(value);
    showCopyState();
  } catch {
    uaEl.select();
    document.execCommand("copy");
    showCopyState();
  }
}

function showCopyState() {
  if (!copyUaBtn) return;
  copyUaBtn.classList.add("copied");
  window.setTimeout(() => {
    copyUaBtn.classList.remove("copied");
  }, 1200);
}

function startLoadingMessages(prefix = "Working") {
  stopLoadingMessages();
  let idx = Math.floor(Math.random() * LOADING_MESSAGES.length);
  const render = () => {
    resultNote.hidden = false;
    resultNote.innerHTML = `<div class="loading-note"><strong>${escapeHtml(prefix)}:</strong> ${escapeHtml(LOADING_MESSAGES[idx])}</div>`;
    idx = (idx + 1) % LOADING_MESSAGES.length;
  };
  render();
  loadingMessageTimer = window.setInterval(render, 1800);
}

function stopLoadingMessages() {
  if (loadingMessageTimer) {
    window.clearInterval(loadingMessageTimer);
    loadingMessageTimer = null;
  }
}

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
    "Detect uses only what is typed in the Client hints fields below. Browser-added Sec-CH-UA-* headers are used only when you tap Use this device to copy them into the fields.",
  );

  if (data?.debug) {
    const raw = data.debug.clientHintsFromJs;
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
      lines.push(`Server received clientHints in JSON body: ${JSON.stringify(raw)}`);
    } else {
      lines.push("No Client hints were sent in the JSON body, so Detect ignored browser HTTP Client Hint headers for this parse.");
    }
  }

  if (isChromeReducedAndroidUa(ua)) {
    lines.push("Chrome hid the model in the UA (… K …). You need HTTPS + Sec-CH-UA-Model for your exact device id.");
  }

  if (data?.debug?.secChUaModelFromJs) {
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
      lines.push(`Client hints used for this parse: ${parts.join(", ")}. The form above is not overwritten after Detect.`);
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
  startLoadingMessages("Detect");

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
    stopLoadingMessages();
    const roundTripMs = Math.round(performance.now() - clientT0);
    updateChStatus(data);
    renderParseResult(data, { roundTripMs, lookupJob: data.lookupJob || null });
    if (shouldPollLookupJob(data.lookupJob)) {
      void pollLookupJob(data.lookupJob, runToken);
    }
  } catch (e) {
    if (runToken !== activeRunToken) return;
    stopLoadingMessages();
    errEl.hidden = false;
    errEl.textContent = e.message || String(e);
    resultNote.hidden = true;
  }
}

async function aiAnalyze() {
  if (!currentViewData || aiAnalyzeBtn?.disabled) return;
  errEl.hidden = true;
  errEl.textContent = "";
  startLoadingMessages("AI Analyze");

  try {
    const ua = uaEl.value || navigator.userAgent || "";
    if (!uaEl.value.trim()) uaEl.value = ua;

    const res = await fetch("/api/ai-analyze", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAgent: ua, clientHints: readClientHintsFromFields() }),
    });
    const data = await res.json().catch(() => ({}));
    stopLoadingMessages();
    renderAiAnalyzeResult(data, res.ok);
  } catch (e) {
    stopLoadingMessages();
    errEl.hidden = false;
    errEl.textContent = e.message || String(e);
    resultNote.hidden = true;
  }
}

function renderAiAnalyzeResult(data, ok) {
  const message =
    data?.message ||
    data?.analysis ||
    (ok ? "AI analysis completed." : "AI Analyze is unavailable.");
  let risk = normalizeRiskLevel(data?.riskLevel);
  let score = normalizeRiskScore(data?.riskScore, risk);
  const modelConflict = data?.localDetection?.debug?.modelSourceConflict;
  if (modelConflict?.uaModel && modelConflict?.chModel) {
    risk = "high";
    score = Math.max(score ?? 0, 8);
  }
  const bodyText = patchAnalysisRiskPreamble(String(message), risk, score);
  resultNote.hidden = false;
  resultNote.innerHTML = `<div class="ai-analysis">${renderRiskHeader(risk, score)}${formatAiAnalysis(bodyText)}</div>`;
}

/** Keep the markdown risk line consistent with the gauge when we adjust score client-side. */
function patchAnalysisRiskPreamble(text, risk, score) {
  if (!risk || score == null) return String(text || "");
  const s = String(text || "");
  return s.replace(
    /^\*\*Risk:\s*(?:HIGH|MEDIUM|LOW)\s*\(\d{1,2}\/10\)\*\*/im,
    `**Risk: ${risk.toUpperCase()} (${score}/10)**`,
  );
}

function normalizeRiskLevel(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "";
}

function normalizeRiskScore(raw, risk) {
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(1, Math.min(10, Math.round(n)));
  if (risk === "high") return 9;
  if (risk === "medium") return 5;
  if (risk === "low") return 2;
  return null;
}

function riskFromScore(score) {
  if (score == null) return "";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function renderRiskHeader(risk, score) {
  if (!risk) return "<h3>AI Analyze</h3>";
  const scoreClass = riskFromScore(score) || risk;
  const deg = score == null ? 0 : Math.round((score / 10) * 360);
  return [
    '<div class="risk-header">',
    '<span class="risk-label">AI Analyze</span>',
    '<div class="risk-summary">',
    `<span class="risk-gauge ${scoreClass}" style="--risk-deg:${deg}deg"><span>${score ?? "?"}</span></span>`,
    `<span class="risk-badge ${risk}">${risk.toUpperCase()} RISK</span>`,
    "</div>",
    "</div>",
  ].join("");
}

function formatAiAnalysis(raw) {
  const sectionNames = [
    "Risk: HIGH",
    "Risk: MEDIUM",
    "Risk: LOW",
    "Risk: HIGH (10/10)",
    "Risk: HIGH (9/10)",
    "Risk: HIGH (8/10)",
    "Risk: HIGH (7/10)",
    "Risk: MEDIUM (6/10)",
    "Risk: MEDIUM (5/10)",
    "Risk: MEDIUM (4/10)",
    "Risk: LOW (3/10)",
    "Risk: LOW (2/10)",
    "Risk: LOW (1/10)",
    "Summary",
    "Reasons",
    "Recommendation",
    "Important signals",
    "Conflicts / spoofing check",
    "Confidence",
    "Practical classification",
  ];
  const sectionRe = new RegExp(`\\s*\\*\\*(${sectionNames.map(escapeRegExp).join("|")})\\*\\*\\s*`, "gi");
  let text = String(raw || "")
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(sectionRe, "\n\n**$1**\n")
    .replace(/\s+-\s+(?=\*\*)/g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const heading = line.match(/^\*\*(.+?)\*\*$/);
    if (heading) {
      closeList();
      html.push(`<h4>${escapeHtml(heading[1])}</h4>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${formatInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }
  closeList();

  return html.join("");
}

function formatInlineMarkdown(s) {
  const code = [];
  let escaped = escapeHtml(s).replace(/`([^`]+)`/g, (_m, inner) => {
    const token = `@@CODE${code.length}@@`;
    code.push(`<code>${inner}</code>`);
    return token;
  });
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (let i = 0; i < code.length; i++) {
    escaped = escaped.replace(`@@CODE${i}@@`, code[i]);
  }
  return escaped;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resetUi() {
  stopLoadingMessages();
  currentViewData = null;
  currentViewRoundTripMs = null;
  setAiAnalyzeEnabled(false);
  errEl.hidden = true;
  errEl.textContent = "";
  resultNote.hidden = true;
  resultNote.textContent = "";
  propertySections.replaceChildren();
  tableEmptyState.hidden = false;
}

function renderParseResult(data, { roundTripMs = null, lookupJob = null } = {}) {
  currentViewData = data;
  if (roundTripMs != null) currentViewRoundTripMs = roundTripMs;
  setAiAnalyzeEnabled(true);
  renderResultNote(data, lookupJob);
  renderProperties(data.properties || [], data, lookupJob);
}

function setAiAnalyzeEnabled(enabled) {
  if (!aiAnalyzeBtn) return;
  aiAnalyzeBtn.disabled = !enabled;
  aiAnalyzeBtn.title = enabled ? "Analyze risk using AI" : "Run Detect first";
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
  propertySections.replaceChildren();
  if (!properties.length) {
    tableEmptyState.hidden = false;
    return;
  }
  tableEmptyState.hidden = true;

  const pendingHw = isLookupPending(lookupJob);
  const byProperty = new Map(properties.map((row) => [row.property, row]));

  for (const section of PROPERTY_SECTIONS) {
    const seenValues = new Set();
    const rows = [];
    for (const [propertyName, label] of section.fields) {
      const row = byProperty.get(propertyName);
      if (!row) continue;
      const pending =
        pendingHw &&
        (PENDING_HARDWARE_PROPERTIES.has(row.property) ||
          (data?.gsmarena?.reason === "supplemental_specs" &&
            PENDING_DIAGNOSTIC_GSMA_PROPERTIES.has(row.property)));
      const rawValue = pending ? "…" : row.value ?? "N/A";
      const value = formatPropertyValue(row.property, rawValue);
      const duplicateKey = duplicateValueKey(value);
      if (duplicateKey && seenValues.has(duplicateKey)) continue;
      if (duplicateKey) seenValues.add(duplicateKey);
      rows.push({ label, value });
    }
    if (rows.length === 0) continue;

    const card = document.createElement("section");
    card.className = "property-section";
    card.innerHTML = [
      `<h3>${escapeHtml(section.title)}</h3>`,
      '<table class="property-table">',
      "<thead><tr><th>Property</th><th>Value</th></tr></thead>",
      `<tbody>${rows
        .map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(String(row.value))}</td></tr>`)
        .join("")}</tbody>`,
      "</table>",
    ].join("");
    propertySections.appendChild(card);
  }
}

function duplicateValueKey(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s || s === "n/a" || s === "none detected" || s === "unknown") return "";
  return s;
}

function formatPropertyValue(property, value) {
  const s = String(value ?? "N/A");
  if (!HUMANIZED_VALUE_PROPERTIES.has(property) || s === "N/A" || s === "…") return s;
  return s
    .split(/(\s+|[-/()])/)
    .map((part) => {
      if (!/[a-z]/i.test(part)) return part;
      const known = {
        ios: "iOS",
        macos: "macOS",
        android: "Android",
        chrome: "Chrome",
        safari: "Safari",
        vivo: "Vivo",
        samsung: "Samsung",
        google: "Google",
        apple: "Apple",
      };
      if (known[part.toLowerCase()]) return known[part.toLowerCase()];
      if (/^[A-Z0-9]{2,}$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("")
    .replace(/\bGalaxy([A-Z])/g, "Galaxy $1")
    .replace(/\bIphone\b/g, "iPhone")
    .replace(/\bIpad\b/g, "iPad");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

updateHttpsBanner();
