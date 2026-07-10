# TIE MCP Server

Model Context Protocol (MCP) server for Tenable Identity Exposure API.

## Features

- Complete coverage of all 131 TIE API operations (one MCP tool per endpoint)
- Additional convenience tools for discovery, navigation, and in-memory AD
  object search (4 custom tools)
- Client-side credential management for security
- Multi-tenant support (multiple TIE environments)
- Granular tool-level security controls
- Auto-generated tool definitions from the OpenAPI specification

## Why an MCP server instead of raw API calls?

A thin "call the endpoint" wrapper would just hand the raw TIE API to the model,
inheriting the API's shape and its rough edges. This server adds a layer that
turns the API into something an LLM can use effectively:

- **In-memory AD object search over a cached snapshot.** The TIE API has *no
  server-side filter* on `/api/ad-objects` — the only way to find an object by
  attribute is to page through the entire directory (tens of thousands of
  objects, dozens of requests). Done naively through the model, that means
  fetching megabytes of JSON into the context window and paging again on every
  question. Instead, `query_ad_objects` scans the directory **once**, builds a
  typed in-memory index, and answers expression queries against it in a few
  milliseconds — reused for ~10 minutes so follow-up questions are effectively
  free. A lookup that otherwise takes ~50 sequential API calls (and can't even be
  expressed as a filter) becomes one tool call. See
  [AD object search](#ad-object-search).
- **A real query language.** Attributes are decoded into typed values (numbers,
  booleans, arrays) so `admincount>0`, `badpwdcount>=5`, and
  `member:"dcadmin"` mean what you'd expect, and can be combined with
  `AND`/`OR`/`NOT`. The API returns everything as strings and offers no way to
  combine conditions at all.
- **Composed discovery tools.** `get_topology` and `get_preferred_profile`
  answer "what forests/domains exist?" and "which profile should I use?" in one
  call each, instead of the model having to stitch together `/infrastructures`,
  `/directories`, and `/preferences` and infer how they relate.
- **Context-window economy.** The model queries and gets back only matching
  objects (with a reported total and an optional `limit`), rather than ingesting
  the whole directory to filter it itself.
- **Guardrails.** Per-endpoint tools mean the client can allow/deny by name, and
  `TIE_ALLOWED_SAFETY` can advertise only read (or read+write) tools — a
  granularity you don't get by exposing one generic "call any endpoint" tool.

### Example use cases

Because search runs in memory, questions that would be impractical as ad-hoc API
paging become single natural-language asks. A few that map directly onto
`query_ad_objects` expressions:

- **Privileged accounts with weak hygiene** — "admins that have had bad password
  attempts": `admincount>0 AND badpwdcount>0`.
- **Kerberoast exposure** — "user accounts that have an SPN set":
  `serviceprincipalname:"/" AND type=LDAP` (any SPN contains a `/`).
- **Breached / reused passwords among the privileged** — "privileged accounts
  flagged with a breached password": `admincount>0 AND isbreached=true`.
- **Stale but enabled accounts** — combine `enabled=true` with a
  `lastlogontimestamp` bound to surface dormant-yet-active identities.
- **Delegation risk sweep** — "accounts trusted for delegation":
  `useraccountcontrol:"TRUSTED_FOR_DELEGATION"`.
- **Fast pivot on one object** — "show me everything about Domain Admins":
  `get_ad_object({ samAccountName: "Domain Admins" })`, then follow its `member`
  list into further queries — all served from the same cached snapshot.

> **First-query warm-up:** the first search in a ~10-minute window triggers the
> full directory scan and can take several seconds to tens of seconds on a large
> tenant (subsequent queries are milliseconds). Two things soften this:
>
> - **Progress notifications.** If the MCP client attaches a `progressToken` to
>   the call, the server emits `notifications/progress` once per fetched page
>   (e.g. "Scanning AD objects: 12000 loaded (12 pages)"), so a long first scan
>   isn't silent. Clients that don't request progress simply see one longer tool
>   call. Every response also includes a `snapshot` block with the cache's object
>   count and age.
> - **Optional startup warming.** Set `TIE_WARM_CACHE=true` to have the server
>   build the snapshot in the background at startup, so the first user query is
>   already fast. It's off by default — the scan is wasted work for sessions that
>   never search AD objects, and it doubles across multi-environment setups (each
>   server process scans its own tenant). Enable it for search-heavy,
>   single-environment deployments.

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

Optional environment variables:

- `TIE_ALLOWED_SAFETY` - Comma-separated safety tiers to advertise (`read`,
  `read,write`); see [Server-side safety filter](#server-side-safety-filter).
- `TIE_WARM_CACHE` - `true` to build the AD-object search snapshot at startup
  instead of on first query (see [AD object search](#ad-object-search)).
- `TIE_TIMEOUT` - Per-request timeout in ms (default `30000`).
- `TIE_MAX_RETRIES` - Max request retries (default `3`).

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
- **`query_ad_objects`** - Search all AD objects with a filter expression, run
  in memory over a cached snapshot (see [AD object search](#ad-object-search))
- **`get_ad_object`** - Look up a single AD object by DN, SID, or SAM account name

Custom tools follow the same `CustomTool` interface (`{name, description, category, 
safety, inputSchema, handler}`) and are dispatched alongside generated tools.

## Available Tools

The server exposes **135 tools total**:
- **131 generated tools** from `src/generated/tools.ts` (one per TIE API endpoint)
- **4 custom tools** from `src/custom-tools.ts` (convenience/discovery helpers)

See [TOOL_NAMING_CONVENTION.md](docs/TOOL_NAMING_CONVENTION.md) for the naming scheme and
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

### AD object search

`query_ad_objects` and `get_ad_object` solve a real limitation: the TIE API has
no server-side filter on `/api/ad-objects`, so the only way to find objects by
attribute is to page through the entire directory (tens of thousands of objects).
These tools do that scan **once**, build a typed in-memory snapshot, and reuse it
(TTL-cached, default 10 minutes) so subsequent searches run in a few milliseconds
without re-paging.

```typescript
// Filter expression: FIELD OP VALUE, combined with AND / OR / NOT and parentheses.
query_ad_objects({
  expression: '(admincount>0 AND useraccountcontrol:"NORMAL") OR badpwdcount>=5',
  limit: 50,          // optional; 0 = all. Total match count is always reported.
})

// Single-object lookup by DN, SID, or SAM account name.
get_ad_object({ distinguishedName: "CN=Domain Admins,CN=Users,DC=alsid,DC=corp" })
get_ad_object({ sid: "S-1-5-21-...-512" })
get_ad_object({ samAccountName: "Domain Admins" })
```

**Operators**

| Operator | Meaning |
| --- | --- |
| `=` `!=` | Equality / inequality — numeric when both sides are numbers, else case-insensitive string |
| `>` `>=` `<` `<=` | Ordering — numeric when both numeric, else lexical (case-insensitive) |
| `:` | Contains — substring for strings, membership for multi-valued attributes |
| `&` `\|` | Numeric bitwise test: `(attr OP value) != 0` |
| `AND` `OR` `NOT` | Boolean combinators; precedence `NOT` > `AND` > `OR`, override with `()` |

**Fields** are attribute names (case-insensitive), e.g. `admincount`, `cn`,
`member`, `useraccountcontrol`, `isbreached`, plus the identity fields `type`
(`LDAP`/`SYSVOL`), `directoryId`, `objectId`, `id`. Quote values containing
spaces: `cn:"Domain Admins"`. Multi-valued attributes match if **any** value
matches; a missing attribute never matches. Pass `refresh: true` to force a fresh
scan.

> **Note:** `useraccountcontrol` is exposed as decoded flag names
> (`"NORMAL DONT_EXPIRE"`), not the raw integer bitmask — test flags with the
> `:` contains operator (e.g. `useraccountcontrol:"DONT_EXPIRE"`), not `&`.

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

- [API Endpoints](docs/API_ENDPOINTS.md)
- [Tool Naming Convention](docs/TOOL_NAMING_CONVENTION.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Architecture Options](docs/ARCHITECTURE_OPTIONS.md)

## License

MIT — see [LICENSE](LICENSE).
