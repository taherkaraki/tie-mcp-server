/**
 * Extract the *embedded principals* from a deviance's attributes.
 *
 * Why this exists: a TIE deviance is filed against exactly one object (its
 * `adObjectId`) — usually the VICTIM. For a whole class of checkers (Shadow
 * Credentials, ADCS dangerous access, dangerous ACEs on partitions, …) the
 * actually-risky principal is not the flagged object at all: it's a trustee
 * buried inside an attribute value (e.g. `DangerousAceList`). A per-object
 * lookup can never surface "what dangerous power does THIS identity hold over
 * others?" because that identity only appears as a string inside someone else's
 * deviance. This module pulls those trustees out so the store can build a
 * reverse index (trustee -> deviances).
 *
 * Facts, not verdicts: we report the trustee reference and the rights the
 * deviance itself named, nothing inferred.
 */

/** A principal-bearing attribute we know how to parse. */
export const TRUSTEE_ATTRIBUTES = ['DangerousAceList', 'MemberDn'] as const;

/** One risky trustee extracted from a deviance attribute. */
export interface EmbeddedTrustee {
  /** Trustee SID, if the attribute carried one (lower-cased). */
  sid: string | null;
  /** `DOMAIN\name` or DN form, if present — for display / DN resolution. */
  name: string | null;
  /** Rights the deviance attributed to this trustee (named, e.g. "Write all properties"). */
  grantedRights: string[];
  /** Which attribute (and index) it came from, for provenance in output. */
  resolvedFrom: string;
}

interface DangerousAce {
  Item1?: string; // raw ACE SDDL string
  Item2?: string; // trustee SID
  Item3?: string; // DOMAIN\name (friendly)
  Item4?: Array<{ Item1?: string; Item2?: string }>; // [{name, ''}]
}

const SID_RE = /^S-1-5-.+/i;

/**
 * Parse a `DangerousAceList` attribute value (a JSON array string) into its
 * trustees. Tolerant: returns [] on any parse failure rather than throwing, so
 * one malformed deviance can't break an index build.
 */
export function parseDangerousAceList(value: string): EmbeddedTrustee[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: EmbeddedTrustee[] = [];
  parsed.forEach((entry, i) => {
    const ace = entry as DangerousAce;
    const sid = typeof ace.Item2 === 'string' && ace.Item2 ? ace.Item2.toLowerCase() : null;
    const name = typeof ace.Item3 === 'string' && ace.Item3 ? ace.Item3 : null;
    if (!sid && !name) return; // nothing to key on
    const grantedRights = Array.isArray(ace.Item4)
      ? ace.Item4.map((r) => r?.Item1).filter((r): r is string => typeof r === 'string' && !!r)
      : [];
    out.push({ sid, name, grantedRights, resolvedFrom: `DangerousAceList[${i}]` });
  });
  return out;
}

/** Parse a `MemberDn` attribute — a DN (or SID) naming the risky member. */
function parseMemberDn(value: string): EmbeddedTrustee[] {
  const v = value.trim();
  if (!v) return [];
  const sid = SID_RE.test(v) ? v.toLowerCase() : null;
  return [{ sid, name: sid ? null : v, grantedRights: [], resolvedFrom: 'MemberDn' }];
}

/**
 * Extract every embedded trustee from a deviance's attribute list. `attributes`
 * is the raw `[{name, value}]` array as returned by the deviance API.
 */
export function embeddedTrustees(
  attributes: Array<{ name: string; value: string }>
): EmbeddedTrustee[] {
  const out: EmbeddedTrustee[] = [];
  for (const attr of attributes) {
    if (attr.name === 'DangerousAceList') out.push(...parseDangerousAceList(attr.value));
    else if (attr.name === 'MemberDn') out.push(...parseMemberDn(attr.value));
  }
  return out;
}
