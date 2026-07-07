# Session Handoff - TIE MCP Server Project

## Project Context
Building an MCP (Model Context Protocol) server for Tenable Identity Exposure API. The server exposes all **131 TIE API operations** as MCP tools (one tool per endpoint) for use with Claude and other MCP clients.

> **Count correction:** Earlier docs said "88 tools." That was the *path* count. The spec has 88 paths but **131 operations** (many paths have GET+POST+PATCH+DELETE). The architecture is one tool per operation, so there are 131 tools. The "88" list in TOOL_NAMING_CONVENTION.md is kept as a naming reference only.

## Current State

Fully built, working, and published as **tie-mcp-server@0.2.1**. GitHub repo at
https://github.com/taherkaraki/tie-mcp-server (public). PRs #1 (deviance naming
fix) and #2 (discovery tools) merged. **133 tools total** (131 generated + 2 custom).

### ✅ Completed Work
1. **Tool generator** - `scripts/generate-tools.mjs` parses the OpenAPI spec -> `src/generated/tools.ts` (131 descriptors). Re-run with `npm run generate:tools`.
2. **Generic dispatcher** - `src/dispatch.ts` turns any descriptor + args into an HTTP call.
3. **Server** - `src/index.ts` registers tools and routes calls. `TIE_ALLOWED_SAFETY` env var (e.g. `read` / `read,write`) filters by risk tier.
4. **Packaging** - npm publish config, MIT LICENSE, multi-stage Dockerfile, .dockerignore. Docker image NOT build-verified (no daemon access in sandbox).
5. **POST-read fix (PR #1, merged)** - deviance POST endpoints that read (summary "Get all…"/"Search…") now named list_/search_ with `read` safety instead of create_/write. `list_deviances_by_checker` etc.
6. **Discovery tools (PR #2, merged; v0.2.0)** - `src/custom-tools.ts` with `get_topology` + `get_preferred_profile`; profile scope hints baked onto 22 `{profileId}` tools; `src/index.ts` merges custom + generated tools (custom handlers dispatch first, else generic `dispatchTool`). README architecture section documents the custom-tools home.
7. **Schema fix (v0.2.1)** - added `additionalProperties: false` to custom tool input schemas (JSON Schema draft 2020-12 compliance; fixes Claude Desktop "400 ... input_schema is invalid").

### 📚 Reference — TIE data model (keep for future work)

The discovery tools were built from this understanding; retained as context.

- **Topology axis (real containment):** Infrastructure (Forest) → Directory (Domain).
- **Configuration axis (lenses, NOT containers):** Profile → per-checker options → customizations. A profile is a selectable *view*; one is "preferred". `profileId` in a path means "view this forest/domain through this config lens", NOT that the profile owns the infrastructure.
- Checker option = `{codename, value, valueType, directoryId}`. `directoryId: null` = global/default customization; `directoryId: <number>` = targeted at a specific domain (one customization can target an array of domains).
- **Preferred profile** = `preferredProfileId` from `GET /api/preferences` (returns `{language, preferredProfileId}`). This is the correct default profile.
- `GET /api/directories` returns `infrastructureId` + `infrastructureName` on each domain (so topology needs no manual join).

**Implementation notes (as shipped):**
- `src/custom-tools.ts` — `CustomTool` interface `{name, description, category, safety, inputSchema, handler}`. Two tools:
  - `get_topology` — `list_infrastructures` + `list_directories` → Forest→Domain tree with IDs. read.
  - `get_preferred_profile` — `get_preferences` → preferredProfileId + name from `list_profiles`. read.
- `scripts/generate-tools.mjs` — `PROFILE_SCOPE_HINT` appended to the description of any tool whose path contains `{profileId}` (22 tools). Baked in at generation time so it survives regeneration.

> **Note on git/network:** git push / gh / npm publish MUST run in the user's terminal — Claude's command sandbox egress is proxy-blocked to non-Anthropic hosts (incl. github.com and the npm registry).

### 📁 Repository Location
```
/Users/taher/Downloads/TIE_MCP   (branch: main)
```

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | MCP SDK support, type safety |
| Architecture | One tool per operation (131 generated + 2 custom = 133) | Granular security filtering |
| Authentication | Client-side env vars | Security - no credentials in server |
| Scope | Complete (all 131 operations) | Full API coverage |
| Code Generation | Auto-generate from OpenAPI | Maintainability, accuracy |

## Important Files

### Documentation (Read These First)
- `CURRENT_STATUS.md` - Detailed project status
- `PROJECT_PLAN.md` - Overall plan and decisions
- `AUTHENTICATION.md` - Security model and credential flow
- `IMPLEMENTATION_PLAN.md` - Phase-by-phase development plan
- `NETSKOPE_NPM_FIX.md` - Solving the npm blocker

### Source Code
- `src/index.ts` - MCP server entry point
- `src/client.ts` - TIE API HTTP client
- `src/config.ts` - Environment variable loader
- `package.json` - Dependencies and scripts

### API Spec
- `identity-exposure-openapi.json` - Full OpenAPI spec (261KB)
- `API_ENDPOINTS.md` - All 88 endpoints documented

## Possible Next Steps

The project is shipped; there is no required work outstanding. Optional follow-ups:

### Integration test against a live TIE instance
Add to Claude Code / MCP client config with real `TIE_BASE_URL` + `TIE_API_KEY`
and exercise a few tools (`get_about`, `list_profiles`, `list_checkers`,
`get_topology`, `get_preferred_profile`).

### Regenerate tools if the API spec changes
```bash
npm run generate:tools   # rewrites src/generated/tools.ts from the OpenAPI spec
npm run build
```
Custom tools in `src/custom-tools.ts` and the profile scope hints survive regeneration.

### (Optional) Generate API response types
```bash
npm run generate:client   # src/generated/api-types.ts via openapi-typescript
```

### (Optional) HTTP/SSE transport
For a centrally-hosted, multi-client deployment, switch from stdio to MCP's
HTTP/SSE transport — see README "Hosting as a shared service".

## Git Repository Info
- **Branch**: main
- **Remote**: https://github.com/taherkaraki/tie-mcp-server (public)
- **Latest Release**: v0.2.1
- **Git User**: taherkaraki <mtaher@gmail.com>

## Environment Requirements
- Node.js 18+ (currently v26.4.0)
- npm or compatible package manager
- TIE instance credentials for testing (TIE_BASE_URL, TIE_API_KEY)

## Critical Context

### Security Model
**Credentials stay on client side** - never stored in MCP server code. Users configure via MCP client settings:
```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/path/to/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer.tenable.ad",
        "TIE_API_KEY": "key"
      }
    }
  }
}
```

### Tool Architecture
**NOT using smart grouping** - each API endpoint = one tool for granular permission control. Organizations can filter dangerous operations (delete_*, update_*) separately from safe reads (get_*, list_*).

### Type Generation
**Build-time only** - generate once from OpenAPI spec, commit to git. Not needed at runtime. Re-run only when TIE API updates.

## Open Questions
1. Is there access to a live TIE instance for integration testing?
2. Any specific TIE API endpoints/workflows to prioritize for further custom tools?

## Contact
- **Project Owner**: taherkaraki <mtaher@gmail.com>
- **Started**: 2026-07-06
- **Last Session**: 2026-07-07

---

**Bottom Line**: Shipped as v0.2.1 — 133 tools, published to npm, repo public.
