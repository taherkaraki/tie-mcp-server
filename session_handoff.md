# TIE MCP — Session Handoff

_Last updated: 2026-07-27_

## Where we are

`tie-mcp-server` is on `main` at **v0.6.1** (clean tree, all PR branches
fast-forward merged + deleted). It's an MCP server for Tenable Identity Exposure:
131 auto-generated tools (1:1 with the TIE API) + **10 hand-written custom tools**.

## ⚠️ Pending action (YOURS)

- **npm publish 0.6.1** — registry still shows **0.6.0** (`npm view tie-mcp-server
  version`). v0.6.0 (identity-360) and v0.6.1 (parallel warm) are merged to `main`
  but NOT published. When ready, from repo root on `main`: `! npm publish`.
  (The consumer project `~/Downloads/tie-attack-report` links the server via
  `file:../../TIE_MCP`, so its adapter gets new server code on `npm run build`
  regardless of npm — but external `npx tie-mcp-server` users are stuck on 0.6.0.)

## Version history

- v0.3.0 — in-memory query engine (no re-fetching pages)
- v0.3.1 — cache warming on by default; TTL `TIE_CACHE_TTL_MS` (default 1 day)
- v0.5.x (PRs 4a/4b/5a/5b) — SDDL parsing, control graph, `Controls` virtual edge
  + domain-compromise traversal, credential-weakness enrichment, `ReusedPassword`
- v0.5.6 — surface derived credential facts (`derived` block)
- v0.5.7 — `displayName()` resolves SID/GUID→domain/OU/leaf names in the graph
- **v0.6.0 (PR #10) — identity-360 deviance view** (2 new tools + `DevianceStore`)
- **v0.6.1 (PR #11) — parallel AD-object warm scan (~2.5x)**

## The 10 custom tools (src/custom-tools.ts)

`get_topology`, `get_preferred_profile`, `query_ad_objects`, `get_ad_object`,
`get_blast_radius`, `get_control_paths`, `get_asset_exposure`, `get_tier0`,
**`get_identity_360`**, **`get_identity_360_summary`**.

## Architecture cheat-sheet

- **TIE vocab:** profiles = lenses, infrastructures = forests, directories =
  domains. `objectId` is a **Tenable-specific id, NOT an AD RID**.
- **Query DSL** (`query_ad_objects`): lexer + recursive-descent parser; precedence
  NOT > AND > OR; `:` = contains (case-insensitive), also `= > < ` + bitwise.
- **Control graph** (`src/graph/`): node keys SID/GUID; bidirectional adjacency;
  BFS (`reachable`, `shortestPath`, `derivedTier0`); hub nodes avoid N×M;
  `expandControls: off|toTargets|all`. Edge kinds: MemberOf, Owns, GenericAll/
  Write/WriteDacl/WriteOwner, AddMember, ForceChangePassword, AddKeyCredentialLink,
  DCSync (scoped to domainDNS), AllowedToDelegate, AllowedToAct, SIDHistory,
  GpLink, Contains, GpoAppliesTo, Controls (virtual), ReusedPassword.
- **Design principle:** "facts, not verdicts"; "self-contained edges".
- **Stores** (in-memory, TTL-cached, shared singletons via `configureStore`):
  - `ADObjectStore` — full AD snapshot; query engine + control graph live here.
  - `DevianceStore` (`src/deviance/`) — deviance index for identity-360.

## v0.6.0 — identity-360 (src/deviance/)

`get_identity_360` (single) + `get_identity_360_summary` (batch badges) return
every IOE deviance concerning an object across **3 layers**: `target` (filed on
it), `trustee` (it's the risky ACE principal embedded in ANOTHER object's finding
— parsed from DangerousAceList/MemberDn), `inherited` (from a container it sits
under, via the graph's Contains edges). Enriched with severity (raw O-CRITICITY +
Critical/High/Med/Low band) and remediation (raw + band), deeplinks into the TIE
UI + `id:"<adObjectId>"` filter hint. Disabled-checker deviances excluded by
default with a `summary.suppressed` tally. Files: `bands.ts` (tier mapping),
`trustees.ts` (ACE parsing), `deeplink.ts`, `joins.ts` (checker/reason/config
fetch), `store.ts`, `project.ts`, `inheritance.ts`, `identity360.ts`, `types.ts`.
Memory files: `tie-identity-360-design`, `tie-severity-remediation-bands`,
`tie-ioe-deeplink-format`. GOTCHA: `list_deviances_by_directory` caps perPage=500.

## v0.6.1 — parallel warm scan (src/ad-object-store.ts)

The cold-start AD scan was serial (~53s on middleeast). Now partitions the id
space into windows drained by a bounded worker pool: **2.54x** (53.2s→21.0s),
37,809 objects identical to sequential.
- **Cursor MUST come from `_links.next`** (page's max id), NOT `batch[last].id` —
  the returned array is NOT id-sorted; the old cursor only worked by luck on a
  sequential scan. `page()` parses it (absolute or relative URL).
- `fetchAllParallel()`: dynamic dispenser (window starts in `warmChunk` steps) ×
  `warmConcurrency` workers; unions into a **Map keyed by id** (overlap
  idempotent); **robust termination** — only stops dispensing at/above a window
  that saw `next==null`, so a sparse id gap can't falsely signal end.
- Knobs: `TIE_WARM_CONCURRENCY` (default **5** — rate-limit ceiling ~2.5x, >6 can
  be slower), `TIE_WARM_CHUNK` (default **5000**). Threaded via `StoreOptions`
  like `ttlMs`. Scope: fetch only — `buildGraph()` is CPU-bound, left for a
  separate worker-threads effort.

## `isweak` semantics (LOCKED — memory `tie-isweak-attribute-unknown`)

Value like `{"1":true,"2":true,"8":true}` → **keys are profile IDs**. `OR` across
all profile values. `credentialFactsFrom` implements it.

## Gotchas / lessons paid for

- `objectId` ≠ AD RID (Tenable-specific id; Domain Admins was id 2013).
- `isweakByProfile` folded with camelCase key was unreachable (store lower-cases
  keys) → lower-case + JSON-stringify.
- TTL-0 edge case → `isFresh` uses strict `<`.
- Parallel-scan cursor bug: using `batch[last].id` drops 23–40% of objects; must
  use `_links.next`. Fixed + regression-tested (fake client emits `_links.next`;
  count-sensitive tests pinned to `warmConcurrency:1`).

## Ecosystem

- **Exchange listing**: submitted to `tenable/cyberagents-exchange` (PR, slug
  `supercharged-tenable-identity-exposure-mcp-server`). Repo's own copy:
  `supercharged-tenable-identity-exposure-mcp-server.md`.
- **Consumer**: `~/Downloads/tie-attack-report` (own git repo) — attack-path
  reports with identity-360 overlay; has static (`build.py`) + live (`server/`
  adapter) modes. Its own `session_handoff.md` is current.

## Live tenant (middleeast, ~62k objects, ~35.7k nodes, ~405k edges, profile 2)

Crown-jewel exposure: ~493 non-privileged escalation paths → ~20 routes; ~90%
funnel through 2 choke points (`tinker.bell`, a 484-member shared-password
cluster). Deviance index ~8,615 deviances. (Tenant grows over time — live mode
now shows ~900 sources vs July's 493.)

## Test/build

`npm run build` (tsc), `node --import tsx --test tests/*.test.ts` (**173 tests**).
Tools regenerated from OpenAPI via `npm run generate:tools` (never hand-edit
`src/generated/tools.ts`; custom tools live in `src/custom-tools.ts`).
