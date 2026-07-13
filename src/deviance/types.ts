/**
 * Shared types for the deviance index and the identity-360 tools.
 *
 * A DevianceRecord is the enriched, self-contained form of a raw TIE deviance:
 * the original identifiers plus the joined checker / reason metadata and the
 * severity / remediation bands. The store builds these once; the tools project
 * them into the per-identity view.
 */

import type { SeverityBand, RemediationBand } from './bands.js';

/** The raw deviance shape as returned by list_deviances_by_directory. */
export interface RawDeviance {
  id: number;
  checkerId: number;
  profileId: number;
  adObjectId: number;
  directoryId: number;
  reasonId: number;
  resolvedEventId: number | null;
  resolvedAt: string | null;
  ignoreUntil: string | null;
  createdEventId: number | null;
  eventDate: string;
  attributes: Array<{ name: string; value: string; valueType?: string }>;
  devianceProviderId: string;
  description?: { template: string; replacements?: Array<{ name: string; valueType: string }> };
}

/** Checker metadata (static, from list_checkers). */
export interface CheckerMeta {
  id: number;
  codename: string;
  name: string;
  categoryId: number | null;
  remediationCost: number | null;
}

/** A reason (from the global list_reasons). */
export interface ReasonMeta {
  id: number;
  codename: string;
  name: string;
  description: string;
}

/** Severity/enabled config for a checker under a profile, with per-directory overrides. */
export interface CheckerConfig {
  /** O-CRITICITY on the profile-wide default row (directoryId: null). */
  defaultCriticity: number | null;
  /** directoryId -> O-CRITICITY override. */
  criticityByDirectory: Map<number, number>;
  /** O-ENABLED on the profile-wide default row. */
  defaultEnabled: boolean;
  /** directoryId -> O-ENABLED override. */
  enabledByDirectory: Map<number, boolean>;
}

/** How an identity relates to a deviance. */
export type Layer = 'target' | 'trustee' | 'inherited';

/** The enriched, self-contained deviance the tools return. */
export interface EnrichedDeviance {
  devianceId: number;
  checker: { id: number; codename: string; name: string; categoryId: number | null; categoryName: string | null };
  reason: { id: number; codename: string | null; name: string | null; description: string | null };
  severity: { criticity: number | null; band: SeverityBand };
  remediation: { cost: number | null; band: RemediationBand };
  enabled: boolean;
  status: { resolved: boolean; ignored: boolean; ignoreUntil: string | null };
  eventDate: string;
  directoryId: number;
  adObjectId: number;
  description: string | null;
  deeplink: string;
  deeplinkFilterHint: string;
  ref: {
    devianceProviderId: string;
    profileId: number;
    checkerId: number;
    adObjectId: number;
    directoryId: number;
    reasonId: number;
    createdEventId: number | null;
  };
}
