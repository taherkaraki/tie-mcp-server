# TIE MCP Server

Model Context Protocol (MCP) server for Tenable Identity Exposure API.

## Features

- Complete coverage of all 88 TIE API endpoints
- Client-side credential management for security
- Multi-tenant support (multiple TIE environments)
- Granular tool-level security controls
- Auto-generated from OpenAPI specification

## Installation

```bash
npm install
npm run build
```

## Configuration

The MCP server requires two environment variables:

- `TIE_BASE_URL` - Your TIE instance URL (e.g., `https://customer.tenable.ad`)
- `TIE_API_KEY` - Your TIE API key

### Single Environment Setup

Add to your MCP client configuration (e.g., `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer.tenable.ad",
        "TIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Multiple Environments Setup

For multiple TIE environments, add multiple server instances:

```json
{
  "mcpServers": {
    "tie-prod": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://prod.tenable.ad",
        "TIE_API_KEY": "prod-key"
      }
    },
    "tie-staging": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://staging.tenable.ad",
        "TIE_API_KEY": "staging-key"
      }
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Generate TypeScript types from OpenAPI spec
npm run generate:client

# Build the project
npm run build

# Watch mode for development
npm run watch

# Run without building (development)
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Security

### Client-Side Credentials

Credentials are **never stored** in the MCP server code. They must be configured on the client side (MCP client config) and passed as environment variables to the server process.

### Tool-Level Filtering

Organizations can filter tools by operation type for granular security control:

```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer.tenable.ad",
        "TIE_API_KEY": "key"
      },
      "allowedTools": ["get_*", "list_*", "search_*"],
      "deniedTools": ["delete_*"]
    }
  }
}
```

Tool categories by risk level:
- 🟢 **Safe (Read-Only)**: `get_*`, `list_*`, `search_*`, `export_*`
- 🟡 **Moderate**: `create_*`, `update_*`, `patch_*`, `set_*`
- 🔴 **Dangerous**: `delete_*`, `unstage_*`

## Architecture

```
src/
├── index.ts              # Main MCP server entry point
├── config.ts             # Environment configuration
├── client.ts             # HTTP client for TIE API
├── generated/            # Auto-generated from OpenAPI spec
│   └── api-types.ts      # TypeScript types
├── tools/                # MCP tool implementations
│   ├── index.ts          # Tool registry
│   ├── about.ts          # About tools
│   ├── attacks.ts        # Attack tools
│   ├── deviances.ts      # Deviance tools
│   └── ...               # Other tool categories
└── utils/                # Shared utilities
```

## Available Tools

See [TOOL_NAMING_CONVENTION.md](TOOL_NAMING_CONVENTION.md) for the complete list of 88 tools.

### Examples

```typescript
// Get system information
get_about()

// List attacks for a profile
list_attacks({ profileId: "profile-123" })

// Search events
search_events({
  query: { /* search criteria */ }
})

// Create infrastructure
create_infrastructure({
  name: "Production",
  description: "Production environment"
})

// Update deviance
update_deviance({
  infrastructureId: "infra-1",
  directoryId: "dir-1",
  devianceId: "dev-1",
  data: { status: "resolved" }
})
```

## API Documentation

- [API Endpoints](API_ENDPOINTS.md)
- [Tool Naming Convention](TOOL_NAMING_CONVENTION.md)
- [Authentication](AUTHENTICATION.md)
- [Architecture Options](ARCHITECTURE_OPTIONS.md)

## License

MIT
