import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = path.join(__dirname, "..", "data", "agents", "registry.json");

function registryPath() {
  const p = process.env.AGENT_REGISTRY_PATH?.trim();
  return p ? path.resolve(process.cwd(), p) : DEFAULT_REGISTRY_PATH;
}

function hashApiKey(apiKey) {
  return createHash("sha256").update(String(apiKey)).digest("hex");
}

function registrationSecretRequired() {
  const s = process.env.AGENT_REGISTRATION_SECRET?.trim();
  return Boolean(s);
}

function checkRegistrationSecret(provided) {
  const expected = process.env.AGENT_REGISTRATION_SECRET?.trim();
  if (!expected) return true;
  return String(provided ?? "") === expected;
}

async function loadRegistry() {
  const filePath = registryPath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { version: 1, agents: [] };
    if (!Array.isArray(data.agents)) return { version: 1, agents: [] };
    return data;
  } catch (err) {
    if (err?.code === "ENOENT") return { version: 1, agents: [] };
    throw err;
  }
}

async function saveRegistry(data) {
  const filePath = registryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * Self-register an agent (no human approval). Returns apiKey once.
 * @param {{ instanceId?: string, agentName?: string, registrationSecret?: string }} input
 */
export async function registerAgent(input = {}) {
  if (!checkRegistrationSecret(input.registrationSecret)) {
    return { ok: false, error: "invalid_registration_secret" };
  }

  const instanceId = String(input.instanceId || "").trim() || randomUUID();
  const agentName = String(input.agentName || "").trim() || `agent-${instanceId.slice(0, 8)}`;
  const agentId = randomUUID();
  const apiKey = `uap_${randomBytes(24).toString("hex")}`;

  const store = await loadRegistry();
  const now = new Date().toISOString();
  store.agents.push({
    agentId,
    agentName,
    instanceId,
    apiKeyHash: hashApiKey(apiKey),
    createdAt: now,
    lastSeenAt: now,
  });
  await saveRegistry(store);

  return {
    ok: true,
    agentId,
    agentName,
    instanceId,
    apiKey,
    message: "Store apiKey securely; it is shown only once. Pass it as tool argument apiKey or Authorization: Bearer <apiKey>.",
  };
}

/** @returns {{ agentId: string, agentName: string, instanceId: string } | null} */
export async function verifyAgentApiKey(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!key) return null;
  const store = await loadRegistry();
  const hash = hashApiKey(key);
  const row = store.agents.find((a) => a.apiKeyHash === hash);
  if (!row) return null;

  row.lastSeenAt = new Date().toISOString();
  await saveRegistry(store);

  return {
    agentId: row.agentId,
    agentName: row.agentName,
    instanceId: row.instanceId,
  };
}

export function agentAuthRequired() {
  return process.env.MCP_AGENT_AUTH !== "0";
}

export function extractApiKeyFromRequest(req, argsApiKey) {
  const fromArg = String(argsApiKey ?? "").trim();
  if (fromArg) return fromArg;
  const auth = req?.headers?.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

export async function requireAgentAuth(req, argsApiKey) {
  if (!agentAuthRequired()) {
    return { ok: true, agent: { agentId: "anonymous", agentName: "anonymous", instanceId: "none" } };
  }
  const apiKey = extractApiKeyFromRequest(req, argsApiKey);
  const agent = await verifyAgentApiKey(apiKey);
  if (!agent) {
    return {
      ok: false,
      error: "invalid_or_missing_api_key",
      hint: "Call register_agent first, then pass apiKey on tools or Authorization: Bearer <apiKey>.",
    };
  }
  return { ok: true, agent };
}

export function agentRegistryStatus() {
  return {
    path: registryPath(),
    registrationSecretRequired: registrationSecretRequired(),
    agentAuthRequired: agentAuthRequired(),
  };
}
