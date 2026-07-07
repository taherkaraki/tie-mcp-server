# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-07-07

### Changed
- Extracted the `TIE_ALLOWED_SAFETY` tool filter into `src/filter.ts` (internal
  refactor; behavior unchanged) so it can be unit-tested independently.
- README documentation links now point into the `docs/` directory.

### Internal
- Added a test suite (`node:test` via `tsx`) covering the dispatcher, generated
  tool descriptors, custom tools, and the safety filter.
- Added GitHub Actions CI (Node 20/22: typecheck, lint, build, test) and an
  ESLint v9 flat config.

## [0.2.1] - 2026-07-07

### Fixed
- **JSON Schema Validation Error**: Added `additionalProperties: false` to custom tool input schemas to comply with JSON Schema draft 2020-12 specification
- Resolves "API Error: 400 tools.168.custom.input_schema: JSON schema is invalid" in Claude Desktop

## [0.2.0] - 2026-07-07

### Added
- **Discovery Tools** - Two new custom convenience tools for multi-tenant navigation:
  - `get_preferred_profile` - Returns user's default profile from preferences
  - `get_topology` - Returns Infrastructure→Directory hierarchy tree with health status
- **Custom Tools Architecture** - New `src/custom-tools.ts` for hand-written tools that survive OpenAPI regeneration
- **Profile Scope Hints** - Added guidance to 22 tools with `{profileId}` parameters, steering Claude toward using `get_preferred_profile`

### Changed
- Tool architecture now supports both generated (131) and custom (2) tools, total: **133 tools**
- Tool dispatcher now checks custom handlers first, falls back to generic dispatcher
- README updated to document custom tools architecture

### Technical
- `src/custom-tools.ts` - New file with `CustomTool` interface
- `src/index.ts` - Merges custom + generated tools at startup
- `scripts/generate-tools.mjs` - Adds profile scope hints during generation
- `src/generated/tools.ts` - Regenerated with profile hints

## [0.1.1] - 2026-07-06

### Fixed
- Corrected naming for POST-but-read deviance endpoints (list_* instead of create_*)
- Changed safety tier from `write` to `read` for query-style POST endpoints

## [0.1.0] - 2026-07-06

### Added
- Initial release
- Complete coverage of 131 TIE API operations
- Auto-generated tool definitions from OpenAPI spec
- Generic dispatcher for HTTP requests
- Client-side credential management
- Granular tool-level security controls via `TIE_ALLOWED_SAFETY` env var
- Multi-tenant support
- Published to npm as `tie-mcp-server`

[0.2.2]: https://github.com/taherkaraki/tie-mcp-server/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/taherkaraki/tie-mcp-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/taherkaraki/tie-mcp-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/taherkaraki/tie-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/taherkaraki/tie-mcp-server/releases/tag/v0.1.0
