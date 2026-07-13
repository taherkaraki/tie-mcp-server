/**
 * Fetch and shape the metadata that enriches raw deviances: checker metadata,
 * reasons, and the per-profile severity/enabled configuration.
 *
 * These are the "join tables" of the deviance index. Kept separate from the
 * store so the fetching (API-shaped) is testable against a fake client without
 * the scan machinery.
 *
 * Cost, built once and cached with the index:
 *   - 1× GET /api/checkers               (metadata + remediationCost)
 *   - 1× GET /api/reasons                (all reasons, global)
 *   - N× GET /api/profiles/{p}/checkers/{c}/checker-options?staged=0
 *        (O-CRITICITY + O-ENABLED, incl. per-directory override rows)
 */

import type { TIEClient } from '../client.js';
import type { CheckerMeta, ReasonMeta, CheckerConfig } from './types.js';

interface RawCheckerOption {
  codename: string;
  value: string;
  valueType: string;
  checkerId: number;
  profileId: number;
  directoryId: number | null;
  staged: boolean;
}

/** GET /api/checkers -> Map<checkerId, CheckerMeta>. */
export async function fetchCheckerMeta(client: TIEClient): Promise<Map<number, CheckerMeta>> {
  const raw = await client.get<
    Array<{ id: number; codename: string; name: string; categoryId?: number; remediationCost?: number }>
  >('/api/checkers');
  const out = new Map<number, CheckerMeta>();
  for (const c of raw) {
    out.set(c.id, {
      id: c.id,
      codename: c.codename,
      name: c.name,
      categoryId: c.categoryId ?? null,
      remediationCost: c.remediationCost ?? null,
    });
  }
  return out;
}

/** GET /api/reasons -> Map<reasonId, ReasonMeta>. */
export async function fetchReasons(client: TIEClient): Promise<Map<number, ReasonMeta>> {
  const raw = await client.get<Array<{ id: number; codename: string; name: string; description: string }>>(
    '/api/reasons'
  );
  const out = new Map<number, ReasonMeta>();
  for (const r of raw) out.set(r.id, r);
  return out;
}

/** GET /api/categories -> Map<categoryId, name>. */
export async function fetchCategories(client: TIEClient): Promise<Map<number, string>> {
  const raw = await client.get<Array<{ id: number; name: string }>>('/api/categories');
  const out = new Map<number, string>();
  for (const c of raw) out.set(c.id, c.name);
  return out;
}

/**
 * Fetch the severity/enabled config for one checker under one profile. The
 * response carries the profile-wide default row (directoryId: null) plus any
 * per-directory override rows, all in one payload — we fold them into a
 * CheckerConfig with a default + per-directory maps.
 */
export async function fetchCheckerConfig(
  client: TIEClient,
  profileId: number,
  checkerId: number
): Promise<CheckerConfig> {
  const opts = await client.get<RawCheckerOption[]>(
    `/api/profiles/${profileId}/checkers/${checkerId}/checker-options?staged=0`
  );
  const cfg: CheckerConfig = {
    defaultCriticity: null,
    criticityByDirectory: new Map(),
    defaultEnabled: true,
    enabledByDirectory: new Map(),
  };
  for (const o of opts) {
    if (o.codename === 'O-CRITICITY') {
      const n = Number(o.value);
      const v = Number.isNaN(n) ? null : n;
      if (o.directoryId === null) cfg.defaultCriticity = v;
      else if (v !== null) cfg.criticityByDirectory.set(o.directoryId, v);
    } else if (o.codename === 'O-ENABLED') {
      const v = o.value === 'true';
      if (o.directoryId === null) cfg.defaultEnabled = v;
      else cfg.enabledByDirectory.set(o.directoryId, v);
    }
  }
  return cfg;
}

/** Resolve the effective criticity for a (checker, directory), falling back to the default. */
export function effectiveCriticity(cfg: CheckerConfig | undefined, directoryId: number): number | null {
  if (!cfg) return null;
  return cfg.criticityByDirectory.get(directoryId) ?? cfg.defaultCriticity;
}

/** Resolve the effective enabled state for a (checker, directory), falling back to the default. */
export function effectiveEnabled(cfg: CheckerConfig | undefined, directoryId: number): boolean {
  if (!cfg) return true; // absent config -> assume enabled (don't hide findings on a fetch gap)
  return cfg.enabledByDirectory.get(directoryId) ?? cfg.defaultEnabled;
}
