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
import { filterTools } from './filter.js';
import { tools, type ToolDescriptor } from './generated/tools.js';
import {
  customTools,
  getSharedStore,
  configureStore,
  type CustomTool,
  type ToolContext,
} from './custom-tools.js';

async function main() {
  const config = loadConfig();
  const tieClient = new TIEClient(config);

  // Inject cache configuration before any tool call creates the shared store.
  configureStore({ ttlMs: config.cacheTtlMs, baseUrl: config.baseUrl });

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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const custom = customByName.get(name);
    const descriptor = toolsByName.get(name);

    if (!custom && !descriptor) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // If the client requested progress for this request, bridge the store's
    // per-page scan callback to notifications/progress. `total` is omitted
    // because the API doesn't tell us the object count up front (indeterminate).
    const progressToken = request.params._meta?.progressToken;
    const ctx: ToolContext = {};
    if (progressToken !== undefined) {
      ctx.reportProgress = ({ pages, objects }) => {
        void extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: pages,
            message: `Scanning AD objects: ${objects} loaded (${pages} pages)`,
          },
        });
      };
    }

    try {
      const data = custom
        ? await custom.handler(tieClient, args ?? {}, ctx)
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

  // Background startup work (fire-and-forget; runs after connect() so it never
  // delays startup, and failures are logged but never crash the server):
  //   1. Warm the attribute snapshot (on by default; TIE_WARM_CACHE=false opts out).
  //   2. Then, if TIE_BUILD_GRAPH=true, build the control graph — a distinct
  //      second phase that starts only once the snapshot is warm, so attribute
  //      search goes live first and graph analysis overlaps with real work.
  if (config.warmCache || config.buildGraph) {
    const store = getSharedStore(tieClient);
    const warmStep = config.warmCache
      ? (() => {
          console.error('Warming AD object cache (set TIE_WARM_CACHE=false to disable)...');
          return store
            .warm(({ pages, objects }) => {
              if (pages % 10 === 0) {
                console.error(`  warmed ${objects} objects (${pages} pages)`);
              }
            })
            .then(() => console.error('AD object cache warm.'));
        })()
      : Promise.resolve();

    warmStep
      .then(() => {
        if (!config.buildGraph) return;
        console.error('Building control graph (TIE_BUILD_GRAPH=true)...');
        return store
          .buildGraph(({ processed, total }) => {
            if (processed % 10000 === 0 || processed === total) {
              console.error(`  graph: ${processed}/${total} objects processed`);
            }
          })
          .then(() => {
            const s = store.graphStatus().stats;
            console.error(
              `Control graph ready: ${s?.nodes} nodes, ${s?.edges} edges` +
                (s?.dangling ? ` (${s.dangling} out-of-scope refs)` : '')
            );
          });
      })
      .catch((err) =>
        console.error(
          `Startup warm/graph build failed (will build lazily on demand): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      );
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
