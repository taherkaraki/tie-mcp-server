# Session Handoff - TIE MCP Server Project

## Project Context
Building an MCP (Model Context Protocol) server for Tenable Identity Exposure API. The server exposes all **131 TIE API operations** as MCP tools (one tool per endpoint) for use with Claude and other MCP clients.

> **Count correction:** Earlier docs said "88 tools." That was the *path* count. The spec has 88 paths but **131 operations** (many paths have GET+POST+PATCH+DELETE). The architecture is one tool per operation, so there are 131 tools. The "88" list in TOOL_NAMING_CONVENTION.md is kept as a naming reference only.

## Current State

### ✅ Completed Work
1. **Project planning and architecture** - Documented in markdown files
2. **TypeScript project structure** - package.json, tsconfig.json, source files
3. **Core implementation files** - HTTP client, config loader, MCP server
4. **Tool generator** - `scripts/generate-tools.mjs` parses the OpenAPI spec and emits `src/generated/tools.ts` (131 descriptors). Re-run with `npm run generate:tools`.
5. **Generic dispatcher** - `src/dispatch.ts` turns any descriptor + args into an HTTP call. No per-endpoint handler code.
6. **Server wired** - `src/index.ts` registers all 131 tools and routes calls. Supports `TIE_ALLOWED_SAFETY` env var (e.g. `read` / `read,write`) to filter by risk tier.
7. **Git repository** - Initialized with commits documenting progress

### ⏳ Remaining (blocked on `npm install` only)
- `npm install` must be run in a normal terminal (Claude's sandbox blocks the npm registry). Node v26.4.0 / npm 11.17.0 confirmed working.
- After install: `npm run build` (tsc), then integration-test against a real TIE instance.
- All `.ts` files pass Node's native type-strip syntax check; a full `tsc` typecheck is pending `node_modules`.

### 📁 Repository Location
```
/Users/taher/Downloads/TIE_MCP
```

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | MCP SDK support, type safety |
| Architecture | One tool per endpoint (88 tools) | Granular security filtering |
| Authentication | Client-side env vars | Security - no credentials in server |
| Scope | Complete (all 88 endpoints) | Full API coverage |
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

## Next Steps (In Order)

### 1. Install Dependencies (REQUIRED — run in a normal terminal)
The tool generator and dispatcher are already written; the only blocker is that
Claude's command sandbox cannot reach registry.npmjs.org. Run this yourself:
```bash
cd /Users/taher/Downloads/TIE_MCP
npm install
```
Packages: `@modelcontextprotocol/sdk`, `axios`, `zod` + dev tools (TypeScript, ESLint, tsx, openapi-typescript).

### 2. Build & Typecheck
```bash
npm run typecheck   # tsc --noEmit — first real full typecheck
npm run build       # emits build/index.js
```
If `tsc` reports type errors, they'll most likely be in `src/dispatch.ts` or the
generated schema shape — fix and re-run.

### 3. (Optional) Regenerate tools if the API spec changes
```bash
npm run generate:tools   # rewrites src/generated/tools.ts from the OpenAPI spec
```

### 4. Integration Test
Add to Claude Code / MCP client config with real `TIE_BASE_URL` + `TIE_API_KEY`
and exercise a few tools (`get_about`, `list_profiles`, `list_checkers`).

### 5. (Optional) Generate API response types
```bash
npm run generate:client   # src/generated/api-types.ts via openapi-typescript
```

## Git Repository Info
- **Branch**: main
- **Remote**: Not configured yet
- **Last Commit**: "Document Netskope npm issue and project status"
- **Git User**: taherkaraki <mtaher@gmail.com>

## Environment Requirements
- Node.js 18+ (currently v26.4.0)
- npm or compatible package manager
- Access to npm registry (currently blocked)
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

## Estimated Time Remaining
- Phase 2 (types): 10 minutes
- Phase 3 (tool generation): 2-3 hours
- Phase 4 (integration): 1 hour  
- Phase 5 (testing): 1-2 hours
- **Total**: ~5-7 hours after npm access restored

## Questions to Ask User
1. Do you have access to a TIE instance for testing?
2. Can you get IT to whitelist npm registry, or should we use alternative network?
3. Any specific TIE API endpoints to prioritize?

## Contact
- **Project Owner**: taherkaraki <mtaher@gmail.com>
- **Started**: 2026-07-06
- **Last Session**: 2026-07-06

---

**Bottom Line**: Project foundation is solid.
