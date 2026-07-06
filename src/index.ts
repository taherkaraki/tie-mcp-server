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

/**
 * Optional allowlist / denylist for tool exposure, controlled via env vars:
 *   TIE_ALLOWED_SAFETY  e.g. "read" or "read,write" (default: all tiers)
 * This lets operators disable destructive tools without code changes.
 */
function filterTools(all: ToolDescriptor[]): ToolDescriptor[] {
  const allowed = process.env.TIE_ALLOWED_SAFETY;
  if (!allowed) return all;
  const tiers = new Set(allowed.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((t) => tiers.has(t.safety));
}

async function main() {
  const config = loadConfig();
  const tieClient = new TIEClient(config);

  const activeTools = filterTools(tools);
  const toolsByName = new Map(activeTools.map((t) => [t.name, t]));

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

  // Advertise every generated tool.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Route every call through the generic dispatcher.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const descriptor = toolsByName.get(name);

    if (!descriptor) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const data = await dispatchTool(tieClient, descriptor, args ?? {});
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
  console.error(`Registered ${activeTools.length} of ${tools.length} tools`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
