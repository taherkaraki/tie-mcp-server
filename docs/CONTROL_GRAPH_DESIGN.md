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

