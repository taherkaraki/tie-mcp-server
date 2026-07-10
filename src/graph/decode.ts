/**
 * Human-readable decoding of a security descriptor: turn the parsed SDDL into
 * ACEs with resolved principals, named rights, and named object-types. This is
 * the on-demand decoder behind get_ad_object({ decodeSecurityDescriptor: true }).
 *
 * Facts, not verdicts: it says "Everyone has WriteProperty on member" — it does
 * NOT say whether that's dangerous. Severity is the orchestrator's / IOE's call.
 */

import { parseSddl, type Ace } from './sddl.js';
import {
  RIGHT_MNEMONICS,
  isFullControl,
  wellKnownSidLabel,
  isBroadSid,
} from './rights.js';
import type { SchemaMap } from './schema-map.js';

/** Resolves a SID to a display name (built from the store; see graph layer). */
export type SidResolver = (sid: string) => string | null;

export interface DecodedAce {
  effect: 'Allow' | 'Deny' | 'Audit';
  trustee: { sid: string; name: string | null; broad: boolean };
  /** Named rights, e.g. ["WriteProperty","ReadProperty"] or ["GenericAll"]. */
  rights: string[];
  /** Named object-type the ACE is scoped to (attr/extended-right), if any. */
  appliesTo: string | null;
  inherited: boolean;
}

export interface DecodedDescriptor {
  owner: { sid: string; name: string | null } | null;
  group: { sid: string; name: string | null } | null;
  aceCount: number;
  aces: DecodedAce[];
  malformed: boolean;
}

function effectOf(ace: Ace): DecodedAce['effect'] {
  if (ace.type === 'A' || ace.type === 'OA') return 'Allow';
  if (ace.type === 'D' || ace.type === 'OD') return 'Deny';
  return 'Audit'; // SU/AU/etc.
}

function nameRights(ace: Ace): string[] {
  if (isFullControl(ace.rights)) return ['GenericAll'];
  if (ace.rights.length === 0 && ace.rightsRaw) return [ace.rightsRaw]; // hex mask
  return ace.rights.map((t) => RIGHT_MNEMONICS[t] ?? t);
}

/**
 * Decode a raw SDDL string into resolved, named ACEs. `resolveSid` and `schema`
 * are optional; without them SIDs/GUIDs are left unresolved (name: null) rather
 * than failing.
 */
export function decodeSecurityDescriptor(
  sddl: string,
  resolveSid?: SidResolver,
  schema?: SchemaMap
): DecodedDescriptor {
  const sd = parseSddl(sddl);

  const resolve = (sid: string): string | null =>
    (resolveSid && resolveSid(sid)) ?? wellKnownSidLabel(sid);

  const aces: DecodedAce[] = sd.dacl.map((ace) => ({
    effect: effectOf(ace),
    trustee: {
      sid: ace.trustee,
      name: resolve(ace.trustee),
      broad: isBroadSid(ace.trustee),
    },
    rights: nameRights(ace),
    appliesTo: ace.objectType
      ? (schema?.resolve(ace.objectType) ?? ace.objectType)
      : null,
    inherited: ace.inherited,
  }));

  return {
    owner: sd.owner ? { sid: sd.owner, name: resolve(sd.owner) } : null,
    group: sd.group ? { sid: sd.group, name: resolve(sd.group) } : null,
    aceCount: aces.length,
    aces,
    malformed: sd.malformed,
  };
}
