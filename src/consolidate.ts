/**
 * Consolidate the raw AD-object snapshot into one record per real directory
 * object, so `query_ad_objects` / `get_ad_object` reflect AD's source of truth.
 *
 * TIE returns MULTIPLE records for a single real object. Verified on middleeast
 * (W12-WS-1: AD has exactly one, TIE returns 6). Three record kinds:
 *
 *   1. The real object — full attributes, has objectSid + samAccountName, in its
 *      real OU path.
 *   2. passwordHashScan/Reuse companions — same guid/DN as a principal, carry
 *      credential-weakness flags. The store already folds those flags onto the
 *      principal (ad-object-store `build()`); here we just drop the standalone
 *      row so it isn't a separate query result.
 *   3. Phantom computer shells — guid-only records (no SID, no samAccountName),
 *      each a DISTINCT guid, sitting in the default `CN=Computers` container
 *      rather than the object's real OU. Stale create-in-Computers-then-move
 *      artifacts TIE never reconciled; AD itself has no such object.
 *
 * Rules (all verified against live counts):
 *   - Drop synthetic scan/reuse rows (kind 2).
 *   - Drop phantom computer shells (kind 3): objectclass includes `computer`,
 *     no objectSid, no samAccountName. Narrow on purpose — schema/container/GPO
 *     objects are also SID-less but REAL, so we do NOT drop by "no SID" alone.
 *   - Dedup the rest by objectGuid, keeping the RICHEST record (most attributes),
 *     so a full record and its sparse same-guid twin collapse to the real one.
 *   - Records without a guid pass through unchanged (can't dedup; keep faithful).
 *
 * Pure + framework-free so it's unit-testable and reused by any consumer.
 * Operates on {@link StoredADObject} but only reads `.record`, so tests can pass
 * minimal fakes.
 */

import type { StoredADObject } from './ad-object-store.js';

function hasClass(o: StoredADObject, cls: string): boolean {
  const oc = o.record['objectclass'];
  if (Array.isArray(oc)) return oc.includes(cls);
  return oc === cls;
}

function str(o: StoredADObject, key: string): string | null {
  const v = o.record[key];
  return typeof v === 'string' && v ? v : null;
}

/** A synthetic passwordHashScan/Reuse companion row (folded onto principals already). */
export function isSyntheticRow(o: StoredADObject): boolean {
  return hasClass(o, 'passwordHashScan') || hasClass(o, 'passwordHashReuse');
}

/**
 * A phantom computer shell: computer-class, but with neither an objectSid nor a
 * samAccountName — a guid-only artifact AD has no counterpart for. Deliberately
 * scoped to the `computer` class so SID-less-but-real objects (attributeSchema,
 * container, GPO, OU, …) are untouched.
 */
export function isPhantomShell(o: StoredADObject): boolean {
  return hasClass(o, 'computer') && !str(o, 'objectsid') && !str(o, 'samaccountname');
}

/** Number of populated fields on a record — the "richness" tiebreaker for dedup. */
function richness(o: StoredADObject): number {
  return Object.keys(o.record).length;
}

/**
 * Collapse raw stored objects into one record per real object. Returns a new
 * array; does not mutate the input or its elements.
 */
export function consolidate(objects: readonly StoredADObject[]): StoredADObject[] {
  const byGuid = new Map<string, StoredADObject>();
  const noGuid: StoredADObject[] = [];

  for (const o of objects) {
    if (isSyntheticRow(o)) continue; // kind 2 — folded onto principals already
    if (isPhantomShell(o)) continue; // kind 3 — stale move artifact

    const guid = str(o, 'objectguid');
    if (!guid) {
      noGuid.push(o); // can't dedup; keep as-is
      continue;
    }
    const key = guid.toLowerCase();
    const cur = byGuid.get(key);
    // Keep the richest record so a full object wins over its sparse twin.
    if (!cur || richness(o) > richness(cur)) byGuid.set(key, o);
  }

  return [...byGuid.values(), ...noGuid];
}
