# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.6] - 2026-07-11

### Added
- **Server-derived credential facts now shown in tool output.** `query_ad_objects`
  and `get_ad_object` filter on the folded `isbreached` / `isweak` / `is*blank` /
  `isweakByProfile` fields, but those weren't visible in the returned objects
  (which show the raw API attributes). They now appear under a `derived` block so
  you can see *why* a credential filter matched, without altering the faithful
  `attributes` list.
- README: a "Prompts that combine capabilities" section with cross-tool
  natural-language use cases spanning search, permission decoding, the control
  graph, and credential weakness (the 0.3.0 → 0.5.5 feature arc).

## [0.5.5] - 2026-07-11

### Added (control graph, Phase 5b — behind `TIE_BUILD_GRAPH`)
- **`ReusedPassword` edges** from TIE's `passwordHashReuse` clusters (principals
  sharing a password hash). Modeled through a per-cluster **hub node**
  (`passwordReuseCluster`, e.g. "shared-password group (N members)") with
  bidirectional member↔hub edges, so "compromise one, reach all who share the
  hash" traverses without an N² edge blow-up. Members are resolved by
  `objectGuid`; a cluster with fewer than 2 in-scope members creates no hub.

### Added (credential-weakness enrichment, Phase 5a)
- **Password-analysis signal folded onto principals.** TIE emits `passwordHashScan`
  companion objects (one per analyzed principal, linked by `distinguishedName`);
  their signal is now joined onto the principal and exposed as queryable
  attributes, so `query_ad_objects` can filter on credential weakness directly —
  e.g. `isbreached=true AND admincount>0`, or `isweak=true`. Fields:
  `isbreached`, `isntblank`, `islmblank`, derived `isweak`, and `isweakByProfile`.
- **`isweak` semantics resolved.** The `isweak` map's keys are **profile IDs**
  (TIE config lenses); `isweak[profileId]` is whether the password is weak under
  that profile's policy (a configured weak/dictionary match, or empty / equals
  samAccountName). We expose a derived boolean `isweak` = **OR across all
  profiles** ("weak under at least one policy") plus the raw `isweakByProfile`
  map. New module `src/graph/credentials.ts`.

### Fixed (control graph — behind `TIE_BUILD_GRAPH`)
- **Synthetic analysis objects no longer become graph nodes.** `passwordHashScan`
  / `passwordHashReuse` objects share a principal's DN and were being admitted as
  nodes, producing bogus edges (e.g. fake `get_tier0` / Administrators members).
  They are now excluded from node admission, and a DN-collision guard prefers the
  real principal (has an objectSID) when two objects share a DN.

## [0.5.0] - 2026-07-11

### Added (control graph, Phase 4b — behind `TIE_BUILD_GRAPH`)
- **Virtual `Controls` edge** (domain → in-domain principal), synthesized at
  query time and never stored. This is the "domain compromise controls
  everything in the domain" primitive that lets attack paths continue *through*
  domain takeover to a specific target, e.g.
  `unpriv → GPO → OU → user → DCSync → domain → Controls → Administrator`.
- **Target-aware expansion** (`TraverseOptions.expandControls`): `off` (default),
  `toTargets` (synthesize only toward given targets — O(1) per domain, used by
  `get_control_paths` so A→B completes through domain compromise without
  enumerating the domain), and `all` (every in-domain principal, bounded by
  `maxNodes`, used by `get_blast_radius` and the reverse exposure / `get_tier0`
  tools). Reverse traversal treats a principal's controlling domain as an inbound
  predecessor, keeping DCSync-ers visible in exposure/derived-Tier0 now that
  `DCSync` terminates at the domain node.

### Changed (control graph, Phase 4a — behind `TIE_BUILD_GRAPH`)
- **`DCSync` edges scoped to the domain head.** Previously the templated
  replication ACE matched on many child objects, fanning one real capability into
  ~24 spurious `DCSync` edges per principal. Now `DCSync` is emitted only when the
  object carrying both replication rights is the domain (`objectclass` contains
  `domainDNS`). Non-domain objects keep their underlying `GenericAll`/rights
  edges, so no real control is lost. This makes any path through DCSync legible
  and blast-radius counts honest.

### Added (control graph, Phase 4a)
- **`Contains` edge** (container → child), derived from `distinguishedName`
  parentage — no extra API data. Lets control of an OU/container compose down to
  the objects it holds.
- **`GpoAppliesTo` edge** (GPO → linked OU/domain), the attack-useful inverse of
  the existing `GpLink`. Points at the linked container (not every object under
  it); `Contains` then chains the effect downward at traversal time, avoiding a
  GPO×objects fan-out.
- Edge assembly now resolves an edge's **source** by DN/key (not just SID), fixing
  latent mis-resolution of group-`member`-listed and container-sourced edges.

See `docs/CONTROL_GRAPH_DESIGN.md` §9. Query tools for these (the `Controls`
virtual edge + target-aware traversal) land in Phase 4b.

## [0.4.0] - 2026-07-11

### Added
- **Security-descriptor (SDDL) decoding.** `get_ad_object` accepts
  `decodeSecurityDescriptor: true` and returns the object's `ntSecurityDescriptor`
  parsed into structured ACEs: trustee SIDs resolved to names (from the resident
  snapshot), rights named (`GenericAll`, `WriteDacl`, `ForceChangePassword`, …,
  with the full-control token run collapsed to `GenericAll`), object-type GUIDs
  resolved via the live schema, allow/deny distinguished, inherited ACEs marked,
  and broad principals (Everyone/Authenticated Users/Anonymous) flagged. Facts
  only — no risk scoring. See docs/CONTROL_GRAPH_DESIGN.md.
- New `src/graph/` module: `sddl.ts` (defensive SDDL parser, never throws),
  `rights.ts` (right mnemonics, well-known SIDs/RIDs, extended-right GUIDs),
  `schema-map.ts` (GUID→name map built from the schema objects already in the
  store — no external tables, no extra API calls), and `decode.ts` (the
  human-readable decoder).
- Store now indexes objectSID→name and exposes `resolveSid`/`getSchemaMap`,
  rebuilt per snapshot generation.
- **Control-graph edge model + assembly** (Phase 2; behind `TIE_BUILD_GRAPH=true`).
  Derives typed control edges from BOTH plain attributes and the SDDL DACL/owner:
  `MemberOf` (incl. `primaryGroupID`, the attr `member`/`memberof` omit), `Owns`,
  `GenericAll`/`GenericWrite`/`WriteDacl`/`WriteOwner`, `AddMember` (WriteProperty
  on the member attribute, distinguished from generic write), `ForceChangePassword`,
  `AddKeyCredentialLink`, `DCSync` (both replication rights required), delegation
  (`AllowedToDelegate`/`AllowedToAct`), `SIDHistory`, and `GpLink`. `graph.ts`
  resolves DN/SID edge targets to nodes, keeps a **bidirectional** adjacency
  index (so reverse/exposure traversal is as cheap as forward), and counts
  out-of-scope/cross-domain references as `dangling` rather than dropping them.
  Built in the background *after* the attribute snapshot warms (never gates
  search), bound to the snapshot generation and invalidated on rebuild.
- **Control-graph query tools** (Phase 3): three new tools over the graph —
  `get_blast_radius` (forward: what a principal can reach), `get_control_paths`
  (shortest control path between two principals, as a named edge chain), and
  `get_asset_exposure` (reverse: who can reach an asset or the Tier-0 set).
  BFS shortest paths, `maxDepth`/`maxNodes` guardrails with honest `truncated`
  reporting, cycle-safe. The first graph query builds the graph on demand (so
  the tools work even without `TIE_BUILD_GRAPH`); a build still in flight
  returns a `notReady` status rather than a misleading empty result. Facts
  only — reachability and edges, no severity scoring.
- **`get_tier0`** — computes the *derived* Tier-0 set: the well-known privileged
  groups plus every principal that can *become* privileged by chaining control
  edges (de facto Tier-0). Each derived member carries the shortest escalation
  path to a privileged seed. Backed by a `derivedTier0` traversal helper
  (reverse-reachability from the seeds). Total tool count is now **139**
  (131 generated + 8 custom).

### Internal
- `docs/CONTROL_GRAPH_DESIGN.md` — design for the planned control graph (attack
  paths, blast radius, asset exposure); this release ships its Phase-1 foundation
  (SDDL parser + on-demand decoder). Test count 74 → 96.

## [0.3.1] - 2026-07-10

### Changed
- **AD-object cache warming is now on by default.** The startup scan runs in the
  background after `connect()`, so it never delays startup, and a query arriving
  mid-scan joins the in-flight build (no double scan) — there is no latency cost,
  only a faster first query. Set `TIE_WARM_CACHE=false` to opt out (e.g. a tenant
  you never search, or to reduce load across many instances); the snapshot then
  builds lazily on first use, and a failed background warm falls back to lazy
  build rather than crashing.

## [0.3.0] - 2026-07-09

### Added
- **In-memory AD object query engine** — two new custom tools that make
  attribute-based object lookup practical despite the TIE API having no
  server-side filter on `/api/ad-objects`:
  - `query_ad_objects` — search every AD object with a filter expression
    (`FIELD OP VALUE` combined with `AND`/`OR`/`NOT` and parentheses).
    Operators: `= != > >= < <=` (numeric when both sides are numbers, else
    case-insensitive string), `:` for contains/substring and array membership,
    and `&`/`|` for numeric bitwise tests. Example:
    `(admincount>0 AND useraccountcontrol:"NORMAL") OR badpwdcount>=5`.
  - `get_ad_object` — look up a single object by `distinguishedName`, `sid`, or
    `samAccountName`.
- **Cached object store** (`src/ad-object-store.ts`) — one full paginated scan
  builds an in-memory snapshot (TTL-cached, default 1 day, configurable via
  `TIE_CACHE_TTL_MS`) that every query and lookup reuses, so the directory is not
  re-paged on each request. Attributes are decoded per `valueType` into typed
  values; identity fields (`type`, `directoryId`, `objectId`, `id`) are queryable
  alongside attributes. The snapshot is not live; pass `refresh: true` to force a
  rescan. Every response's `snapshot` block reports `count`, `ageMs`, and `ttlMs`,
  and both tool descriptions advertise the caching so the client knows when to
  refresh.
- **Scan progress notifications** — when the MCP client attaches a
  `progressToken`, `query_ad_objects`/`get_ad_object` emit
  `notifications/progress` once per fetched page during the initial scan, so a
  long first search isn't silent.
- **Optional startup cache warming** — set `TIE_WARM_CACHE=true` to build the
  snapshot in the background at startup so the first query is fast. Off by
  default (the scan is wasted for sessions that never search AD objects and
  doubles across multi-environment setups).

### Changed
- `query_ad_objects` now parses the expression *before* scanning, so an invalid
  expression fails immediately instead of after a full directory scan.

### Internal
- New `src/query/` module: `value.ts` (attribute normalization), `lexer.ts`,
  `parser.ts` (recursive descent, precedence `NOT > AND > OR`), `evaluate.ts`.
- Added test suites for value normalization, parsing, evaluation, and the store
  (paging, TTL, cache reuse, lookups). Total tool count is now **135**
  (131 generated + 4 custom).

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
