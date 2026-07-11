# TIE MCP — Session Handoff

_Last updated: 2026-07-11_

## Where we are

`tie-mcp-server` is built out through **v0.5.7** on `main` (clean tree, all PR
branches fast-forward merged + deleted). A separate consumer project,
`temp/tie-attack-report/`, is fully scaffolded, tested, and ready to move out.

## ⚠️ Two actions still pending (YOUR action)

1. **npm publish 0.5.7 is NOT done.** Registry still shows `0.5.6`
   (`npm view tie-mcp-server version` → `0.5.6`). The 0.5.7 publish earlier hit an
   auth/OTP error. The v0.5.7 code (native domain/OU name resolution in the graph)
   **is merged to `main`** — it's just not on npm. When ready, from
   `/Users/taher/Downloads/TIE_MCP` on `main`:
   ```
   ! npm publish
   ```
2. **Move the report project out of temp/** and git-init it:
   ```
   mv /Users/taher/Downloads/TIE_MCP/temp/tie-attack-report ~/tie-attack-report
   cd ~/tie-attack-report && git init
   ```
   It has its own `session_handoff.md`, `README.md`, and `.gitignore`.

## Version history (versions synced to PR numbers, 0.5.x line)

- v0.3.0 — in-memory query engine (no re-fetching pages)
- v0.3.1 — cache warming on by default; configurable TTL `TIE_CACHE_TTL_MS`
  (default 1 day = "fresh"); TTL surfaced to orchestrator; startup warm-up
  blocks first query until complete
- PR 4a (v0.5.0-ish) — SDDL parsing, control graph, Contains/GpoAppliesTo edges,
  DCSync scoped to domainDNS
- PR 4b (v0.5.0) — virtual `Controls` edge + domain-compromise traversal
  (A→B paths traverse *through* domain compromise; domain node kept)
- Phase 5a (v0.6.0 tag internally, but line stayed 0.5.x) — credential-weakness
  enrichment (breached/weak/reused)
- Phase 5b (v0.5.x) — `ReusedPassword` hub edges
- v0.5.6 — surface derived credential facts in output (`derived` block); README
  cross-capability prompts
- **v0.5.7 — `displayName()` resolves SID/GUID→domain/OU/leaf names natively in
  the graph (merged, NOT published to npm yet)**

## Architecture cheat-sheet

- **TIE API vocabulary:** profiles = lenses, infrastructures = forests,
  directories = domains. `objectId` is a **Tenable-specific ID, NOT an AD RID**
  (mistake made & corrected — Domain Admins was Tenable id 2013).
- **Query DSL** (`query_ad_objects`): lexer + recursive-descent parser,
  precedence NOT > AND > OR; `:` = contains (case-insensitive), also `=`, `>`,
  `<`, bitwise. `:` was removed from word-chars to fix a lexer conflict.
- **Control graph:** node keys are SID/GUID; bidirectional adjacency; BFS
  (`reachable`, `shortestPath`, `derivedTier0`); hub nodes avoid N×M blowup.
  `expandControls: off | toTargets | all`.
- **Edge kinds:** MemberOf, Owns, GenericAll/Write/WriteDacl/WriteOwner,
  AddMember, ForceChangePassword, AddKeyCredentialLink, DCSync, AllowedToDelegate,
  AllowedToAct, SIDHistory, GpLink, Contains, GpoAppliesTo, Controls (virtual),
  ReusedPassword.
- **Design principle:** "facts, not verdicts"; "self-contained edges";
  credential-less slice possible.

## `isweak` semantics (LOCKED — see memory file `tie-isweak-attribute-unknown.md`)

`isweak` value like `{"1":true,"2":true,"8":true}` → **keys are profile IDs**, NOT
hash types or password-list indices. `list_profiles`: 1=Tenable, 2=Contoso, 8=test
(user deleted profile "HATIM"=6 to confirm). We do an **OR across all profile
values**. Per Tenable, weak = matched a Company123-style password OR
empty/same-as-samAccountName. `credentialFactsFrom` implements the OR.

## Key source files (in src/)

- `graph/graph.ts` — `displayName()`, `byGuid`, `principalsByDomain`,
  domain-control helpers, `tier0Seeds`, `classify`, `resolveRef`
  (key/sid/dn/guid), reuse-cluster pass, synthetic-object skip.
- `graph/credentials.ts` — `hasObjectClass`, `isSyntheticObject`, `parseIsWeak`,
  `credentialFactsFrom` (OR-across-profiles), `reuseClusterFrom`, class consts.
- `graph/edges.ts` — `EdgeKind`/`RawEdge` (`fromRef`, `TargetRef` incl `'key'`),
  `attributeEdges`, `sddlEdges` (DCSync scoped to domainDNS), `parentDn`,
  `edgesForObject`, `nodeKeyFor`.
- `graph/{sddl,rights,schema-map,decode,traverse}.ts` — parser, rights tables,
  GUID map, decoder, BFS.
- `ad-object-store.ts` — store + credential enrichment fold (lower-cased keys,
  object-valued facts JSON-stringified), `buildGraph`/`getGraph`/`graphStatus`.
- `custom-tools.ts` — 8 custom tools; `presentObject` with `derived` block;
  `get_tier0`.

## Gotchas / lessons already paid for

- Enrichment "bug" during verification was a bad test harness using string `id`s
  which broke the **numeric** pagination cursor. Real enrichment works with
  numeric ids.
- `isweakByProfile` folded with camelCase key was unreachable (store lower-cases
  keys) → fixed to lower-case + JSON-stringify; regression test added.
- TTL-0 edge case → `isFresh` uses strict `<`.
- Choke recommender mis-fired on names containing `.` (`tinker.bell`) → uses a
  `domain_names` set now.

## Live tenant findings (middleeast, ~62k objects, ~35.7k nodes, ~405k edges)

Crown-jewel exposure: **493 non-privileged escalation paths → collapse to ~20
distinct routes; ~90% funnel through 2 choke points**: `tinker.bell` (445 source
users) and a 484-member shared-password cluster.
