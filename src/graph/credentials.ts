/**
 * Credential-weakness enrichment: fold TIE's password-analysis companion objects
 * (`passwordHashScan`) onto the principals they describe.
 *
 * TIE emits one `passwordHashScan` object per analyzed principal, linked back to
 * the principal only by `distinguishedName` (the scan record's own objectGuid is
 * the record's, not the principal's). We join by DN and expose the credential
 * signal as queryable attributes on the principal's flattened record, so
 * `query_ad_objects("isbreached=true AND admincount>0")` works with no graph.
 *
 * `isweak` semantics (confirmed): the map's keys are PROFILE IDs — a TIE profile
 * is a configuration lens, and `isweak[profileId]` is whether the password is
 * weak under that profile's policy (a configured weak/dictionary match, or empty
 * / equals samAccountName). We derive a single boolean by OR-ing across profiles
 * ("weak under at least one profile" = the honest risk signal) and preserve the
 * raw per-profile map.
 *
 * Facts, not verdicts: we surface the flags and leave severity to the caller /
 * Tenable IoEs.
 */

/** The objectclass value that marks a password-scan companion object. */
export const PASSWORD_HASH_SCAN_CLASS = 'passwordHashScan';
/** The objectclass value that marks a password-reuse cluster object. */
export const PASSWORD_HASH_REUSE_CLASS = 'passwordHashReuse';

/** Non-directory synthetic objectclasses that must NOT become graph nodes. */
export const SYNTHETIC_OBJECT_CLASSES: ReadonlySet<string> = new Set([
  PASSWORD_HASH_SCAN_CLASS,
  PASSWORD_HASH_REUSE_CLASS,
]);

/** The credential fields folded onto a principal's record. */
export interface CredentialFacts {
  isbreached?: boolean;
  isntblank?: boolean;
  islmblank?: boolean;
  /** OR across all profile keys of the isweak map. */
  isweak?: boolean;
  /** Raw per-profile map, profileId(as string) -> weak-under-that-profile. */
  isweakByProfile?: Record<string, boolean>;
}

/** True if a record's objectclass array/string contains `cls`. */
export function hasObjectClass(record: Record<string, unknown>, cls: string): boolean {
  const oc = record['objectclass'];
  if (Array.isArray(oc)) return oc.includes(cls);
  return oc === cls;
}

/** True if the object is a synthetic (non-directory) analysis object. */
export function isSyntheticObject(record: Record<string, unknown>): boolean {
  const oc = record['objectclass'];
  const classes = Array.isArray(oc) ? oc : typeof oc === 'string' ? [oc] : [];
  return classes.some((c) => SYNTHETIC_OBJECT_CLASSES.has(String(c)));
}

/**
 * Parse the `isweak` value (an object like {"1":false,"2":true,...}, stored by
 * the normalizer as its JSON string) into a per-profile boolean map. Returns an
 * empty map on anything unparseable.
 */
export function parseIsWeak(value: unknown): Record<string, boolean> {
  let obj: unknown = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = v === true || v === 'true';
  }
  return out;
}

/** A parsed passwordHashReuse cluster: principals sharing one password hash. */
export interface ReuseCluster {
  /** Grouping key (truncated hash fingerprint), e.g. "31D6C" (empty NT hash). */
  prefix: string;
  /** objectGuids (lower-cased) of the principals sharing the hash. */
  memberGuids: string[];
}

/**
 * Parse a passwordHashReuse record into a cluster, or null if it isn't one or
 * carries no members. `reusedwithindomain` is `{"1":[guid, …]}` (the "1" key is
 * an internal bucket, not a profile id here — we flatten all buckets).
 */
export function reuseClusterFrom(record: Record<string, unknown>): ReuseCluster | null {
  if (!hasObjectClass(record, PASSWORD_HASH_REUSE_CLASS)) return null;
  const prefix =
    typeof record['prefix'] === 'string' ? (record['prefix'] as string) : '';

  let obj: unknown = record['reusedwithindomain'];
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const memberGuids: string[] = [];
  for (const bucket of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(bucket)) {
      for (const g of bucket) {
        if (typeof g === 'string' && g) memberGuids.push(g.toLowerCase());
      }
    }
  }
  if (memberGuids.length === 0) return null;
  return { prefix, memberGuids };
}

/** Derive the credential facts from a single passwordHashScan record. */
export function credentialFactsFrom(scan: Record<string, unknown>): CredentialFacts {
  const facts: CredentialFacts = {};
  if (typeof scan['isbreached'] === 'boolean') facts.isbreached = scan['isbreached'];
  if (typeof scan['isntblank'] === 'boolean') facts.isntblank = scan['isntblank'];
  if (typeof scan['islmblank'] === 'boolean') facts.islmblank = scan['islmblank'];

  if ('isweak' in scan) {
    const byProfile = parseIsWeak(scan['isweak']);
    if (Object.keys(byProfile).length > 0) {
      facts.isweakByProfile = byProfile;
      facts.isweak = Object.values(byProfile).some(Boolean); // OR across profiles
    }
  }
  return facts;
}
