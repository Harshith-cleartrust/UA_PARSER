import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import { PARSER_API_VERSION } from "./buildResult.js";
import { executeParse, slimParseApiResponse } from "./parseApi.js";
import {
  registerAgent,
  requireAgentAuth,
  agentRegistryStatus,
  agentAuthRequired,
} from "./agentRegistry.js";
import { pickNonEmptyClientHintsFromBody } from "./clientHintsFromRequest.js";
import { modelParseCacheStatus, modelParseCacheOnlyMode } from "./modelParseCache.js";
import { auditLogStatus } from "./auditLog.js";

const clientHintsSchema = z
  .object({
    secChUaModel: z.string().optional(),
    secChUaMobile: z.string().optional(),
    secChUaPlatform: z.string().optional(),
    secChUaPlatformVersion: z.string().optional(),
  })
  .optional();

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }],
  };
}

/**
 * @param {{ deviceCatalog: object, gsmrEnrichAllowed: boolean, queueLookupJob?: Function, aiAnalyzeConfigured?: boolean, runAiAnalyze?: Function }} runtime
 */
export function createUaParserMcpServer(runtime) {
  const httpReq = () => runtime.req;
  const server = new McpServer(
    {
      name: "ua-parser",
      version: PARSER_API_VERSION,
    },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "register_agent",
    {
      description:
        "Self-register an autonomous agent (no human approval). Returns a one-time apiKey for subsequent tools.",
      inputSchema: {
        instanceId: z
          .string()
          .optional()
          .describe("Stable id for this agent instance (UUID). Generated if omitted."),
        agentName: z.string().optional().describe("Optional display name."),
        registrationSecret: z
          .string()
          .optional()
          .describe("Required when AGENT_REGISTRATION_SECRET is set on the server."),
      },
    },
    async ({ instanceId, agentName, registrationSecret }) => {
      const out = await registerAgent({ instanceId, agentName, registrationSecret });
      if (!out.ok) return errorResult(out.error);
      return textResult({
        ok: true,
        agentId: out.agentId,
        agentName: out.agentName,
        instanceId: out.instanceId,
        apiKey: out.apiKey,
        message: out.message,
        mcpEndpoint: "/mcp",
        agentAuthRequired: agentAuthRequired(),
      });
    },
  );

  server.registerTool(
    "parse_user_agent",
    {
      description:
        "Parse a User-Agent string (and optional Client Hints) into browser, platform, and hardware properties.",
      inputSchema: {
        userAgent: z.string().describe("Full User-Agent string."),
        clientHints: clientHintsSchema.describe("Optional Sec-CH-UA-* style hints."),
        apiKey: z
          .string()
          .optional()
          .describe("Agent apiKey from register_agent (or use Authorization: Bearer header)."),
      },
    },
    async ({ userAgent, clientHints, apiKey }) => {
      const auth = await requireAgentAuth(httpReq(), apiKey);
      if (!auth.ok) return errorResult(auth.error, { hint: auth.hint });

      try {
        const hints = pickNonEmptyClientHintsFromBody(clientHints || {});
        const { result } = await executeParse(
          { userAgent, clientHints: hints },
          {
            deviceCatalog: runtime.deviceCatalog,
            gsmrEnrichAllowed: runtime.gsmarenaAllowed,
            queueLookupJob: runtime.queueLookupJob,
            applyLivePath: !modelParseCacheOnlyMode(),
          },
        );
        return textResult({
          ok: true,
          agent: auth.agent,
          ...slimParseApiResponse(result),
        });
      } catch (err) {
        return errorResult(String(err?.message || err));
      }
    },
  );

  server.registerTool(
    "get_parser_health",
    {
      description: "Server health, parser version, dataset and cache status.",
      inputSchema: {
        apiKey: z.string().optional().describe("Agent apiKey when MCP_AGENT_AUTH is enabled."),
      },
    },
    async ({ apiKey }) => {
      const auth = await requireAgentAuth(httpReq(), apiKey);
      if (!auth.ok) return errorResult(auth.error, { hint: auth.hint });

      return textResult({
        ok: true,
        parserVersion: PARSER_API_VERSION,
        indexedModels: runtime.deviceCatalog?.size,
        deviceDbVersion: runtime.deviceCatalog?.meta?.version,
        gsmarenaAllowed: runtime.gsmarenaAllowed,
        modelParseCache: modelParseCacheStatus(),
        auditLog: auditLogStatus(),
        agentRegistry: agentRegistryStatus(),
        mcpEndpoint: "/mcp",
      });
    },
  );

  if (runtime.aiAnalyzeConfigured && typeof runtime.runAiAnalyze === "function") {
    server.registerTool(
      "analyze_ua_risk",
      {
        description: "AI risk analysis for a User-Agent (requires server AI_ANALYZE_API_KEY).",
        inputSchema: {
          userAgent: z.string(),
          clientHints: clientHintsSchema,
          apiKey: z.string().optional(),
        },
      },
      async ({ userAgent, clientHints, apiKey }) => {
        const auth = await requireAgentAuth(httpReq(), apiKey);
        if (!auth.ok) return errorResult(auth.error, { hint: auth.hint });

        try {
          const hints = pickNonEmptyClientHintsFromBody(clientHints || {});
          const out = await runtime.runAiAnalyze(userAgent, hints);
          if (!out.ok) return errorResult(out.error, { message: out.message });
          return textResult({ ok: true, agent: auth.agent, ...out });
        } catch (err) {
          return errorResult(String(err?.message || err));
        }
      },
    );
  }

  return server;
}

/**
 * Mount stateless Streamable HTTP MCP on an Express app at /mcp.
 * @param {import('express').Express} app
 * @param {Parameters<typeof createUaParserMcpServer>[0]} runtime
 */
export function mountMcpRoutes(app, runtime) {
  const handler = async (req, res) => {
    const server = createUaParserMcpServer({ ...runtime, req });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close();
      });
    } catch (err) {
      console.error("[mcp] request error:", err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", handler);
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for MCP." },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
}
