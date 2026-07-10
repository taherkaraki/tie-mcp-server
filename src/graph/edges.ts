/**
 * Control-edge model: derive typed "X can control Y" edges from a stored AD
 * object.
 *
 * Edges come from TWO sources, not just SDDL:
 *   1. Plain attributes (membership, delegation, SID history, GPO links, ...) —
 *      often the highest-signal edges, and present without any ACL.
 *   2. The parsed ntSecurityDescriptor DACL/owner (permission edges).
 *
 * An edge means: principal `from` can perform a control action (`kind`) on
 * object `to`. Both are identified by a node key (see nodeKeyFor): an objectSID
 * when present, else the objectGUID. Trustees in ACEs are SIDs; membership/
 * delegation values are DNs, so those are resolved to node keys during graph
 * assembly (graph.ts), not here — this module emits edges with the RAW target
 * reference and a `resolve` hint so assembly can wire them up.
 *
 * Facts, not verdicts: no severity is assigned. Deny ACEs and self-referential
 * trustees are skipped in v1 (documented limitation).
 */

import type { StoredADObject } from '../ad-object-store.js';
import { parseSddl } from './sddl.js';
import {
  EXTENDED_RIGHTS,
  SELF_SID,
  isFullControl,
} from './rights.js';

/** The control actions we model as graph edges. */
export type EdgeKind =
  | 'MemberOf' // from is a member of group to
  | 'Owns' // from owns to (implicitly can rewrite its DACL)
  | 'GenericAll'
  | 'GenericWrite'
  | 'WriteDacl'
  | 'WriteOwner'
  | 'AddMember' // WriteProperty on the member attribute
  | 'ForceChangePassword'
  | 'AddKeyCredentialLink' // shadow credentials
  | 'DCSync' // both replication rights on the domain head
  | 'AllowedToDelegate' // constrained delegation (msDS-AllowedToDelegateTo)
  | 'AllowedToAct' // RBCD (msDS-AllowedToActOnBehalfOfOtherIdentity)
  | 'SIDHistory' // from carries to's SID in sidHistory (silent equivalence)
  | 'GpLink'; // OU/domain to links a GPO

/**
 * How the target reference in a raw edge should be resolved to a node key
 * during graph assembly:
 *   'sid'  — target is already a node key (objectSID/GUID)
 *   'dn'   — target is a distinguishedName; look up the owning object
 *   'guid' — target is a raw GUID string
 */
export type TargetRef = 'sid' | 'dn' | 'guid';

export interface RawEdge {
  /** Source node key (usually the trustee SID or the object's own key). */
  from: string;
  /** Target reference (interpreted per `targetRef`). */
  to: string;
  targetRef: TargetRef;
  kind: EdgeKind;
  /** Where the edge came from, for provenance in query output. */
  via: 'member' | 'primaryGroup' | 'delegation' | 'rbcd' | 'sidHistory' | 'gplink' | 'dacl' | 'owner';
  /** Optional detail (e.g. the ACE right tokens or a resolved right name). */
  detail?: string;
}

/** Read a record field as a plain string (already de-quoted by the store). */
function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' && v ? v : null;
}

/** Read a record field as a string array (array/string attrs decode to arrays). */
function arr(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/**
 * The node key for an object: prefer objectSID, else the objectId GUID part.
 * Objects like OUs/GPOs have no SID and key on their GUID.
 */
export function nodeKeyFor(obj: StoredADObject): string {
  const sid = str(obj.record, 'objectsid');
  if (sid) return sid.toLowerCase();
  return obj.objectId.toLowerCase();
}

/** Domain portion of a SID (everything before the final RID). */
function domainOf(sid: string): string | null {
  const i = sid.lastIndexOf('-');
  return i > 0 ? sid.slice(0, i) : null;
}

/**
 * Edges derived from plain attributes (no SDDL). These are frequently the
 * highest-signal edges in an attack path and exist independently of any ACL.
 *
 * Note on direction: the graph is "from can control to". Membership is modeled
 * as an edge FROM the member TO the group — traversing it forward means "this
 * principal's power flows up into the group's privileges", which is what path
 * and blast-radius queries want.
 */
export function attributeEdges(obj: StoredADObject): RawEdge[] {
  const rec = obj.record;
  const self = nodeKeyFor(obj);
  const selfSid = str(rec, 'objectsid');
  const edges: RawEdge[] = [];

  // MemberOf: the object lists its groups in memberof (DNs). member (on the
  // group side) is handled from the group's own record via the same closure, so
  // we key on memberof here to capture the member's outbound edge.
  for (const groupDn of arr(rec, 'memberof')) {
    edges.push({ from: self, to: groupDn, targetRef: 'dn', kind: 'MemberOf', via: 'member' });
  }
  // Some directories populate `member` but not `memberof`; capture that too by
  // emitting, for each listed member DN, an edge member->thisGroup.
  for (const memberDn of arr(rec, 'member')) {
    edges.push({ from: memberDn, to: self, targetRef: 'dn', kind: 'MemberOf', via: 'member', detail: 'from-group-member' });
  }

  // primaryGroupID: membership the `member`/`memberof` attrs omit. The group's
  // SID is the object's domain + the RID in primaryGroupID.
  const pgid = rec['primarygroupid'];
  if (typeof pgid === 'number' && selfSid) {
    const dom = domainOf(selfSid);
    if (dom) {
      edges.push({ from: self, to: `${dom}-${pgid}`.toLowerCase(), targetRef: 'sid', kind: 'MemberOf', via: 'primaryGroup' });
    }
  }

  // Constrained delegation: this principal can impersonate to the named SPNs'
  // hosts. We record it as an edge to each target (SPN host resolution happens
  // in assembly; store the raw SPN as detail).
  for (const spn of arr(rec, 'msds-allowedtodelegateto')) {
    edges.push({ from: self, to: spn, targetRef: 'dn', kind: 'AllowedToDelegate', via: 'delegation', detail: spn });
  }

  // RBCD: whoever is listed in msDS-AllowedToActOnBehalfOfOtherIdentity can act
  // as THIS object. That attribute is itself a security descriptor; assembly
  // parses it. Here we flag the object as an RBCD target so assembly expands it.
  if (str(rec, 'msds-allowedtoactonbehalfofotheridentity')) {
    edges.push({ from: self, to: self, targetRef: 'sid', kind: 'AllowedToAct', via: 'rbcd', detail: 'see-descriptor' });
  }

  // SID history: this principal is silently equivalent to each SID it carries.
  for (const histSid of arr(rec, 'sidhistory')) {
    edges.push({ from: self, to: histSid.toLowerCase(), targetRef: 'sid', kind: 'SIDHistory', via: 'sidHistory' });
  }

  // GPO links: an OU/domain links GPOs; controlling the GPO controls linked
  // computers. gplink is array/object in the store; each entry has a DN/GUID.
  for (const link of gplinkTargets(rec['gplink'])) {
    edges.push({ from: self, to: link, targetRef: 'dn', kind: 'GpLink', via: 'gplink' });
  }

  return edges;
}

/** Extract GPO DNs from the gplink attribute (array/object or raw string). */
function gplinkTargets(v: unknown): string[] {
  const out: string[] = [];
  const items = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  for (const it of items) {
    if (typeof it === 'string') {
      // Could be a JSON object string or a raw "[LDAP://cn={guid},...]" list.
      const dn = extractGpoDn(it);
      if (dn) out.push(dn);
    } else if (it && typeof it === 'object') {
      const dn = (it as Record<string, unknown>)['DistinguishedName'];
      if (typeof dn === 'string') out.push(dn);
    }
  }
  return out;
}

/** Pull a GPO DN out of a gplink fragment, if present. */
function extractGpoDn(s: string): string | null {
  const m = s.match(/(cn=\{[0-9a-fA-F-]+\}[^;\]]*)/);
  return m ? m[1] : null;
}

/**
 * Edges derived from the object's ntSecurityDescriptor (DACL + owner). Each
 * allow ACE granting a control-relevant right to a non-self trustee becomes an
 * edge FROM the trustee TO this object.
 *
 * Semantics precision (why the real parser matters):
 *   - WriteProperty on the `member` attribute GUID -> AddMember, NOT generic
 *     write. WriteProperty with no object-type -> GenericWrite.
 *   - Full-control token run OR GA -> GenericAll.
 *   - DCSync requires BOTH replication extended rights for the same trustee, so
 *     it's computed across the object's ACEs, not per-ACE.
 * Deny ACEs and the SELF principal are skipped (v1 limitation).
 */
export function sddlEdges(obj: StoredADObject): RawEdge[] {
  const sddl = str(obj.record, 'ntsecuritydescriptor');
  if (!sddl) return [];
  const sd = parseSddl(sddl);
  const self = nodeKeyFor(obj);
  const edges: RawEdge[] = [];

  // Owner implicitly can rewrite the DACL -> effectively full control.
  if (sd.owner && sd.owner !== SELF_SID) {
    edges.push({ from: sd.owner.toLowerCase(), to: self, targetRef: 'sid', kind: 'Owns', via: 'owner' });
  }

  // Track replication rights per trustee for the DCSync (both-required) check.
  const replGetChanges = new Set<string>();
  const replGetChangesAll = new Set<string>();

  for (const ace of sd.dacl) {
    if (!ace.isAllow) continue; // v1: allow ACEs only
    const trustee = ace.trustee.toLowerCase();
    if (trustee === SELF_SID.toLowerCase()) continue;

    const push = (kind: EdgeKind, detail?: string) =>
      edges.push({ from: trustee, to: self, targetRef: 'sid', kind, via: 'dacl', detail });

    // Full control / GenericAll.
    if (isFullControl(ace.rights)) {
      push('GenericAll', ace.rights.join(''));
      continue;
    }
    if (ace.rights.includes('WD')) push('WriteDacl');
    if (ace.rights.includes('WO')) push('WriteOwner');
    if (ace.rights.includes('GW')) push('GenericWrite');

    // Object-scoped rights: the objectType GUID disambiguates the right.
    const ot = ace.objectType; // already lower-cased by the parser
    if (ace.rights.includes('WP')) {
      if (ot === EXTENDED_RIGHTS.memberAttribute) push('AddMember', 'member');
      else if (ot === EXTENDED_RIGHTS.keyCredentialLink) push('AddKeyCredentialLink', 'msDS-KeyCredentialLink');
      else if (!ot) push('GenericWrite', 'WP-all'); // write to any property
    }
    if (ace.rights.includes('CR') && ot) {
      if (ot === EXTENDED_RIGHTS.forceChangePassword) push('ForceChangePassword');
      else if (ot === EXTENDED_RIGHTS.dsReplGetChanges) replGetChanges.add(trustee);
      else if (ot === EXTENDED_RIGHTS.dsReplGetChangesAll) replGetChangesAll.add(trustee);
    }
  }

  // DCSync: a trustee holding BOTH replication rights on this (domain) object.
  for (const trustee of replGetChanges) {
    if (replGetChangesAll.has(trustee)) {
      edges.push({ from: trustee, to: self, targetRef: 'sid', kind: 'DCSync', via: 'dacl' });
    }
  }

  return edges;
}

/** All edges (attribute + SDDL) for one object. */
export function edgesForObject(obj: StoredADObject): RawEdge[] {
  return [...attributeEdges(obj), ...sddlEdges(obj)];
}
