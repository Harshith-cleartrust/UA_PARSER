#!/usr/bin/env node
/**
 * Quick MCP smoke test: register_agent → parse_user_agent
 * Usage:
 *   node scripts/test-mcp.mjs
 *   MCP_URL=https://10.1.0.185:3000/mcp node scripts/test-mcp.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.env.MCP_URL || "http://localhost:3000/mcp").replace(/\/$/, "");
const UA =
  process.env.TEST_UA ||
  "Mozilla/5.0 (Linux; Android 12; SM-A266B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

function parseToolText(result) {
  const block = result?.content?.find((c) => c.type === "text");
  if (!block?.text) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return { raw: block.text };
  }
}

async function main() {
  console.log("MCP URL:", base);
  const transport = new StreamableHTTPClientTransport(new URL(base));
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  await client.connect(transport);
  console.log("✓ Connected");

  const tools = await client.listTools();
  console.log(
    "✓ Tools:",
    tools.tools.map((t) => t.name).join(", "),
  );

  const reg = await client.callTool({
    name: "register_agent",
    arguments: { agentName: "mcp-smoke-test", instanceId: `test-${Date.now()}` },
  });
  const regData = parseToolText(reg);
  if (!regData?.ok || !regData.apiKey) {
    console.error("✗ register_agent failed:", regData);
    process.exit(1);
  }
  console.log("✓ register_agent — agentId:", regData.agentId);

  const parsed = await client.callTool({
    name: "parse_user_agent",
    arguments: {
      userAgent: UA,
      apiKey: regData.apiKey,
      clientHints: { secChUaModel: '"SM-A266B"' },
    },
  });
  const parseData = parseToolText(parsed);
  if (!parseData?.ok || !parseData.properties?.BrowserName) {
    console.error("✗ parse_user_agent failed:", parseData);
    process.exit(1);
  }
  console.log("✓ parse_user_agent — BrowserName:", parseData.properties.BrowserName);
  console.log("  HardwareModel:", parseData.properties.HardwareModel);
  console.log("\nMCP is working.");
  await client.close();
}

main().catch((err) => {
  console.error("MCP test failed:", err.message || err);
  process.exit(1);
});
