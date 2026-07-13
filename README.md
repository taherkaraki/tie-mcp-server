# TIE MCP Server

Model Context Protocol (MCP) server for Tenable Identity Exposure API.

## Features

- Complete coverage of all 131 TIE API operations (one MCP tool per endpoint)
- Additional convenience tools for discovery, navigation, in-memory AD object
  search, permission decoding, control-graph attack-path analysis, and a
  per-identity **deviance 360 view** (9 custom tools)
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
- **Security-descriptor decoding.** AD permissions live in the
  `ntSecurityDescriptor` as a dense SDDL string (`O:...G:...D:(A;;CCDC...;;;S-1-...)`)
  that is unreadable to a model and useless for reasoning. `get_ad_object` can
  decode it on request into structured ACEs with **trustee SIDs resolved to
  names** (from the resident snapshot), **rights named** (`GenericAll`,
  `WriteDacl`, `ForceChangePassword`…), and **object-types resolved via the live
  schema** — turning "who can control this object?" into a readable answer
  instead of a 15 KB blob. See [Permission decoding](#permission-decoding).
- **Cross-object attack-path analysis.** Because the whole directory is resident,
  the server can build a *control graph* and answer questions no per-object API
  can: blast radius ("what can this account reach?"), shortest control paths
  ("how does X become Domain Admin?"), and asset exposure ("who can reach my
  Tier-0?"). Edges come from group membership, ACL rights, delegation, SID
  history and more. See [Attack-path analysis](#attack-path-analysis-control-graph).
- **Per-identity deviance 360.** Tenable files each Indicator-of-Exposure
  deviance against one object, so its own per-object view misses the cases where
  an identity is the *risky trustee* buried inside another object's finding, or
  inherits exposure from a container it sits under. `get_identity_360` resolves
  all three layers (target / trustee / inherited), joins in severity and
  remediation bands, and deep-links back into the Tenable UI — the exposure
  picture the console can't assemble on its own. See
  [Identity 360](#identity-360-deviance-view).
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
- **Weak / breached passwords among the privileged** — "privileged accounts with
  a breached password": `admincount>0 AND isbreached=true`, or a weak password
  under any profile's policy: `admincount>0 AND isweak=true`. (These come from
  TIE's password-hash analysis, joined onto the principal — see
  [Credential weakness](#credential-weakness).)
- **Stale but enabled accounts** — combine `enabled=true` with a
  `lastlogontimestamp` bound to surface dormant-yet-active identities.
- **Delegation risk sweep** — "accounts trusted for delegation":
  `useraccountcontrol:"TRUSTED_FOR_DELEGATION"`.
- **Fast pivot on one object** — "show me everything about Domain Admins":
  `get_ad_object({ samAccountName: "Domain Admins" })`, then follow its `member`
  list into further queries — all served from the same cached snapshot.

### Prompts that combine capabilities

The real leverage is chaining search, permission decoding, the control graph, and
credential weakness in one line of questioning. Natural-language prompts an
orchestrator can answer by composing these tools:

- *"Which non-privileged users can reach Domain Admins, and how?"* — `get_asset_exposure`
  from the Tier-0 preset (reverse), each with its shortest control path.
- *"If `bob` is phished, what's the blast radius?"* — `get_blast_radius({ principal: "bob" })`;
  follows group membership, ACL control, delegation, SID history, GPO, and
  password reuse.
- *"What's our true Tier-0 — everyone who can *become* admin, not just group
  members?"* — `get_tier0`, which returns built-in privileged groups **plus**
  de-facto Tier-0 with the escalation path for each.
- *"Who can DCSync the domain, and does any of them have a weak password?"* —
  `query_ad_objects("isweak=true")` intersected with the DCSync-capable principals
  surfaced by `get_tier0` / a path to the domain node.
- *"Show me the shortest way `helpdesk` could take over the `Administrator`
  account."* — `get_control_paths({ from: "helpdesk", to: "Administrator" })`;
  paths run *through* domain compromise when that's the real route.
- *"Who has dangerous rights on the Domain Admins object?"* —
  `get_ad_object({ samAccountName: "Domain Admins", decodeSecurityDescriptor: true })`
  to read the ACEs with trustees and rights resolved to names.
- *"Which admins have a breached OR reused password AND a path to a domain
  controller?"* — `query_ad_objects("admincount>0 AND isbreached=true")`, then
  `get_blast_radius` from each — reused-password clusters and the domain
  `Controls` edge do the reachability.
- *"Find accounts that are kerberoastable, privileged, and weak all at once."* —
  `query_ad_objects('admincount>0 AND serviceprincipalname:"/" AND isweak=true')`
  — the drop-everything findings, in one expression.
- *"What's the full exposure picture for `jaime.lannister` — everything Tenable
  flags on him, everywhere he's the risky party, sorted worst-first?"* —
  `get_identity_360({ samAccountName: "jaime.lannister" })`; returns his own
  deviances **plus** the ones where he holds dangerous rights over other objects
  **plus** what he inherits from his containers, each with a Tenable deeplink.
- *"For these 5 users on an attack path, show me each one's Critical/High/Medium/
  Low deviance counts."* — `get_identity_360_summary({ identities: [...] })` in a
  single call for the badges, then drill into any one with `get_identity_360`.

### Permission decoding

`ntSecurityDescriptor` is where AD stores who-can-do-what, but it arrives as raw
SDDL — a wall of ACE tokens and SIDs that no model can reason over. Pass
`decodeSecurityDescriptor: true` to `get_ad_object` to get it back as structured,
resolved facts:

```jsonc
get_ad_object({ samAccountName: "Domain Admins", decodeSecurityDescriptor: true })
// -> securityDescriptor:
{
  "owner": { "sid": "S-1-5-...-512", "name": "Domain Admins" },
  "aces": [
    { "effect": "Allow", "trustee": { "sid": "S-1-1-0", "name": "Everyone", "broad": true },
      "rights": ["ReadProperty"], "appliesTo": null, "inherited": true },
    { "effect": "Allow", "trustee": { "sid": "S-1-5-...-1105", "name": "bob.shaft", "broad": false },
      "rights": ["ControlAccess"], "appliesTo": "DS-Replication-Get-Changes-All" }
  ]
}
```

What the decoder does that a raw string can't:

- **Resolves trustee SIDs to names** using the in-memory snapshot (every object's
  SID is indexed), and flags broad principals (`Everyone`, `Authenticated Users`,
  `Anonymous`) with `broad: true`.
- **Names the rights** — `GenericAll`, `WriteDacl`, `WriteOwner`,
  `ForceChangePassword`, `AddMember`, etc. — and collapses the full-control token
  run to `GenericAll`.
- **Resolves object-type GUIDs via the live schema** already in the store (e.g.
  the two replication rights that together make up DCSync), so extended rights and
  attributes show up by name.
- Distinguishes **Allow / Deny**, marks **inherited** ACEs, and never throws on a
  malformed descriptor.

This is deliberately **facts, not verdicts** — it reports *who has which right*,
and leaves severity to you or to Tenable's Indicators of Exposure. It is also the
foundation for the control-graph analysis below; see
[docs/CONTROL_GRAPH_DESIGN.md](docs/CONTROL_GRAPH_DESIGN.md).

### Credential weakness

TIE runs a password-hash analysis and emits a `passwordHashScan` companion object
per analyzed principal. The server joins that signal back onto the principal (by
distinguished name), so credential weakness is directly queryable:

- `isbreached` — password appears in a breached-password set.
- `islmblank` / `isntblank` — blank LM / NT hash.
- `isweak` — derived boolean: weak under **at least one** profile's policy. The
  underlying signal is per-profile (a TIE profile is a configuration lens), and a
  password is "weak" when it matches a configured weak/dictionary password or is
  empty / equals the samAccountName. The raw per-profile breakdown is preserved
  as `isweakByProfile` (`{ profileId: bool }`) for finer questions.

```typescript
query_ad_objects({ expression: "isweak=true AND admincount>0" })       // weak-password admins
query_ad_objects({ expression: "isbreached=true" })                     // breached passwords
// weak specifically under profile 2 (fields are case-insensitive; the raw map
// is matched as a substring):
query_ad_objects({ expression: 'isweakByProfile:"\\"2\\":true"' })
```

Facts, not verdicts — TIE's Indicators of Exposure already score these findings;
this just makes them queryable alongside every other attribute (and, in a planned
step, usable as attack-path entry points).

### Attack-path analysis (control graph)

A single per-object question ("is this misconfigured?") is what Indicators of
Exposure answer. The harder, cross-object question — "by chaining permissions and
group memberships, **what can this account ultimately reach**, and **who can reach
my crown jewels**?" — is a graph problem. From the resident snapshot the server
builds a directed *control graph* whose edges come from both plain attributes and
decoded SDDL:

- membership (`MemberOf`, including `primaryGroupID` which `member` omits),
- `GenericAll` / `GenericWrite` / `WriteDacl` / `WriteOwner`, `AddMember`,
  `ForceChangePassword`, `AddKeyCredentialLink` (shadow creds),
- `DCSync` (both replication rights, scoped to the domain head), constrained
  delegation & RBCD, `SIDHistory`,
- `Contains` (container → child) and `GpoAppliesTo` (GPO → linked OU), so
  GPO-based control chains down to affected objects, and
- `Controls` (domain → in-domain principal): the "domain compromise owns
  everything in the domain" primitive, synthesized at query time so paths
  continue *through* a domain takeover to a specific target. Example:
  `unpriv → owns GPO → GpoAppliesTo OU → Contains user → DCSync → domain →
  Controls → Administrator`, and
- `ReusedPassword` (principal ↔ shared-password hub): principals sharing a
  password hash (from TIE's reuse analysis) cluster on a hub node, so
  compromising one reaches everyone who shares the credential.

Three tools traverse it — all shortest-path (BFS), depth/breadth-capped, and
cycle-safe:

```typescript
// Forward: if this account is compromised, what can it reach?
get_blast_radius({ principal: "bob", maxDepth: 6 })

// Targeted: how can X reach Y? Returns the edge chain.
get_control_paths({ from: "bob", to: "Domain Admins" })
// -> bob -MemberOf-> Helpdesk -GenericAll-> dcadmin -MemberOf-> Domain Admins

// Reverse: who can reach this asset / the Tier-0 set?
get_asset_exposure({})                       // Tier-0 preset (privileged groups)
get_asset_exposure({ targets: ["CN=FileServer01,..."] })

// Derived Tier-0: privileged groups PLUS everyone who can become privileged,
// each with its escalation path. "What is my true Tier-0 attack surface?"
get_tier0({})
```

Notes and honest limits:

- **Directory-control edges only.** This is the credential-less slice — it does
  *not* include logon sessions or local-admin (those need live host collectors,
  à la BloodHound). A path here is a directory-control path, so a 0-path result
  means "no control path", not "no attack path of any kind".
- **Facts, not verdicts.** Results report reachability and the exact edge chain,
  never a severity score.
- **Guardrails.** `maxDepth` (default 6) and `maxNodes` bound traversal, and a
  hit cap is reported as `truncated: "depth" | "nodes"` — never silently, since
  under-reporting in a security tool is dangerous.
- **On-demand build.** The graph is built from the in-memory snapshot with no
  extra API calls. Set `TIE_BUILD_GRAPH=true` to build it in the background at
  startup; otherwise the first graph query builds it (and may take tens of
  seconds on a large tenant). See [docs/CONTROL_GRAPH_DESIGN.md](docs/CONTROL_GRAPH_DESIGN.md).

### Identity 360 (deviance view)

Indicators of Exposure are how Tenable flags misconfigurations, but each deviance
is filed against exactly **one** object — usually the *victim*. That makes a
"what is this identity exposed to?" question surprisingly hard to answer from the
console, because the same identity can be dangerous or exposed in three different
ways that the per-object view never unifies. `get_identity_360` resolves all
three **layers** for one object:

1. **`target`** — deviances Tenable filed directly on the object (its own view).
2. **`trustee`** — deviances where the object is the *risky principal embedded in
   another object's finding* (e.g. the trustee inside a Dangerous-ACE list on a
   victim, or on a root partition). These never appear under the object in
   Tenable, because the deviance belongs to the victim.
3. **`inherited`** — deviances on a container / partition the object sits under,
   whose exposure inherits down; resolved by walking up the control graph's
   `Contains` edges (builds the graph on first use).

Each returned deviance is **self-contained and enriched**: checker + reason
metadata, the **severity** (raw `O-CRITICITY` *and* the Critical/High/Medium/Low
band), the **remediation cost** (raw *and* Low/Medium/High band), the related
`counterpart` object (for trustee/inherited layers), granted rights, resolved/
ignored state, and a **deeplink** into the Tenable IOE page plus a
`deeplinkFilterHint` (`id:"<adObjectId>"`) to narrow the on-page filter to the
exact object. Results are sorted worst-first (severity band, then raw criticity,
then remediation cost).

```typescript
// Full, sorted, deep-linked findings for one identity (all three layers).
get_identity_360({ samAccountName: "jaime.lannister" })

// Batch roll-up: per-identity counts by severity band (for report badges),
// NO full lists. Mix DN / SID / samAccountName / objectId; unresolved inputs
// come back flagged rather than failing the batch.
get_identity_360_summary({ identities: ["jaime.lannister", "S-1-5-...", 44656] })
```

Notes:

- **Severity is profile-specific.** `O-CRITICITY` and `O-ENABLED` are per-profile
  (and can be overridden per-directory); omit `profileId` to use your preferred
  profile. Deviances from checkers **disabled** in the profile/directory are
  excluded by default and reported in a separate `summary.suppressed` tally — so
  nothing is silently dropped.
- **Cached deviance index.** All deviances are scanned once (profile-scoped) and
  cached behind the same TTL as the object snapshot; `refresh: true` forces a
  rescan. The summary and detail tools share the index, so a badge from
  `get_identity_360_summary` always matches the expanded `get_identity_360` view.
- **Facts, not verdicts.** The tools translate Tenable's own numbers into bands
  and surface the relationships; they don't re-score risk.

### Freshness and caching

The snapshot is **cached for 1 day by default** (`TIE_CACHE_TTL_MS` to change
it) and is **not live** — it reflects the directory as of the last scan. This is
deliberate: a full scan is expensive, and AD/TIE state changes slowly relative to
a working session, so cheap reuse is the right default. Consequences to know:

- Every query/lookup response includes a `snapshot` block reporting the cache's
  object `count`, `ageMs`, and `ttlMs`, and both tool descriptions tell the model
  the data may be stale — so it can decide when currency matters.
- **To force current data, pass `refresh: true`** on `query_ad_objects` or
  `get_ad_object`. The classic trap: run a query, fix something in TIE, re-query,
  and see the *old* data because you didn't refresh.
- When the TTL lapses, the next query transparently rescans (no action needed).

> **Startup warming (on by default):** the full directory scan can take tens of
> seconds to ~100s on a large tenant. To keep that off the critical path, the
> server warms the snapshot **in the background at startup** — after `connect()`,
> so it never delays startup, and a query arriving mid-scan simply joins the
> in-flight build (no double scan). By the time you run your first search the
> cache is usually already warm. Two further points:
>
> - **Progress notifications.** If the MCP client attaches a `progressToken` to
>   a call that does trigger a scan, the server emits `notifications/progress`
>   once per fetched page (e.g. "Scanning AD objects: 12000 loaded (12 pages)"),
>   so a long scan isn't silent. Clients that don't request progress simply see
>   one longer tool call.
> - **Disabling warming.** Set `TIE_WARM_CACHE=false` to skip the startup scan —
>   useful on a tenant you never search, or to reduce load when running many
>   server instances. The snapshot then builds lazily on the first query instead.
>   A failed background warm (e.g. TIE unreachable at startup) is caught and logged,
>   and also falls back to lazy build — it never crashes the server.

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
- `TIE_WARM_CACHE` - Build the AD-object search snapshot at startup instead of on
  first query. On by default; set to `false` to disable (see
  [AD object search](#ad-object-search)).
- `TIE_CACHE_TTL_MS` - How long the AD-object snapshot stays fresh, in ms
  (default `86400000`, i.e. 1 day). Lower it to trade scan cost for freshness.
- `TIE_BUILD_GRAPH` - `true` to build the control graph (attack-path / blast-
  radius / asset-exposure edges) in the background after the snapshot warms. Off
  by default; adds CPU + memory. Query tools land in a later release.
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

The server exposes **139 tools total**:
- **131 generated tools** from `src/generated/tools.ts` (one per TIE API endpoint)
- **8 custom tools** from `src/custom-tools.ts` (`get_topology`,
  `get_preferred_profile`, `query_ad_objects`, `get_ad_object`,
  `get_blast_radius`, `get_control_paths`, `get_asset_exposure`, `get_tier0`)

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
