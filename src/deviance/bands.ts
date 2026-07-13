/**
 * Map TIE's raw 0–100 integers to the tier labels the web UI shows but the API
 * hides. Both mappings were verified empirically against the console UI
 * (see memory: tie-severity-remediation-bands).
 *
 * SEVERITY comes from the per-profile checker option `O-CRITICITY` (an integer);
 * REMEDIATION from the checker's static `remediationCost`. The UI sorts IOEs by
 * severity band then remediationCost, but exposes only the bands — we surface
 * BOTH the raw number and the band so a caller can sort/filter on either axis.
 *
 * Facts, not verdicts: we translate Tenable's own numbers, we don't re-score.
 */

export type SeverityBand = 'Critical' | 'High' | 'Medium' | 'Low' | 'Unknown';
export type RemediationBand = 'Low' | 'Medium' | 'High' | 'Unknown';

/**
 * Severity band from an O-CRITICITY integer. Thresholds confirmed against the UI:
 * Critical ≥ 80, High 60–79, Medium 34–59, Low < 34. Every UI-confirmed checker
 * and every gap in the observed value set is consistent with these cutoffs.
 */
export function severityBand(criticity: number | null | undefined): SeverityBand {
  if (criticity === null || criticity === undefined || Number.isNaN(criticity)) return 'Unknown';
  if (criticity >= 80) return 'Critical';
  if (criticity >= 60) return 'High';
  if (criticity >= 34) return 'Medium';
  return 'Low';
}

/**
 * Remediation-effort band from a remediationCost integer. The UI shows Low/
 * Medium/High; the values fall into equal thirds of 0–100 (verified: cost 40 =
 * Medium, 60 = Medium, 70+ = High, ≤20 = Low).
 */
export function remediationBand(cost: number | null | undefined): RemediationBand {
  if (cost === null || cost === undefined || Number.isNaN(cost)) return 'Unknown';
  if (cost <= 33) return 'Low';
  if (cost <= 66) return 'Medium';
  return 'High';
}

/** Rank a severity band for sorting (higher = more severe). */
export function severityRank(band: SeverityBand): number {
  switch (band) {
    case 'Critical':
      return 4;
    case 'High':
      return 3;
    case 'Medium':
      return 2;
    case 'Low':
      return 1;
    default:
      return 0;
  }
}

/** The severity bands in descending order — for building empty count buckets. */
export const SEVERITY_BANDS: readonly SeverityBand[] = ['Critical', 'High', 'Medium', 'Low'];
