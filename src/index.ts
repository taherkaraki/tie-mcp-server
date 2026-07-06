#!/usr/bin/env node

/**
 * Tenable Identity Exposure MCP Server
 *
 * Exposes every TIE API operation as an individual MCP tool (one tool per
 * endpoint) so clients can filter by tool name for granular permission
 * control. Tool definitions are generated from the OpenAPI spec into
 * src/generated/tools.ts; a single generic dispatcher routes each call.
 *
 * Credentials are configured via environment variables on the client side.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { TIEClient } from './client.js';
import { dispatchTool } from './dispatch.js';
import { tools, type ToolDescriptor } from './generated/tools.js';
import { customTools, type CustomTool } from './custom-tools.js';

/**
 * Optional allowlist / denylist for tool exposure, controlled via env vars:
 *   TIE_ALLOWED_SAFETY  e.g. "read" or "read,write" (default: all tiers)
 * This lets operators disable destructive tools without code changes.
 * Applies to both generated and custom tools (both expose a `safety` tier).
 */
function filterTools<T extends { safety: string }>(all: T[]): T[] {
  const allowed = process.env.TIE_ALLOWED_SAFETY;
  if (!allowed) return all;
  const tiers = new Set(allowed.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((t) => tiers.has(t.safety));
}

async function main() {
  const config = loadConfig();
  const tieClient = new TIEClient(config);

  const activeTools = filterTools(tools);
  const activeCustomTools = filterTools(customTools);
  const toolsByName = new Map<string, ToolDescriptor>(activeTools.map((t) => [t.name, t]));
  const customByName = new Map<string, CustomTool>(activeCustomTools.map((t) => [t.name, t]));

  const server = new Server(
    {
      name: 'tie-mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Advertise custom convenience tools first, then every generated tool.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...activeCustomTools, ...activeTools].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Route each call: custom tools use their own handler; everything else goes
  // through the generic descriptor dispatcher.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const custom = customByName.get(name);
    const descriptor = toolsByName.get(name);

    if (!custom && !descriptor) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const data = custom
        ? await custom.handler(tieClient, args ?? {})
        : await dispatchTool(tieClient, descriptor!, args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('TIE MCP Server running on stdio');
  console.error(`Connected to: ${config.baseUrl}`);
  console.error(
    `Registered ${activeCustomTools.length} custom + ${activeTools.length} of ${tools.length} generated tools`
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
