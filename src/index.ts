#!/usr/bin/env node

/**
 * Tenable Identity Exposure MCP Server
 *
 * Provides MCP tools for interacting with Tenable Identity Exposure API.
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

// Import tool registrations (will be created after client generation)
// import { registerTools } from './tools/index.js';

/**
 * Main server initialization
 */
async function main() {
  // Load configuration from environment
  const config = loadConfig();

  // Initialize TIE API client
  const tieClient = new TIEClient(config);

  // Create MCP server
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

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // Tools will be registered here after generation
        {
          name: 'get_about',
          description: 'Get general information about the TIE system',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Route to appropriate tool handler
      switch (name) {
        case 'get_about':
          const aboutData = await tieClient.get('/api/about');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(aboutData, null, 2),
              },
            ],
          };

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('TIE MCP Server running on stdio');
  console.error(`Connected to: ${config.baseUrl}`);
}

// Run server
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
