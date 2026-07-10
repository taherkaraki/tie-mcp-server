/**
 * Parser for Windows security descriptors in SDDL string form (the value TIE
 * stores in the `ntsecuritydescriptor` attribute).
 *
 * This is parsing ONLY — it turns the SDDL string into a structured descriptor.
 * It resolves nothing (no SID → name), judges nothing (no risk). Edge derivation
 * and risk framing live downstream in edges.ts / the orchestrator.
 *
 * SDDL shape (we care about owner, group, and the DACL):
 *   O:<owner_sid>G:<group_sid>D:<dacl_flags>(ace)(ace)...S:<sacl>
 * Each ACE is six ';'-separated fields:
 *   ace_type ; ace_flags ; rights ; object_guid ; inherited_object_guid ; trustee
 *
 * Robustness: the parser NEVER throws on malformed input — it returns whatever it
 * could extract with `malformed: true`, so a single bad descriptor can't abort a
 * 60k-object graph build (same defensive posture as query/value.ts).
 */

import { splitRightTokens } from './rights.js';

export interface Ace {
  /** Raw ACE type token: A/D (allow/deny), OA/OD (object allow/deny), etc. */
  type: string;
  /** Convenience: true for allow ACE types (A, OA, and audit types excluded). */
  isAllow: boolean;
  /** True for object ACEs (OA/OD) that carry object-type GUID(s). */
  isObjectAce: boolean;
  /** Inheritance/flag tokens: CI, OI, IO, ID, NP, SA, FA. */
  flags: string[];
  /** Decoded 2-char right mnemonics (empty when rights is a hex mask). */
  rights: string[];
  /** Raw rights field as-is (preserves a hex mask like "0x100"). */
  rightsRaw: string;
  /** Object-type GUID (extended right / attribute / property set), OA/OD only. */
  objectType: string | null;
  /** Inherited-object-type GUID, OA/OD only. */
  inheritedObjectType: string | null;
  /** Trustee SID the ACE applies to. */
  trustee: string;
  /** True when the ACE was inherited (ID flag present). */
  inherited: boolean;
}

export interface SecurityDescriptor {
  owner: string | null;
  group: string | null;
  dacl: Ace[];
  /** DACL control flags that precede the ACE list (e.g. "AI", "P", "PAI"). */
  daclFlags: string;
  /** True if parsing hit something unexpected; dacl holds whatever was salvaged. */
  malformed: boolean;
}

/** Allow-type ACEs (as opposed to deny/audit). Object variants included. */
const ALLOW_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);

/**
 * Parse one ACE body (the text between its parentheses) into an Ace. Returns
 * null if it doesn't have the minimum field structure.
 */
function parseAce(body: string): Ace | null {
  const f = body.split(';');
  if (f.length < 6) return null;
  const [type, flags, rights, objectType, inheritedObjectType, trustee] = f;
  // Trustee may carry trailing fields (conditional ACEs); take the first token.
  const trusteeSid = trustee.split(';')[0].trim();
  if (!type || !trusteeSid) return null;

  return {
    type,
    isAllow: ALLOW_TYPES.has(type),
    isObjectAce: type === 'OA' || type === 'OD',
    flags: flags ? chunk2(flags) : [],
    rights: splitRightTokens(rights),
    rightsRaw: rights,
    objectType: objectType ? objectType.toLowerCase() : null,
    inheritedObjectType: inheritedObjectType
      ? inheritedObjectType.toLowerCase()
      : null,
    trustee: trusteeSid,
    inherited: flags ? chunk2(flags).includes('ID') : false,
  };
}

/** Split a flag string into 2-char tokens (CI, OI, ID, ...). */
function chunk2(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

/** Extract the SID following a prefix like "O:" or "G:" up to the next section. */
function readSidField(sddl: string, marker: string): string | null {
  const idx = sddl.indexOf(marker);
  if (idx === -1) return null;
  let i = idx + marker.length;
  // SID runs until the next section marker (G: D: S:) or an open paren.
  let sid = '';
  while (i < sddl.length) {
    const c = sddl[i];
    if (c === '(') break;
    // Stop at a following section marker.
    if ((c === 'G' || c === 'D' || c === 'S') && sddl[i + 1] === ':') break;
    sid += c;
    i++;
  }
  sid = sid.trim();
  return sid || null;
}

/**
 * Parse a full SDDL string into a SecurityDescriptor. Never throws.
 */
export function parseSddl(sddl: string): SecurityDescriptor {
  const result: SecurityDescriptor = {
    owner: null,
    group: null,
    dacl: [],
    daclFlags: '',
    malformed: false,
  };
  if (!sddl || typeof sddl !== 'string') {
    result.malformed = true;
    return result;
  }

  try {
    result.owner = readSidField(sddl, 'O:');
    result.group = readSidField(sddl, 'G:');

    // Locate the DACL section: "D:" followed by optional flags, then ACEs.
    const dIdx = sddl.indexOf('D:');
    if (dIdx === -1) {
      // No DACL present (unusual but valid — e.g. owner-only). Not malformed.
      return result;
    }

    // daclFlags are the chars between "D:" and the first "(".
    const afterD = sddl.slice(dIdx + 2);
    const firstParen = afterD.indexOf('(');
    if (firstParen === -1) {
      // "D:" with no ACEs — e.g. D:NO_ACCESS or a protected empty DACL.
      result.daclFlags = afterD.split('S:')[0].trim();
      return result;
    }
    result.daclFlags = afterD.slice(0, firstParen).trim();

    // Walk balanced parentheses to extract each ACE body (SACL "S:" ends DACL).
    let i = dIdx + 2 + firstParen;
    while (i < sddl.length) {
      if (sddl[i] !== '(') {
        // Reached the SACL or trailing content; stop.
        if (sddl.startsWith('S:', i)) break;
        i++;
        continue;
      }
      const close = sddl.indexOf(')', i);
      if (close === -1) {
        result.malformed = true;
        break;
      }
      const body = sddl.slice(i + 1, close);
      const ace = parseAce(body);
      if (ace) result.dacl.push(ace);
      else result.malformed = true;
      i = close + 1;
    }
  } catch {
    result.malformed = true;
  }

  return result;
}
