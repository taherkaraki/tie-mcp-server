# TIE MCP Server

Model Context Protocol (MCP) server for Tenable Identity Exposure API.

## Features

- Complete coverage of all 131 TIE API operations (one MCP tool per endpoint)
- Additional convenience tools for discovery and navigation (2 custom tools)
- Client-side credential management for security
- Multi-tenant support (multiple TIE environments)
- Granular tool-level security controls
- Auto-generated tool definitions from the OpenAPI specification

## Installation

The server runs as a local subprocess of your MCP client and communicates over
stdio. Choose one of the following.

### Option A — npx (recommended, once published)

No local clone or build. Reference it directly from your MCP client config
(see [Configuration](#configuration)):

```json
{ "command": "npx", "args": ["-y", "tie-mcp-server"] }
```

### Option B — from source

```bash
git clone <repo-url> tie-mcp-server
cd tie-mcp-server
npm install        # also builds via the `prepare` script
npm run build      # (re-run after any source change)
```

Then point your client at the built entry point, e.g.
`node /absolute/path/to/tie-mcp-server/build/index.js`.

### Option C — Docker

A multi-stage `Dockerfile` is provided for users who prefer not to install
Node locally. Build the image:

```bash
docker build -t tie-mcp-server .
```

Because the server speaks MCP over stdio, the container must be run
interactively (`-i`) with credentials passed as environment variables:

```json
{
  "command": "docker",
  "args": [
    "run", "-i", "--rm",
    "-e", "TIE_BASE_URL",
    "-e", "TIE_API_KEY",
    "tie-mcp-server"
  ],
  "env": {
    "TIE_BASE_URL": "https://customer.tenable.ad",
    "TIE_API_KEY": "your-api-key-here"
  }
}
```

> **Note:** This is a per-user local tool using **stdio** transport, so Docker
> Compose is not applicable (there is no long-running network service to
> orchestrate). Docker is offered only to bundle the Node runtime. If you need
> a centrally-hosted, multi-client gateway, that requires switching to MCP's
> HTTP/SSE transport first — see [Hosting as a shared service](#hosting-as-a-shared-service).

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
├── custom-tools.ts       # Hand-written convenience/discovery tools
└── generated/            # Auto-generated — do not edit by hand
    └── tools.ts          # 131 ToolDescriptor entries (name, method, path, schema)
```

### Generated vs Custom Tools

**Generated tools** (`src/generated/tools.ts`): One-to-one mappings of TIE API
endpoints. Regenerate whenever the TIE API spec changes:

```bash
npm run generate:tools
```

**Custom tools** (`src/custom-tools.ts`): Hand-written convenience tools that
compose multiple API calls or provide discovery/navigation helpers. These survive
regeneration and are merged with generated tools at server startup.

Current custom tools:
- **`get_topology`** - Returns Infrastructure→Directory hierarchy tree
- **`get_preferred_profile`** - Returns user's default profile from preferences

Custom tools follow the same `CustomTool` interface (`{name, description, category, 
safety, inputSchema, handler}`) and are dispatched alongside generated tools.

## Available Tools

The server exposes **133 tools total**:
- **131 generated tools** from `src/generated/tools.ts` (one per TIE API endpoint)
- **2 custom tools** from `src/custom-tools.ts` (convenience/discovery helpers)

See [TOOL_NAMING_CONVENTION.md](TOOL_NAMING_CONVENTION.md) for the naming scheme and
the (historical) 88-endpoint reference list.

### Discovery Tools

```typescript
// Get user's preferred profile (from preferences)
get_preferred_profile()
// Returns: { preferredProfileId: 2, preferredProfileName: "Contoso" }

// Get infrastructure→directory topology tree
get_topology()
// Returns: [{ id, name, directories: [{id, name, status}] }]
```

### Generated Tool Examples

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

## Hosting as a shared service

This server currently uses **stdio** transport: the MCP client spawns it as a
local child process. That model is correct for a per-user desktop tool and is
why distribution is via npm/npx (or a plain Docker image), not Docker Compose.

To instead run one **centrally-hosted** instance that many remote clients
connect to, the server would need to switch to MCP's streamable **HTTP/SSE**
transport (replacing `StdioServerTransport` in `src/index.ts` with the HTTP
server transport and adding a listening port). At that point it becomes a
standing network service, and Docker — optionally with Compose behind a reverse
proxy for TLS and authentication — becomes the appropriate deployment. This is
a deliberate, separate change and is not implemented today.

## API Documentation

- [API Endpoints](API_ENDPOINTS.md)
- [Tool Naming Convention](TOOL_NAMING_CONVENTION.md)
- [Authentication](AUTHENTICATION.md)
- [Architecture Options](ARCHITECTURE_OPTIONS.md)

## License

MIT — see [LICENSE](LICENSE).
