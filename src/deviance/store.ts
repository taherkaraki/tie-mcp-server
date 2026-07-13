/**
 * In-memory index of every IOE deviance, built from paginated scans of
 * GET /api/infrastructures/{i}/directories/{d}/deviances across all directories,
 * scoped to one profile, and enriched with checker / reason / severity metadata.
 *
 * Why this exists (mirrors ADObjectStore): the per-object deviance endpoint only
 * returns findings where the object is the SUBJECT. It cannot answer "what
 * dangerous rights does this identity hold over OTHER objects?" — that requires
 * scanning every deviance's embedded trustees. So we scan once, build a forward
 * index (byTargetObjectId) and a reverse index (byTrusteeKey), cache behind a
 * TTL, and let the tools project per-identity views for free until it expires.
 *
 * Lens-agnostic: the store holds facts (deviances, checkers, reasons, and their
 * relationships) and also indexes byChecker / byReason, so a future
 * weakness/checker-centric tool reuses the same store without re-plumbing.
 */

import type { TIEClient } from '../client.js';
import { DEFAULT_TTL_MS } from '../ad-object-store.js';
import { embeddedTrustees } from './trustees.js';
import {
  fetchCheckerMeta,
  fetchReasons,
  fetchCategories,
  fetchCheckerConfig,
} from './joins.js';
import type { RawDeviance, CheckerMeta, ReasonMeta, CheckerConfig } from './types.js';

/** The deviance endpoint caps perPage at 500 (INVALID_PAGINATION above that). */
const PAGE_SIZE = 500;
const MAX_PAGES = 1000;

/** Progress reporter for the (potentially long) deviance scan. */
export type DevianceScanProgress = (info: { directories: number; deviances: number }) => void;

/** A topology entry: which (infrastructure, directory) pairs to scan. */
export interface DirectoryRef {
  infrastructureId: number;
  directoryId: number;
}

/** A reverse-index hit: a deviance that names some identity as a risky trustee. */
export interface TrusteeHit {
  devianceId: number;
  grantedRights: string[];
  resolvedFrom: string;
}

export interface DevianceStoreOptions {
  ttlMs?: number;
}

export class DevianceStore {
  /** All enriched-later raw deviances for the built profile, keyed by devianceId. */
  private byId = new Map<number, RawDeviance>();
  /** adObjectId -> devianceIds filed directly on that object (forward / target layer). */
  private byTargetObjectId = new Map<number, number[]>();
  /** trustee sid (lower) -> hits where that identity is the risky trustee (reverse layer). */
  private byTrusteeSid = new Map<string, TrusteeHit[]>();
  /** trustee DOMAIN\name or DN (lower) -> hits, for trustees that carried no SID. */
  private byTrusteeName = new Map<string, TrusteeHit[]>();
  /** checkerId -> devianceIds (lens-agnostic). */
  private byChecker = new Map<number, number[]>();
  /** reasonId -> devianceIds (lens-agnostic; gives per-reason counts free). */
  private byReason = new Map<number, number[]>();

  // Join tables.
  private checkerMeta = new Map<number, CheckerMeta>();
  private reasons = new Map<number, ReasonMeta>();
  private categories = new Map<number, string>();
  /** checkerId -> severity/enabled config for the built profile (lazy-filled). */
  private checkerConfig = new Map<number, CheckerConfig>();

  private profileId: number | null = null;
  private builtAt = 0;
  private building: Promise<void> | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly client: TIEClient,
    options: DevianceStoreOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private isFresh(now: number, profileId: number): boolean {
    return this.byId.size >= 0 && this.builtAt > 0 && this.profileId === profileId && now - this.builtAt < this.ttlMs;
  }

  /**
   * Ensure a fresh index exists for `profileId`, building if needed. A build for
   * a different profile invalidates the current one (severity is profile-scoped).
   * Concurrent callers share one in-flight build.
   */
  async ensureLoaded(
    profileId: number,
    directories: DirectoryRef[],
    opts: { force?: boolean; onProgress?: DevianceScanProgress; now?: number } = {}
  ): Promise<void> {
    const now = opts.now ?? Date.now();
    if (!opts.force && this.isFresh(now, profileId)) return;
    if (this.building) return this.building;

    this.building = this.build(profileId, directories, opts.onProgress)
      .then(() => {
        this.builtAt = Date.now();
        this.profileId = profileId;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  /** Scan all directories for the profile, then build indexes + join tables. */
  private async build(
    profileId: number,
    directories: DirectoryRef[],
    onProgress?: DevianceScanProgress
  ): Promise<void> {
    // Reset all state for the new generation.
    this.byId = new Map();
    this.byTargetObjectId = new Map();
    this.byTrusteeSid = new Map();
    this.byTrusteeName = new Map();
    this.byChecker = new Map();
    this.byReason = new Map();
    this.checkerConfig = new Map();

    // Join tables that don't depend on the scan: fetch in parallel.
    const [checkerMeta, reasons, categories] = await Promise.all([
      fetchCheckerMeta(this.client),
      fetchReasons(this.client),
      fetchCategories(this.client).catch(() => new Map<number, string>()),
    ]);
    this.checkerMeta = checkerMeta;
    this.reasons = reasons;
    this.categories = categories;

    let scanned = 0;
    for (let d = 0; d < directories.length; d++) {
      const { infrastructureId, directoryId } = directories[d];
      let lastId = 0;
      let pages = 0;
      while (pages < MAX_PAGES) {
        pages++;
        const batch = await this.client.get<RawDeviance[]>(
          `/api/infrastructures/${infrastructureId}/directories/${directoryId}/deviances` +
            `?perPage=${PAGE_SIZE}&lastIdentifierSeen=${lastId}`
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const dev of batch) {
          // Scope to the requested profile: the endpoint interleaves profiles,
          // and severity is profile-specific. Dedup key is then just devianceId.
          if (dev.profileId !== profileId) continue;
          this.indexOne(dev);
          scanned++;
        }
        onProgress?.({ directories: d + 1, deviances: scanned });
        const newLast = batch[batch.length - 1].id;
        if (newLast === lastId) break; // cursor stalled
        lastId = newLast;
        if (batch.length < PAGE_SIZE) break; // last partial page
      }
    }
  }

  /** Add one raw deviance to every index. */
  private indexOne(dev: RawDeviance): void {
    if (this.byId.has(dev.id)) return; // devianceId is unique within a profile
    this.byId.set(dev.id, dev);

    push(this.byTargetObjectId, dev.adObjectId, dev.id);
    push(this.byChecker, dev.checkerId, dev.id);
    push(this.byReason, dev.reasonId, dev.id);

    // Reverse (trustee) index: pull embedded principals out of the attributes.
    for (const t of embeddedTrustees(dev.attributes ?? [])) {
      const hit: TrusteeHit = {
        devianceId: dev.id,
        grantedRights: t.grantedRights,
        resolvedFrom: t.resolvedFrom,
      };
      if (t.sid) push(this.byTrusteeSid, t.sid, hit);
      else if (t.name) push(this.byTrusteeName, t.name.toLowerCase(), hit);
    }
  }

  /**
   * Ensure severity/enabled config is loaded for the given checkerIds under the
   * built profile. Lazy: only the checkers actually referenced by a query are
   * fetched (identity-360 touches a handful, not all 64). Cached across calls.
   */
  async ensureCheckerConfig(checkerIds: Iterable<number>): Promise<void> {
    if (this.profileId === null) return;
    const missing = [...new Set(checkerIds)].filter((id) => !this.checkerConfig.has(id));
    if (missing.length === 0) return;
    const fetched = await Promise.all(
      missing.map((id) =>
        fetchCheckerConfig(this.client, this.profileId!, id)
          .then((cfg) => [id, cfg] as const)
          .catch(() => [id, null] as const)
      )
    );
    for (const [id, cfg] of fetched) if (cfg) this.checkerConfig.set(id, cfg);
  }

  // --- read accessors used by the tools (piece 3) ---

  getRaw(devianceId: number): RawDeviance | undefined {
    return this.byId.get(devianceId);
  }
  forwardFor(adObjectId: number): readonly number[] {
    return this.byTargetObjectId.get(adObjectId) ?? [];
  }
  reverseForSid(sid: string): readonly TrusteeHit[] {
    return this.byTrusteeSid.get(sid.toLowerCase()) ?? [];
  }
  reverseForName(name: string): readonly TrusteeHit[] {
    return this.byTrusteeName.get(name.toLowerCase()) ?? [];
  }
  checkerFor(id: number): CheckerMeta | undefined {
    return this.checkerMeta.get(id);
  }
  reasonFor(id: number): ReasonMeta | undefined {
    return this.reasons.get(id);
  }
  categoryName(id: number | null): string | null {
    return id === null ? null : this.categories.get(id) ?? null;
  }
  configFor(id: number): CheckerConfig | undefined {
    return this.checkerConfig.get(id);
  }

  stats(): { deviances: number; profileId: number | null; builtAt: number; ageMs: number; ttlMs: number; fresh: boolean } {
    const now = Date.now();
    return {
      deviances: this.byId.size,
      profileId: this.profileId,
      builtAt: this.builtAt,
      ageMs: this.builtAt ? now - this.builtAt : -1,
      ttlMs: this.ttlMs,
      fresh: this.profileId !== null && this.isFresh(now, this.profileId),
    };
  }
}

/** Push a value onto a Map<K, V[]> bucket, creating the array if needed. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
