/**
 * In-memory store of every AD object, built from one full paginated scan of
 * GET /api/ad-objects and queried with the expression language in ./query.
 *
 * Why this exists: the TIE API has no server-side filter on ad-objects — the
 * only way to find objects by attribute is to page through the entire directory
 * (tens of thousands of objects). Doing that on every lookup is wasteful, so we
 * scan once, normalize each object's attributes into a typed map, and keep the
 * result in memory behind a TTL. Subsequent queries run in-process for free
 * until the snapshot expires.
 *
 * Each stored record keeps:
 *   - the object's identity (id, objectId, type LDAP|SYSVOL, directoryId) as
 *     queryable fields, so `type=LDAP` and `directoryid=1` work; and
 *   - every attribute decoded via normalizeAttributeValue, keyed by lower-cased
 *     name so lookups are case-insensitive.
 *
 * The original object (raw attributes) is retained alongside the flattened form
 * so tools can return full fidelity while queries run against the flat map.
 */

import type { TIEClient } from './client.js';
import { normalizeAttributeValue, type NormalizedValue } from './query/value.js';
import { parseQuery } from './query/parser.js';
import { evaluate, type QueryRecord } from './query/evaluate.js';
import { buildSchemaMap, type SchemaMap } from './graph/schema-map.js';
import { ControlGraph, type GraphProgress } from './graph/graph.js';

/** The raw ad-object shape returned by the API. */
interface RawADObject {
  id: number;
  objectId: string;
  type: string;
  directoryId: number;
  objectAttributes: Array<{ name: string; value: string; valueType: string }>;
}

/** A stored object: identity + flattened queryable map + the raw original. */
export interface StoredADObject {
  id: number;
  objectId: string;
  type: string;
  directoryId: number;
  /** Lower-cased attribute name -> decoded value; includes identity fields. */
  record: QueryRecord;
  /** The untouched API object, for full-fidelity responses. */
  raw: RawADObject;
}

/** Page size TIE returns; also our "last page" heuristic. */
const PAGE_SIZE = 1000;

/** Safety cap so a broken cursor can't loop forever. */
const MAX_PAGES = 200;

/** Default snapshot lifetime: 1 day. AD/TIE state changes slowly relative to a
 * session, and a full rescan is expensive, so we favour cheap reuse and let
 * callers pass `refresh: true` when they need current data. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoreOptions {
  /** How long a built snapshot stays valid, in ms. Default {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

/**
 * Progress reporter invoked once per fetched page during a scan. `pages` and
 * `objects` are cumulative; there is no known total ahead of time (the API
 * doesn't report a count), so consumers should treat this as indeterminate
 * progress. Kept transport-agnostic so the store has no MCP dependency.
 */
export type ScanProgress = (info: { pages: number; objects: number }) => void;

export class ADObjectStore {
  private objects: StoredADObject[] = [];
  /** objectSid (lower-case) -> display name, for resolving ACE trustees. */
  private sidIndex = new Map<string, string>();
  /** Lazily built GUID -> schema name map (from the resident schema objects). */
  private schemaMap: SchemaMap | null = null;
  /** Optional control graph, bound to the current snapshot generation. */
  private graph: ControlGraph | null = null;
  private graphState: 'absent' | 'building' | 'ready' = 'absent';
  private graphBuilding: Promise<void> | null = null;
  private builtAt = 0;
  private building: Promise<void> | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly client: TIEClient,
    options: StoreOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** True when we have a snapshot that hasn't expired (ttlMs of 0 is never fresh). */
  private isFresh(now: number): boolean {
    return this.objects.length > 0 && now - this.builtAt < this.ttlMs;
  }

  /**
   * Ensure a fresh snapshot exists, building one if needed. Concurrent callers
   * share a single in-flight build rather than each launching their own scan.
   *
   * `onProgress` is attached only to a build this call actually starts; a caller
   * that joins an in-flight build won't receive its page events (the build was
   * already reporting to whoever launched it). This keeps the semantics simple
   * and avoids multiplexing one scan's progress to many request tokens.
   */
  async ensureLoaded(
    force = false,
    onProgress?: ScanProgress,
    now: number = Date.now()
  ): Promise<void> {
    if (!force && this.isFresh(now)) return;
    if (this.building) return this.building;

    this.building = this.build(onProgress)
      .then(() => {
        this.builtAt = Date.now();
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  /**
   * Eagerly build the snapshot (used for optional startup warming). Safe to call
   * alongside user queries: it shares the same in-flight build dedup.
   */
  async warm(onProgress?: ScanProgress): Promise<void> {
    return this.ensureLoaded(false, onProgress);
  }

  /** Page through every ad-object and normalize it into the store. */
  private async build(onProgress?: ScanProgress): Promise<void> {
    const collected: StoredADObject[] = [];
    let lastId = 0;
    let pages = 0;

    while (pages < MAX_PAGES) {
      pages++;
      const resp = await this.client.get<{
        _embedded?: {
          'ad-objects'?: RawADObject[];
          'ad-object'?: RawADObject[];
        };
      }>(`/api/ad-objects?lastIdentifierSeen=${lastId}`);

      // Runtime uses the plural key; the OpenAPI schema names it singular.
      const batch =
        resp._embedded?.['ad-objects'] ?? resp._embedded?.['ad-object'] ?? [];
      if (batch.length === 0) break;

      for (const raw of batch) collected.push(this.toStored(raw));
      onProgress?.({ pages, objects: collected.length });

      const newLast = batch[batch.length - 1].id;
      if (newLast === lastId) break; // cursor not advancing; avoid infinite loop
      lastId = newLast;

      if (batch.length < PAGE_SIZE) break; // last (partial) page
    }

    this.objects = collected;

    // Rebuild the SID index and invalidate the derived schema map so both
    // reflect the new snapshot generation.
    this.sidIndex = new Map();
    for (const obj of collected) {
      const sid = obj.record['objectsid'];
      if (typeof sid === 'string') {
        const name =
          (typeof obj.record['samaccountname'] === 'string' &&
            obj.record['samaccountname']) ||
          (typeof obj.record['cn'] === 'string' && obj.record['cn']) ||
          null;
        if (name) this.sidIndex.set(sid.toLowerCase(), name as string);
      }
    }
    this.schemaMap = null;

    // A new snapshot invalidates any derived control graph.
    this.graph = null;
    this.graphState = 'absent';
  }

  /** Resolve an object SID to a display name from the resident snapshot. */
  resolveSid(sid: string): string | null {
    return this.sidIndex.get(sid.toLowerCase()) ?? null;
  }

  /** GUID -> schema name map, built once per snapshot from resident objects. */
  getSchemaMap(): SchemaMap {
    if (!this.schemaMap) this.schemaMap = buildSchemaMap(this.objects);
    return this.schemaMap;
  }

  /**
   * Build the control graph from the current snapshot (opt-in; runs after warm).
   * Ensures the snapshot is loaded first. Concurrent callers share one build.
   * The graph is bound to this snapshot generation and invalidated on rebuild.
   */
  async buildGraph(onProgress?: GraphProgress): Promise<void> {
    await this.ensureLoaded(false);
    if (this.graphState === 'ready') return;
    if (this.graphBuilding) return this.graphBuilding;

    this.graphState = 'building';
    this.graphBuilding = Promise.resolve()
      .then(() => {
        this.graph = ControlGraph.build(this.objects, onProgress);
        this.graphState = 'ready';
      })
      .finally(() => {
        this.graphBuilding = null;
      });
    return this.graphBuilding;
  }

  /** The control graph if ready, else null. */
  getGraph(): ControlGraph | null {
    return this.graphState === 'ready' ? this.graph : null;
  }

  /** Graph lifecycle state + stats, for tool responses. */
  graphStatus(): {
    state: 'absent' | 'building' | 'ready';
    stats: ReturnType<ControlGraph['stats']> | null;
  } {
    return {
      state: this.graphState,
      stats: this.graphState === 'ready' && this.graph ? this.graph.stats() : null,
    };
  }

  /** Flatten one raw object into identity fields + decoded attribute map. */
  private toStored(raw: RawADObject): StoredADObject {
    const record: QueryRecord = {
      // Identity fields, queryable like any attribute.
      id: raw.id,
      objectid: raw.objectId,
      type: raw.type,
      directoryid: raw.directoryId,
    };

    for (const attr of raw.objectAttributes) {
      const key = attr.name.toLowerCase();
      const value: NormalizedValue = normalizeAttributeValue(
        attr.value,
        attr.valueType
      );
      // If TIE ever repeats a name, keep the first; names are unique in practice.
      if (!(key in record)) record[key] = value;
    }

    return {
      id: raw.id,
      objectId: raw.objectId,
      type: raw.type,
      directoryId: raw.directoryId,
      record,
      raw,
    };
  }

  /**
   * Run an expression against the loaded snapshot and return matching objects.
   * Loads/refreshes the snapshot first. `limit` caps the number returned
   * (0 = no cap); the total match count is reported separately.
   */
  async query(
    expression: string,
    opts: { limit?: number; force?: boolean; onProgress?: ScanProgress } = {}
  ): Promise<{ total: number; returned: StoredADObject[] }> {
    // Parse first so a bad expression fails fast, before any (slow) scan.
    const ast = parseQuery(expression);
    await this.ensureLoaded(opts.force ?? false, opts.onProgress);

    const matches: StoredADObject[] = [];
    for (const obj of this.objects) {
      if (evaluate(ast, obj.record)) matches.push(obj);
    }

    const limit = opts.limit ?? 0;
    const returned = limit > 0 ? matches.slice(0, limit) : matches;
    return { total: matches.length, returned };
  }

  /**
   * Fast single-object lookup by a common identifier. Loads the snapshot first,
   * then scans the in-memory records. Case-insensitive.
   */
  async lookup(
    by: 'dn' | 'sid' | 'sam',
    value: string,
    opts: { force?: boolean; onProgress?: ScanProgress } = {}
  ): Promise<StoredADObject | null> {
    await this.ensureLoaded(opts.force ?? false, opts.onProgress);
    const field =
      by === 'dn' ? 'distinguishedname' : by === 'sid' ? 'objectsid' : 'samaccountname';
    const target = value.trim().toLowerCase();

    for (const obj of this.objects) {
      const v = obj.record[field];
      if (typeof v === 'string' && v.toLowerCase() === target) return obj;
    }
    return null;
  }

  /** Snapshot metadata for diagnostics / tool responses. */
  stats(): {
    count: number;
    builtAt: number;
    ageMs: number;
    ttlMs: number;
    fresh: boolean;
  } {
    const now = Date.now();
    return {
      count: this.objects.length,
      builtAt: this.builtAt,
      ageMs: this.builtAt ? now - this.builtAt : -1,
      ttlMs: this.ttlMs,
      fresh: this.isFresh(now),
    };
  }
}
