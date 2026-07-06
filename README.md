# TIE MCP Server

Model Context Protocol (MCP) server for Tenable Identity Exposure API.

## Features

- Complete coverage of all 131 TIE API operations (one MCP tool per endpoint)
- Client-side credential management for security
- Multi-tenant support (multiple TIE environments)
- Granular tool-level security controls
- Auto-generated tool definitions from the OpenAPI specification

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

# Regenerate tool definitions from the OpenAPI spec (writes src/generated/tools.ts)
npm run generate:tools

# (Optional) Generate TypeScript API types from the OpenAPI spec
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

Tool categories by risk level (the `safety` field on each generated descriptor):
- 🟢 **read** (70 tools): `get_*`, `list_*`, `search_*`, `export_*`
- 🟡 **write** (51 tools): `create_*`, `update_*`, `set_*`, plus actions like `commit_*`, `login`
- 🔴 **destructive** (10 tools): `delete_*`, `unstage_*`

#### Server-side safety filter

Beyond the client's `allowedTools`/`deniedTools`, the server itself honors a
`TIE_ALLOWED_SAFETY` environment variable. Set it to a comma-separated list of
tiers to advertise only those tools — e.g. `read` for a strictly read-only
deployment, or `read,write` to disable destructive operations entirely:

```json
{
  "mcpServers": {
    "tie-readonly": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer.tenable.ad",
        "TIE_API_KEY": "key",
        "TIE_ALLOWED_SAFETY": "read"
      }
    }
  }
}
```

## Architecture

Rather than hand-writing a handler per endpoint, tool definitions are generated
from the OpenAPI spec into a single data file, and one generic dispatcher turns
any descriptor + arguments into an HTTP request.

```
scripts/
└── generate-tools.mjs    # Parses the OpenAPI spec -> src/generated/tools.ts
src/
├── index.ts              # MCP server: registers tools, routes calls
├── config.ts             # Environment configuration
├── client.ts             # HTTP client for TIE API (axios)
├── dispatch.ts           # Generic descriptor -> HTTP request dispatcher
└── generated/            # Auto-generated — do not edit by hand
    └── tools.ts          # 131 ToolDescriptor entries (name, method, path, schema)
```

Regenerate `src/generated/tools.ts` whenever the TIE API spec changes:

```bash
npm run generate:tools
```

## Available Tools

`src/generated/tools.ts` is the source of truth for all 131 tools. See
[TOOL_NAMING_CONVENTION.md](TOOL_NAMING_CONVENTION.md) for the naming scheme and
the (historical) 88-endpoint reference list.

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
