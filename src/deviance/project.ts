/**
 * Project raw deviances (+ the store's join tables) into the enriched,
 * self-contained records the identity-360 tools return: severity/remediation
 * bands, resolved reason/category, deeplinks, and layer/counterpart tagging.
 *
 * Pure over a DevianceStore's read accessors — no I/O — so it's easy to test.
 */

import type { DevianceStore } from './store.js';
import { effectiveCriticity, effectiveEnabled } from './joins.js';
import { severityBand, remediationBand, severityRank, SEVERITY_BANDS, type SeverityBand } from './bands.js';
import { buildDeeplink, buildFilterHint } from './deeplink.js';
import type { EnrichedDeviance, Layer } from './types.js';

/** Options that shape the projection (shared by both tools). */
export interface ProjectOptions {
  baseUrl: string;
  profileName: string;
  /** How to treat deviances from checkers disabled in this profile/directory. */
  disabledCheckers: 'exclude' | 'flag' | 'include';
  includeResolved: boolean;
  includeIgnored: boolean;
  minSeverityBand?: SeverityBand;
}

/** An enriched deviance plus the per-identity layer context. */
export interface LayeredDeviance extends EnrichedDeviance {
  layer: Layer;
  checkerDisabled: boolean;
  grantedRights?: string[];
  counterpart?: { role: string; name: string | null; objectId: number | null; dn: string | null; resolvedFrom?: string };
  deeplinkContext?: string;
}

/** Resolve the description template with its attribute replacements. */
function renderDescription(dev: ReturnType<DevianceStore['getRaw']>): string | null {
  if (!dev?.description?.template) return null;
  let out = dev.description.template;
  for (const attr of dev.attributes ?? []) {
    out = out.replace(new RegExp(`<%=\\s*${attr.name}\\s*%>`, 'g'), attr.value);
  }
  return out;
}

/**
 * Enrich a single raw deviance into the base output shape (no layer context).
 * Returns null if it should be filtered out (resolved/ignored/severity/disabled
 * per the options). `severityRank`-below-min and disabled+exclude drop here.
 */
export function enrichDeviance(
  store: DevianceStore,
  devianceId: number,
  opts: ProjectOptions
): (EnrichedDeviance & { checkerDisabled: boolean }) | null {
  const dev = store.getRaw(devianceId);
  if (!dev) return null;

  const resolved = dev.resolvedEventId !== null || dev.resolvedAt !== null;
  const ignored = dev.ignoreUntil !== null;
  if (resolved && !opts.includeResolved) return null;
  if (ignored && !opts.includeIgnored) return null;

  const cfg = store.configFor(dev.checkerId);
  const criticity = effectiveCriticity(cfg, dev.directoryId);
  const band = severityBand(criticity);
  if (opts.minSeverityBand && severityRank(band) < severityRank(opts.minSeverityBand)) return null;

  const enabled = effectiveEnabled(cfg, dev.directoryId);
  if (!enabled && opts.disabledCheckers === 'exclude') return null;

  const meta = store.checkerFor(dev.checkerId);
  const reason = store.reasonFor(dev.reasonId);
  const cost = meta?.remediationCost ?? null;

  return {
    checkerDisabled: !enabled,
    devianceId: dev.id,
    checker: {
      id: dev.checkerId,
      codename: meta?.codename ?? `checker-${dev.checkerId}`,
      name: meta?.name ?? `Checker ${dev.checkerId}`,
      categoryId: meta?.categoryId ?? null,
      categoryName: store.categoryName(meta?.categoryId ?? null),
    },
    reason: {
      id: dev.reasonId,
      codename: reason?.codename ?? null,
      name: reason?.name ?? null,
      description: reason?.description ?? null,
    },
    severity: { criticity, band },
    remediation: { cost, band: remediationBand(cost) },
    enabled,
    status: { resolved, ignored, ignoreUntil: dev.ignoreUntil },
    eventDate: dev.eventDate,
    directoryId: dev.directoryId,
    adObjectId: dev.adObjectId,
    description: renderDescription(dev),
    deeplink: buildDeeplink(opts.baseUrl, opts.profileName, dev.checkerId, meta?.codename ?? `${dev.checkerId}`),
    deeplinkFilterHint: buildFilterHint(dev.adObjectId),
    ref: {
      devianceProviderId: dev.devianceProviderId,
      profileId: dev.profileId,
      checkerId: dev.checkerId,
      adObjectId: dev.adObjectId,
      directoryId: dev.directoryId,
      reasonId: dev.reasonId,
      createdEventId: dev.createdEventId,
    },
  };
}

/** Default sort: severity band desc, then raw criticity desc, then remediationCost asc. */
export function sortDeviances(list: LayeredDeviance[]): LayeredDeviance[] {
  return list.sort((a, b) => {
    const byBand = severityRank(b.severity.band) - severityRank(a.severity.band);
    if (byBand !== 0) return byBand;
    const byCrit = (b.severity.criticity ?? -1) - (a.severity.criticity ?? -1);
    if (byCrit !== 0) return byCrit;
    return (a.remediation.cost ?? 999) - (b.remediation.cost ?? 999);
  });
}

/** Build an empty severity-band count bucket. */
export function emptyBandCounts(): Record<SeverityBand, number> {
  const out = {} as Record<SeverityBand, number>;
  for (const b of SEVERITY_BANDS) out[b] = 0;
  out.Unknown = 0;
  return out;
}

/** Roll up a list of layered deviances into the summary shape both tools use. */
export function summarize(list: LayeredDeviance[], suppressed: number): {
  total: number;
  bySeverityBand: Record<SeverityBand, number>;
  byLayer: Record<Layer, number>;
  highestSeverity: { band: SeverityBand; criticity: number | null } | null;
  suppressed: { count: number; reason: string };
} {
  const bySeverityBand = emptyBandCounts();
  const byLayer: Record<Layer, number> = { target: 0, trustee: 0, inherited: 0 };
  let highest: { band: SeverityBand; criticity: number | null } | null = null;
  for (const d of list) {
    bySeverityBand[d.severity.band]++;
    byLayer[d.layer]++;
    if (!highest || severityRank(d.severity.band) > severityRank(highest.band)) {
      highest = { band: d.severity.band, criticity: d.severity.criticity };
    }
  }
  return {
    total: list.length,
    bySeverityBand,
    byLayer,
    highestSeverity: highest,
    suppressed: { count: suppressed, reason: 'checker disabled in this profile/directory' },
  };
}
