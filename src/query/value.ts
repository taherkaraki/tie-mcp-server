/**
 * Normalize a raw TIE ad-object attribute into a typed JavaScript value for the
 * query engine.
 *
 * TIE returns every attribute as { name, value, valueType } where `value` is a
 * JSON-encoded string and `valueType` says how to decode it. A string arrives
 * as "\"Domain Admins\"", an integer as "1", an array as "[\"top\",\"group\"]".
 * We decode once here at ingest time so comparisons downstream work on real
 * numbers/booleans/arrays instead of quoted strings.
 *
 * Design decisions (confirmed against real data from the middleeast tenant):
 * - `date` and date-like strings are kept as STRINGS, not epoch numbers. TIE
 *   emits ISO-8601 (e.g. "2026-06-10T03:32:08Z") which sorts correctly
 *   lexically, and some date fields carry sentinels like "NEVER" that aren't
 *   dates at all. String comparison is the agreed model, so we don't coerce.
 * - `object` values (e.g. isweak = {"1":false,...}, reusedwithindomain = {})
 *   are kept as their JSON string form and compared opaquely. Their internal
 *   structure is intentionally not interpreted yet (see project note on
 *   isweak); revisit if structured sub-key access is ever needed.
 * - `useraccountcontrol` is a space-separated flag STRING ("NORMAL DONT_EXPIRE"),
 *   not a bitmask, so flag tests are done via the `contains` operator, not
 *   bitwise math.
 *
 * Decoding is defensive: TIE occasionally emits values that don't parse as JSON
 * (bare sentinels, pre-stringified enums). On parse failure we fall back to the
 * raw string with surrounding quotes stripped, so a value is always usable
 * rather than throwing mid-scan.
 */

/** The set of valueType discriminators TIE emits (see the OpenAPI enum). */
export type TIEValueType =
  | 'boolean'
  | 'string'
  | 'integer'
  | 'date'
  | 'object'
  | 'array/boolean'
  | 'array/string'
  | 'array/integer'
  | 'array/date'
  | 'array/object';

/** A decoded attribute value. */
export type NormalizedValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

/** Strip one layer of surrounding double quotes if present. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/** Best-effort JSON.parse; returns the raw (de-quoted) string on failure. */
function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return stripQuotes(raw);
  }
}

/**
 * Decode one attribute's `value` according to `valueType`. Scalars return their
 * JS primitive; array/* types return an array of decoded primitives. Dates and
 * objects are kept as strings (see module comment).
 */
export function normalizeAttributeValue(
  value: string,
  valueType: string
): NormalizedValue {
  const parsed = tryParse(value);

  switch (valueType as TIEValueType) {
    case 'integer': {
      const n = typeof parsed === 'number' ? parsed : Number(stripQuotes(value));
      return Number.isNaN(n) ? stripQuotes(value) : n;
    }
    case 'boolean':
      return typeof parsed === 'boolean' ? parsed : stripQuotes(value) === 'true';
    case 'string':
    case 'date':
      // Dates stay as ISO strings; sentinels like "NEVER" pass through as-is.
      return typeof parsed === 'string' ? parsed : String(parsed);
    case 'object':
      // Keep the JSON form so it can be matched opaquely (contains/equals).
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    case 'array/integer':
      return Array.isArray(parsed) ? parsed.map((x) => Number(x)) : [];
    case 'array/boolean':
      return Array.isArray(parsed) ? parsed.map((x) => Boolean(x)) : [];
    case 'array/string':
    case 'array/date':
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    case 'array/object':
      return Array.isArray(parsed)
        ? parsed.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
        : [];
    default:
      // Unknown type: hand back the de-quoted raw string.
      return stripQuotes(value);
  }
}
