/**
 * Build a GUID → friendly-name map from the schema objects that are already
 * resident in the AD object store — no external tables, no extra API calls.
 *
 * Active Directory publishes every attribute and class under
 * CN=Schema,CN=Configuration, each carrying a `schemaIDGUID`, and every
 * control-access-right under CN=Extended-Rights, carrying a `rightsGUID`. Object
 * ACEs (OA/OD) reference these GUIDs in their objectType field. Resolving them
 * from the live schema makes the decoder accurate to *this* forest rather than a
 * hard-coded list.
 *
 * The static well-known GUIDs in rights.ts still take precedence for the small
 * set of edge-triggering rights; this map covers the long tail for readable
 * decode (e.g. turning an arbitrary property-set GUID into its display name).
 */

import { KNOWN_GUID_NAMES } from './rights.js';

/** Minimal shape we read from a stored object's flattened attribute record. */
export interface SchemaSourceObject {
  record: Record<string, unknown>;
}

/** A GUID → name resolver, case-insensitive on the GUID. */
export interface SchemaMap {
  /** Resolve a GUID to a friendly name, or null if unknown. */
  resolve(guid: string | null | undefined): string | null;
  /** Number of GUIDs indexed (for diagnostics). */
  size: number;
}

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/**
 * Construct a SchemaMap from all stored objects. Scans for objects that expose
 * `schemaidguid` or `rightsguid` and maps them to their display name
 * (`ldapdisplayname` preferred, else `cn`/`name`). Cheap: one linear pass.
 */
export function buildSchemaMap(objects: Iterable<SchemaSourceObject>): SchemaMap {
  const byGuid = new Map<string, string>();

  // Seed with well-known GUIDs so they always resolve even if the schema object
  // wasn't captured; live schema entries below can still override the label.
  for (const [guid, name] of Object.entries(KNOWN_GUID_NAMES)) {
    byGuid.set(guid.toLowerCase(), name);
  }

  for (const obj of objects) {
    const rec = obj.record;
    const guid =
      firstString(rec['schemaidguid']) ?? firstString(rec['rightsguid']);
    if (!guid) continue;

    const name =
      firstString(rec['ldapdisplayname']) ??
      firstString(rec['cn']) ??
      firstString(rec['name']);
    if (name) byGuid.set(guid.toLowerCase(), name);
  }

  return {
    resolve(guid) {
      if (!guid) return null;
      return byGuid.get(guid.toLowerCase()) ?? null;
    },
    size: byGuid.size,
  };
}
