/**
 * Tool exposure filtering.
 *
 * Operators can restrict which tools the server advertises via the
 * `TIE_ALLOWED_SAFETY` environment variable — a comma-separated list of safety
 * tiers (e.g. "read" or "read,write"). When unset, all tiers are exposed. This
 * lets a deployment disable destructive tools without code changes, and applies
 * uniformly to both generated and custom tools (both carry a `safety` tier).
 */

/** Keep only tools whose safety tier is allowed by TIE_ALLOWED_SAFETY. */
export function filterTools<T extends { safety: string }>(all: T[]): T[] {
  const allowed = process.env.TIE_ALLOWED_SAFETY;
  if (!allowed) return all;
  const tiers = new Set(allowed.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((t) => tiers.has(t.safety));
}
