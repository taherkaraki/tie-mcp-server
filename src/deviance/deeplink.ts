/**
 * Build deep-links into the Tenable Identity Exposure web UI for a deviance.
 *
 * The UI links an Indicator of Exposure at the CHECKER + PROFILE level; you
 * cannot deep-link to an individual deviance or object via the URL (verified
 * against the console — see memory: tie-ioe-deeplink-format). To narrow to one
 * object you type `id:"<adObjectId>"` into the on-page filter field, which the
 * URL does not encode — so we return that as a separate "filter hint".
 *
 * Template:
 *   {base}/profile/{profileNameLower}/indicators-of-exposure/ad/details/{checkerId}-{codename}/deviant-objects
 */

/** Slugify a profile name for the URL segment (lowercase; UI uses the name, not the id). */
export function profileSlug(profileName: string): string {
  return profileName.trim().toLowerCase();
}

/** The checker+profile IOE URL for a deviance. */
export function buildDeeplink(
  baseUrl: string,
  profileName: string,
  checkerId: number,
  checkerCodename: string
): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/profile/${profileSlug(profileName)}/indicators-of-exposure/ad/details/${checkerId}-${checkerCodename}/deviant-objects`;
}

/** The on-page filter string to narrow the deviant-objects list to one AD object. */
export function buildFilterHint(adObjectId: number): string {
  return `id:"${adObjectId}"`;
}

/** The literal template string, for surfacing in tool `meta`. */
export const DEEPLINK_TEMPLATE =
  '{base}/profile/{profileNameLower}/indicators-of-exposure/ad/details/{checkerId}-{codename}/deviant-objects';
