# Control Graph — Design (Phase 1: SDDL parser + edge model)

Status: **proposed** (nothing built yet). This document is the spec to build
against. Phase 1 covers the SDDL parser and the control-edge model — the
correctness-critical foundation. Phase 2 (traversal queries) is sketched at the
end for context but specced separately.

## 1. Goal and non-goals

**Goal.** Derive a directed *control graph* over the objects already resident in
the `ADObjectStore`, so an orchestrator can answer cross-object questions:

- **Blast radius** (forward): from a principal, what can it reach/compromise?
- **Attack paths** (forward, targeted): how does X reach Y?
- **Asset exposure** (reverse): who can ultimately reach a protected asset / the
  Tier-0 set?

All three are reads of one edge model, differing only by traversal direction and
start set (see §7).

**Non-goals (be explicit — this is the credential-less slice):**

- No `HasSession` / `AdminTo` / local-admin edges. Those require live collectors
  (SAMR, session enumeration) and are not in the directory. A "path" here is a
  *directory-control* path, never "owns a box where DA is logged in." This
  limitation must be surfaced in tool output so a 0-path result is not read as
  "no attack path exists at all."
- No risk *scoring* or severity verdicts. We emit **fact chains** ("X has
  WriteDacl on group Y, Y is MemberOf Domain Admins"); severity is the
  orchestrator's / Tenable IOE's job. This keeps the engine out of the
  unmaintained-security-oracle trap.

## 2. Lifecycle placement

A third derived layer after the existing two, built from the resident store with
**no extra API calls** (pure CPU over in-memory data):

| State        | Available                                   | Trigger                        |
|--------------|---------------------------------------------|--------------------------------|
| Cold         | nothing (or lazy)                           | server start                   |
| Warm         | attribute search (query_ad_objects, get_ad_object) | ~100s network scan finishes |
| Graph-ready  | path / blast-radius / exposure queries      | SDDL parse + closure finishes  |

Rules:
- Graph build **never gates attribute search**. It starts *after* warm completes.
- Opt-in via `TIE_BUILD_GRAPH=true` (off by default): tens of seconds of CPU +
  real memory, wasted on sessions that only do attribute search.
- **Graph is bound to a snapshot generation.** A new warm (TTL lapse or
  `refresh`) invalidates the graph, which rebuilds in the background. One source
  of truth.
- Its own progress notifications ("Building control graph: 12000/62000 parsed"),
  distinct from the scan's, so the orchestrator can tell "fetching from TIE" from
  "analyzing".

## 3. Module layout

Mirror the `src/query/` structure — small, single-purpose, heavily unit-tested.

```
src/graph/
├── sddl.ts        # SDDL string -> structured SecurityDescriptor (parser)
├── rights.ts      # SDDL right mnemonics + well-known SIDs + extended-right GUIDs
├── schema-map.ts  # builds schemaIdGuid/rightsGuid -> name map from store schema objects
├── edges.ts       # SecurityDescriptor + object attrs -> ControlEdge[]
├── graph.ts       # assemble edges, membership closure, bidirectional index
└── (phase 2) traverse.ts  # BFS/shortest-path over the graph
```

## 4. `sddl.ts` — the SDDL parser

The correctness-critical piece. Parses the SDDL string (the `ntsecuritydescriptor`
attribute value) into a structured descriptor. This is *parsing only* — no risk
judgment, no SID resolution.

### Input
The raw SDDL string, e.g.
`O:S-1-5-...-512G:S-1-5-...-512D:AI(OA;CIID;RP;...;S-1-5-11)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-...-512)...`

### Output shape
```ts
interface SecurityDescriptor {
  owner: string | null;        // SID from O:
  group: string | null;        // SID from G:
  dacl: Ace[];                 // parsed D: ACEs (SACL S: ignored for now)
  daclFlags: string[];         // e.g. ["AI"] (auto-inherited)
}

interface Ace {
  type: string;                // "A" allow, "D" deny, "OA" object-allow, "OD" object-deny
  isAllow: boolean;            // derived: type starts with A
  isObjectAce: boolean;        // OA/OD — carries object-type GUID(s)
  flags: string[];            // ["CI","IO","ID",...] inheritance/inherited flags
  rights: string[];           // decoded mnemonics: ["CC","DC","WP","GA","WDWO"...] split into tokens
  objectType: string | null;  // GUID (extended right / property-set / attribute), OA/OD only
  inheritedObjectType: string | null;
  trustee: string;             // SID the ACE applies to
  inherited: boolean;          // "ID" present in flags
}
```

### Parsing rules
- ACEs are the parenthesized groups after `D:`. Each ACE is 6 semicolon-separated
  fields: `ace_type;ace_flags;rights;object_guid;inherited_object_guid;trustee_sid`.
- `rights` field: either a hex mask (`0x...`) or concatenated 2-char mnemonics
  (`CCDCLCSWRPWPDTLOCRSDRCWDWO`). Split mnemonics into a token list; keep hex as a
  raw `mask` alongside for completeness.
- `flags`: 2-char tokens (`CI`,`OI`,`IO`,`ID`,`NP`,`SA`,`FA`). `ID` ⇒ inherited.
- Robustness: the parser must never throw on a malformed/truncated descriptor —
  return `{ owner:null, group:null, dacl:[], malformed:true }` and let the caller
  skip it (same defensive posture as `value.ts`). Log-count malformed descriptors
  for diagnostics.

### Test matrix (sddl.test.ts)
- Owner/group SID extraction.
- Plain allow ACE with combined-rights mnemonic → token split correct.
- Deny ACE → `isAllow:false`.
- Object ACE (`OA`) with object-type GUID and inherited-object-type GUID.
- Inheritance flags parsed; `ID` ⇒ `inherited:true`.
- Hex rights mask preserved.
- Malformed input → `malformed:true`, no throw.
- Real fixtures: the domain-root and a computer-object SDDL captured from the
  live tenant (large, many ACEs) parse without loss.

## 5. `rights.ts` + `schema-map.ts` — decoding what an ACE grants

An ACE's `rights` tokens + `objectType` GUID together decide *what* the trustee
can do. Two lookups feed this:

### `rights.ts` — static tables (checked into source)
- **Right mnemonics** → meaning: `GA`=GenericAll, `GW`=GenericWrite, `WD`=WriteDacl,
  `WO`=WriteOwner, `WP`=WriteProperty, `RP`=ReadProperty, `CC`=CreateChild,
  `SW`=Self/validated-write, `CR`=ControlRight (extended), etc. Also the combined
  full-control token sequence `CCDCLCSWRPWPDTLOCRSDRCWDWO`.
- **Well-known SIDs** → label + a `broad` flag: Everyone `S-1-1-0`,
  Authenticated Users `S-1-5-11`, Anonymous `S-1-5-7`, plus well-known RIDs
  (Domain Admins `-512`, Enterprise Admins `-519`, DC `-516`, etc.). `broad`
  marks principals that should essentially never hold write/control.
- **Interesting extended-right / attribute GUIDs** (the edge triggers):
  - `00299570-246d-11d0-a768-00aa006e0529` — User-Force-Change-Password
  - `1131f6aa-9c07-11d1-f79f-00c04fc2dcd2` — DS-Replication-Get-Changes
  - `1131f6ad-9c07-11d1-f79f-00c04fc2dcd2` — DS-Replication-Get-Changes-All (DCSync)
  - `bf9679c0-0de6-11d0-a285-00aa003049e2` — `member` attribute (AddMember)
  - `5b47d60f-6090-40b2-9f37-2a4de88f3063` — `msDS-KeyCredentialLink` (shadow creds)

### `schema-map.ts` — derived from the resident store (the elegant part)
The schema objects are *already in the store* (`type=LDAP`, under
`CN=Schema,CN=Configuration`). They carry `schemaidguid` (attributes/classes) and
`rightsguid` (control-access-rights). So we build the GUID→name map **from memory,
with no external tables and no extra API calls** — self-contained and accurate to
*this* forest's schema. `rights.ts` holds only the small set of well-known GUIDs
we key edges on; `schema-map.ts` covers the long tail for human-readable decode.

## 6. `edges.ts` — from descriptor to control edges

An edge means "source principal can perform a control action on target object."
For each object in the store, combine its parsed DACL + owner + relevant
attributes and emit typed edges. Only **allow** ACEs to a **non-self, resolvable**
trustee produce edges (deny ACEs and `SELF` `S-1-5-10` are skipped in v1).

### Edge type
```ts
interface ControlEdge {
  from: string;                // trustee SID (who has the power)
  to: string;                  // object SID/GUID (what it applies to)
  kind: EdgeKind;              // see table
  source: 'dacl' | 'owner' | 'member' | 'attribute';
  aceRights?: string[];        // provenance: the tokens/GUID that produced it
  inherited?: boolean;
}
```

### Edge derivation table

| EdgeKind          | Derived from                                                        |
|-------------------|---------------------------------------------------------------------|
| `MemberOf`        | `member` attribute (target is the group) — **transitive in closure**|
| `Owns`            | SDDL owner field                                                    |
| `GenericAll`      | rights include `GA` or the full-control combined sequence           |
| `GenericWrite`    | rights include `GW`                                                  |
| `WriteDacl`       | rights include `WD`                                                  |
| `WriteOwner`      | rights include `WO`                                                  |
| `AddMember`       | `WP` on the `member` attribute GUID (object ACE)                    |
| `ForceChangePassword` | `CR` on the User-Force-Change-Password extended-right GUID       |
| `AddKeyCredentialLink`| `WP` on the `msDS-KeyCredentialLink` GUID (shadow creds)         |
| `DCSync`          | `CR` on Get-Changes **and** Get-Changes-All (on the domain head)    |
| `AllowedToDelegate`   | `msds-allowedtodelegateto` present (constrained delegation)     |
| `AllowedToAct`    | `msds-allowedtoactonbehalfofotheridentity` (RBCD)                  |
| `GpLink`          | `gplink` — OU/domain → GPO                                          |

### Semantics precision (where the string-contains screen could NOT go)
- **WriteProperty is not monolithic.** `WP` on the whole object (no objectType) ⇒
  a broad `GenericWrite`-ish edge; `WP` on the `member` GUID specifically ⇒
  `AddMember`. The object ACE's `objectType` GUID is what disambiguates — this is
  precisely why we need the real parser, not substring matching.
- **Allow/deny precedence:** v1 emits edges only from allow ACEs and does not
  model deny-overrides-allow. Documented limitation; revisit if it causes
  false paths.
- **DCSync requires BOTH replication rights**, so it's computed per-trustee across
  that object's ACEs, not per-ACE.

### Test matrix (edges.test.ts)
- Each EdgeKind emitted from a minimal fixture ACE/attribute.
- `WP`-on-member ⇒ `AddMember`, **not** generic write.
- Full-control combined sequence ⇒ `GenericAll`.
- DCSync only when both replication GUIDs present for the same trustee.
- `SELF`/self-trustee and deny ACEs produce no edge.
- Owner field ⇒ `Owns` edge.

## 7. `graph.ts` — closure, indexing, and the three lenses

### Membership closure (the correctness-critical bit)
- Expand `MemberOf` transitively so an ACE granting a group implicitly grants its
  nested members. **Cycle detection** required (AD group nesting can loop).
- Include **primaryGroupID** membership — the `member` attribute does NOT list
  primary-group members (classic miss; e.g. Domain Users, Domain Computers).
- **Cross-domain:** SIDs resolve against the *whole* resident store (all
  directories), so foreign-security-principal edges (`tcorp` ↔ `alsid`) resolve
  for free. Care: a SID resolving in another directory must not dead-end the
  traversal. This is a closure/resolution detail, handled here.

### Bidirectional index (bake in from the start)
Store each edge in **both** a forward adjacency map (`from → edges`) and a reverse
adjacency map (`to → edges`). This is what makes **asset exposure (reverse
traversal) as cheap as blast radius (forward)** — retrofitting later is painful.
Small memory cost.

### The three lenses — one engine, direction + start set differ

| Query (Phase 2)                    | Direction | Start set        | Answers                          |
|------------------------------------|-----------|------------------|----------------------------------|
| `get_blast_radius({principal})`    | forward   | one principal    | what can X reach/compromise?     |
| `get_control_paths({from,to})`     | forward   | pair             | how does X reach Y?              |
| `get_asset_exposure({targets})`    | **reverse** | asset / Tier-0 | who can reach this asset?        |

### Defining "Tier-0" (target set for exposure)
`targets` accepts explicit principals **or** a named preset:
- `"domain-admins"` — DA/EA/DCsync-capable well-known set.
- `"tier0-derived"` (DONE — see `get_tier0` + `derivedTier0` in traverse.ts):
  computed *by the graph* as reverse-reachability from the privileged seeds —
  anything with a control path to a privileged group. Catches *de facto* Tier-0
  (not in a privileged group but trivially able to become privileged); each
  member carries its shortest escalation path.
- explicit DNs/SIDs — exposure of any arbitrary asset (a file server, a service
  account, an OU), since exposure isn't only a Tier-0 question.

### Traversal guardrails (Phase 2, but fix the contract now)
- `maxDepth` optional, **default cap ~6** (covers real AD paths; unbounded is an
  explicit opt-in). Depth is shallow-but-wide in AD — breadth is the real cost.
- `maxNodes` result cap — the second guardrail against fan-out explosion (e.g. an
  `AddMember`→Domain Users edge reaching every user in one hop).
- **Truncation honesty:** if a cap is hit with paths still expanding, the response
  says so (`truncatedAtDepth`/`truncatedAtNodes`, `reachedNodes`). Silent
  truncation reads as "nothing further exists" — dangerous in a security tool.
- Build cost vs. query cost are separate: building edges+closure is the one-time
  heavy hit (bounded by `TIE_BUILD_GRAPH` + post-warm sequencing); individual
  queries are fast in-memory traversals, and `maxDepth`/`maxNodes` protect
  *query-time* work and result size.

## 8. Build order (separate PRs)

1. **PR 1 (DONE) — `sddl.ts` + `rights.ts` + `schema-map.ts` + `decode.ts`** with
   full unit tests and a live-tenant-shaped fixture. The parser + decode
   foundation. Also delivers the on-demand
   **`get_ad_object({ decodeSecurityDescriptor: true })`** decoder — immediately
   useful, independent of the graph.
2. **PR 2 (DONE) — `edges.ts` + `graph.ts`** (multi-source edge model +
   assembly with DN/SID resolution and bidirectional index) behind
   `TIE_BUILD_GRAPH`, wired into the post-warm lifecycle with its own progress
   logging and a `graphStatus()` state (absent/building/ready). No queries yet.
   NOTE: transitive membership closure is done at *query time* by BFS following
   `MemberOf` edges (PR 3), not materialized at build — precomputing it would be
   redundant with traversal.
3. **PR 3 (DONE) — `traverse.ts` + tools** `get_blast_radius`,
   `get_control_paths`, `get_asset_exposure`. BFS over the bidirectional graph
   (shortest paths), `maxDepth`/`maxNodes` guardrails with honest `truncated`
   reporting, cycle-safe. Graph queries build the graph on demand (first call
   pays the cost) and return a `notReady` status if a build is still in flight.
   Exposure supports explicit targets or a built-in Tier-0 preset (privileged
   RIDs 512/518/519/520 + BUILTIN Administrators)."

Rationale for splitting: the parser's edge-semantics tests are where the real
correctness risk lives and deserve their own review, uncoupled from traversal.

## 9. Phase 4 — full attack paths (domain hub, containment, GPO scope)

Status: **proposed**. PR 1–3 chain DACL rights + upward `MemberOf` + DCSync, which
is enough for "who can reach Tier-0". It is NOT enough for a full
`unprivileged user → crown-jewel member` narrative: several hops are missing, and
DCSync currently fans out. Phase 4 closes this.

### 9.1 The guiding invariant (agreed)

**Every edge must be self-contained: its meaning is a property of `(from, to)`
alone, readable without knowing how you arrived.** This is what makes a path
composable. It is why we do NOT put a `SyncsCredentials`-style edge on
`domain → object` (that relationship only exists *because* a DCSync preceded it —
path-dependent, so wrong). Instead the meaning splits cleanly across two
self-contained edges joined by the domain node:

```
user -DCSync-> alsid.corp -Controls-> nodeB
```

- `DCSync` (principal → domain): "can replicate/steal all secrets of this domain."
  Self-contained; terminates at the domain because that is the object the
  replication rights are an ACE on.
- `Controls` (domain → in-domain object): "domain authority ⇒ full control of this
  object." Self-contained; true regardless of how the domain was reached.

### 9.2 Why the domain stays a first-class node (not collapsed)

Collapsing to `user -DCSync-> nodeB` was considered and rejected:

1. **Breaks the invariant** — `DCSync` on `user → nodeB` is meaningless in
   isolation (DCSync is by definition "replicate *the domain*"); it only reads if
   you remember the omitted domain step. Path-dependent = disallowed.
2. **Re-creates the N×M fan-out** we scoped DCSync to avoid. The domain is an
   articulation point: N compromise-primitives in, M controlled objects out. Keep
   the node → **N + M** edges. Collapse it → **N × M**. Same combinatorial blow-up
   we just eliminated.
3. **It's a real object and a genuine convergence hub** — many primitives
   (DCSync, WriteDacl-on-domain-object, owning the domain head, owning a DC) all
   mean "domain compromise" and should meet at one node, preserving *why* the
   takeover happened. A collapsed edge cannot say which primitive was used.

Generalizes: keep any high-convergence node (groups, GPOs, OUs); never
pre-collapse its transitive effects into N×M direct edges.

### 9.3 New edges

| EdgeKind        | from → to                              | Self-contained meaning |
|-----------------|----------------------------------------|------------------------|
| `Contains`      | container (OU/CN/domain) → child object | LDAP containment; parent's controllers control the child |
| `GpoAppliesTo`  | GPO → object in a linked OU/domain scope | the GPO's settings apply to (can control) that object |
| `Controls`      | domain → security principal in that domain | domain authority ⇒ full control (VIRTUAL — see 9.5) |

- **`DCSync` is scoped to the domain node** (the small fix): emit the `DCSync`
  edge only when the object carrying both replication rights is the domain head
  (`objectclass` contains `domainDNS`). On any non-domain object, the underlying
  `GenericAll`/rights edges we already emit still cover it — nothing is lost, but
  we stop labeling ~24 templated child-object ACEs as "DCSync".
- **`GpoAppliesTo`** is the attack-useful direction (GPO → affected objects),
  derived from an OU's `gplink` + that OU's containment scope. Note this is the
  inverse of the existing `GpLink` (OU → GPO) edge, which we keep for provenance.
- **`Contains`** comes from `distinguishedName` parentage (the child DN is the
  parent DN plus one RDN) — no extra API data needed.

### 9.4 `Controls` boundary (semantic correctness)

`Controls` targets are exactly the security principals whose **SID domain equals
the domain node's SID** (users/computers/groups *in that domain*). A
foreign-domain object that merely appeared in an ACE is NOT controlled by this
domain; cross-domain reach is modeled only where a real trust path exists. This
keeps `Controls` self-contained and prevents false cross-domain takeover claims.

### 9.5 Traversal rules — target-aware expansion (kills the fan-out)

`Controls` is **virtual: never materialized/stored.** It is expanded at query
time, differently per lens, so the domain→everyone expansion never actually
exists as edges:

| Query | On reaching a domain node |
|-------|---------------------------|
| `get_control_paths(A → B)` (targeted) | Check only whether **B** is an in-domain principal; if so synthesize the single `domain -Controls-> B` hop and complete the path. **O(1)** — no enumeration. |
| `get_blast_radius(A)` (open-ended) | Domain reached ⇒ owns everything. Return a **summarized** `domain -Controls-> (all N in-domain principals)` annotation, optionally enumerated up to `maxNodes` — never a silent N-edge dump. |
| `get_asset_exposure(B)` (reverse) | Traverse `Controls` backward: whoever can compromise B's domain is exposed to B. Same in-domain rule. |

Key consequence (resolves the "terminal vs through" debate): the domain is **not**
a hard terminal. For a targeted A→B query, if B is reachable *through* domain
compromise, the path MUST continue through the domain and show
`domain -Controls-> B` — stopping at the domain would falsely report "no path".
The domain only behaves "terminal-ish" for open-ended blast radius, where the
honest answer is "everything" (summarized, not exploded).

### 9.6 Build order (Phase 4)

1. **PR 4a (DONE)** — scope `DCSync` to `domainDNS`; add `Contains` +
   `GpoAppliesTo` edges with unit tests (self-contained, no fan-out).
2. **PR 4b (DONE)** — `Controls` as a virtual edge (never stored) +
   `TraverseOptions.expandControls` (`off` | `toTargets` | `all`).
   `shortestPath` auto-uses `toTargets` so A→B completes *through* domain
   compromise (O(1) — only the target is synthesized). `get_blast_radius` and
   the reverse exposure/`get_tier0` tools use `all`, bounded by `maxNodes`.
   Reverse traversal treats a principal's controlling domain as an inbound
   predecessor, so exposure/derived-Tier0 still surface DCSync-ers now that
   DCSync terminates at the domain node. Verified end-to-end: the full
   `unpriv -GenericAll-> GPO -GpoAppliesTo-> OU -Contains-> user -DCSync-> domain
   -Controls-> crownjewel` path reconstructs.

   Note: `Contains` from the domain head already reaches its *direct* children;
   `Controls` is what reaches principals nested under OUs (any depth) without a
   full containment chain.

Split so the concrete stored edges (4a) are reviewed separately from the
virtual-expansion traversal change (4b), where the subtle correctness lives.

## 10. Phase 5 — credential-weakness layer (breached / weak / reused)

Status: **proposed**. TIE's `list_ad_objects` feed includes password-analysis
companion objects (Tenable's privileged/hash analysis). Today the graph
mis-handles them: a `passwordHashScan` object shares its principal's DN, so
DN-based edge resolution can bind an edge endpoint to the *scan record* instead
of the real principal — which is why scan objects surfaced as bogus "members" of
Administrators / derived Tier-0. Phase 5 fixes that and turns the credential
signal into first-class facts and attack-graph entry points.

### 10.1 The two source object types

Both are `type:"LDAP"` with a distinguishing `objectclass`, keyed by an objectId
suffix:

- **`passwordHashScan`** — one per analyzed principal. Join back to the principal
  by **`distinguishedName`** (its own `objectguid` is the scan record's, not the
  principal's). Attributes: `isbreached` (bool), `islmblank`, `isntblank` (bool),
  `isweak` (object — see 10.3), `retrievalstate` (`Retrieved` | `NotReachable`;
  only `Retrieved` records carry meaningful flags).
- **`passwordHashReuse`** — a shared-hash equivalence class. `prefix` = truncated
  hash fingerprint (grouping key; `31D6C…` is the empty-password NT hash).
  `reusedwithindomain` = `{"1": [objectGuid, …]}` — the principals (by
  **objectGuid**) that share that hash. Clusters range from a few to ~450 members.

### 10.2 Fix: scan/reuse objects are NOT graph nodes

- **Exclude** `passwordHashScan` / `passwordHashReuse` (and any non-directory
  synthetic `objectclass`) from graph node admission. They are data *about*
  principals, not principals.
- This also fixes the DN-collision: with scan objects gone from the node set, an
  edge's DN target resolves to the real principal. Add a guard regardless — when
  two objects share a DN, prefer the one with an `objectSID` / a real directory
  `objectclass`.

### 10.3 Enrichment: fold the signal onto the principal (store layer)

At store-build time, join each `Retrieved` `passwordHashScan` onto its principal
(by DN) and expose queryable attributes on the principal's record:

- `isbreached`, `isntblank`, `islmblank` — booleans, passed through.
- **`isweak`** (derived boolean) = **OR across all profile keys**. The `isweak`
  map's keys are **profile IDs** (TIE config lenses); a true value means the
  password is weak under that profile — either a configured weak/dictionary
  match (Company123-style) OR empty / equals samAccountName. OR-ing is the honest
  "is this a risk?" signal and is not lossy. Because of this, the query engine
  needs **no dotted sub-key access** for the common case — `isweak=true` works.
- **`isweakByProfile`** — the raw `{profileId: bool}` map, preserved for the finer
  query "weak specifically under profile N".

Result: `query_ad_objects("isbreached=true AND admincount>0")`,
`query_ad_objects("isweak=true AND <...>")` work directly — no graph required.
(See the project note on isweak for the confirmed semantics.)

### 10.4 New edges

| EdgeKind        | from → to                          | Meaning (self-contained) |
|-----------------|-------------------------------------|--------------------------|
| `ReusedPassword`| principal ↔ hash-cluster hub        | shares a password hash with the cluster |

- **`ReusedPassword` via a cluster HUB node**, not N² pairwise edges (same
  articulation-point rule as the domain node). Synthesize one hub node per
  `passwordHashReuse` object; emit `principal -ReusedPassword-> hub` and
  `hub -ReusedPassword-> principal` for each member. A 450-member cluster =
  ~900 edges, not ~200k. Traversal through the hub gives "compromise one, reach
  all who share the hash" without the blow-up.
- The hub is an internal graph node (keyed by the reuse object's prefix/id), not
  an AD principal; results should render it as "shared-password group (N members)"
  rather than a fake object.

### 10.5 Credential entry points (traversal)

A breached / weak / blank / reused credential is a compromise primitive that
needs **no ACL chain** — an attacker who cracks or knows the password owns the
principal directly. Model this as an optional **entry-point set** for queries:

- `get_asset_exposure` / `get_tier0`: optionally seed reverse traversal so that
  any principal with a weak credential is treated as *already compromisable*,
  surfacing "weak-credential principal → … → Tier-0" as the highest-value
  finding (attacker needs only to crack a hash, then walk the graph).
- `get_blast_radius`: unchanged start semantics, but `ReusedPassword` edges mean
  compromising one principal reaches its whole reuse cluster.

Framing stays **facts, not verdicts**: we report "has weak/breached/reused
credential" and the reachability it enables; we do not score it. Tenable's IoE
already scores the credential findings themselves.

### 10.6 Build order (Phase 5)

1. **PR 5a (DONE)** — node-admission filter (exclude scan/reuse synthetic
   classes) + DN-collision guard + fold `passwordHashScan` onto principals
   (`isbreached`, `is*blank`, derived `isweak` OR-across-profiles,
   `isweakByProfile`). Pure enrichment; immediately useful via `query_ad_objects`
   (`isbreached=true AND admincount>0`). New module `src/graph/credentials.ts`.
   Also fixes the live bug where scan objects appeared as bogus `get_tier0`
   members.
2. **PR 5b** — `ReusedPassword` hub edges from `passwordHashReuse` + optional
   credential entry-point seeding in the traversal tools.

Split so the store-layer enrichment (5a, no graph dependency) is reviewed apart
from the graph/traversal change (5b).

