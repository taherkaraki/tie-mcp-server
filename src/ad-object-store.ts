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
import {
  hasObjectClass,
  credentialFactsFrom,
  PASSWORD_HASH_SCAN_CLASS,
} from './graph/credentials.js';

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

/** Safety cap, per scan worker, so a broken cursor can't loop forever. */
const MAX_PAGES = 200;

/** Defaults for the parallel warm scan (see StoreOptions). */
const DEFAULT_WARM_CONCURRENCY = 5;
const DEFAULT_WARM_CHUNK = 5000;

/** Default snapshot lifetime: 1 day. AD/TIE state changes slowly relative to a
 * session, and a full rescan is expensive, so we favour cheap reuse and let
 * callers pass `refresh: true` when they need current data. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoreOptions {
  /** How long a built snapshot stays valid, in ms. Default {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** Concurrent workers for the parallel id-window scan. Default 5. */
  warmConcurrency?: number;
  /** id-window size handed to each scan worker. Default 5000. */
  warmChunk?: number;
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
  private readonly warmConcurrency: number;
  private readonly warmChunk: number;

  constructor(
    private readonly client: TIEClient,
    options: StoreOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.warmConcurrency = Math.max(1, options.warmConcurrency ?? DEFAULT_WARM_CONCURRENCY);
    this.warmChunk = Math.max(1000, options.warmChunk ?? DEFAULT_WARM_CHUNK);
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

  /**
   * Fetch one page of ad-objects at cursor `lastId`. Returns the raw batch and
   * the NEXT cursor parsed from `_links.next` (the page's max id, authoritative
   * — the returned array is NOT sorted by id, so batch[last].id is wrong for
   * windowed scanning). `next` is null at the end of the directory.
   */
  private async page(
    lastId: number
  ): Promise<{ batch: RawADObject[]; next: number | null }> {
    const resp = await this.client.get<{
      _embedded?: { 'ad-objects'?: RawADObject[]; 'ad-object'?: RawADObject[] };
      _links?: { next?: string };
    }>(`/api/ad-objects?lastIdentifierSeen=${lastId}`);
    const batch = resp._embedded?.['ad-objects'] ?? resp._embedded?.['ad-object'] ?? [];
    let next: number | null = null;
    const nextUrl = resp._links?.next;
    if (nextUrl) {
      // `next` may be absolute or relative; parse the query param either way.
      const m = /[?&]lastIdentifierSeen=(\d+)/.exec(nextUrl);
      const n = m ? Number(m[1]) : NaN;
      if (Number.isFinite(n) && n > lastId) next = n; // must advance
    }
    return { batch, next };
  }

  /**
   * Drain one id-window [start, end): page from `start`, following the server's
   * `_links.next` cursor, appending raw objects, until the cursor passes `end`
   * (hand off to the next window) or the directory ends (`next == null`).
   * Returns the objects fetched and the last `next` cursor seen (null = the
   * worker reached the global end, i.e. no more objects exist beyond here).
   */
  private async fetchWindow(
    start: number,
    end: number,
    sink: (raw: RawADObject) => void,
    onPage: () => void
  ): Promise<{ reachedGlobalEnd: boolean }> {
    let cursor = start;
    let pages = 0;
    while (pages < MAX_PAGES) {
      pages++;
      const { batch, next } = await this.page(cursor);
      for (const raw of batch) sink(raw);
      onPage();
      if (next === null) return { reachedGlobalEnd: true }; // directory end
      cursor = next;
      if (cursor >= end) return { reachedGlobalEnd: false }; // window done
    }
    return { reachedGlobalEnd: false }; // safety cap hit; let dispenser continue
  }

  /**
   * Parallel id-window scan. A shared dispenser hands out window starts in
   * `warmChunk` steps (0, C, 2C, …); `warmConcurrency` workers each claim the
   * next start and drain its window. Windows cover disjoint id>N ranges and id
   * is unique, so the union == the full sequential set; a Map keyed by id
   * absorbs the small boundary overlap idempotently.
   *
   * Robust termination (handles sparse id spaces): we do NOT stop merely because
   * one window came back empty — a gap in the id space would falsely signal end.
   * Instead we track `frontier`, the highest window-start known to still have
   * data (any page returned objects, or `next` advanced past the window). The
   * dispenser keeps handing out starts until every claimed window at or below an
   * empty one is exhausted AND a worker has seen the true directory end
   * (`next == null`) OR all outstanding windows past the frontier came back
   * empty. Concretely: once a worker sees `next == null`, that id is the global
   * max; no start beyond it is dispensed, and in-flight higher windows resolve
   * empty and are discarded.
   */
  private async fetchAllParallel(onProgress?: ScanProgress): Promise<RawADObject[]> {
    const byId = new Map<number, RawADObject>();
    const chunk = this.warmChunk;
    let nextStart = 0; // dispenser cursor (in ids)
    let globalMax = Number.POSITIVE_INFINITY; // set when a worker hits next==null
    let pagesFetched = 0;

    const sink = (raw: RawADObject) => byId.set(raw.id, raw);
    const onPage = () => {
      pagesFetched++;
      onProgress?.({ pages: pagesFetched, objects: byId.size });
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const start = nextStart;
        // Don't dispense a window at or past the known directory end. globalMax
        // is the END of the window that saw next==null, and next==null means no
        // object has id > the last fetched id (which is < that window end), so
        // no object has id >= globalMax — skipping start >= globalMax is safe.
        if (start >= globalMax) return;
        nextStart += chunk;
        const { reachedGlobalEnd } = await this.fetchWindow(
          start,
          start + chunk,
          sink,
          onPage
        );
        if (reachedGlobalEnd) {
          // This window saw next==null: the last id it fetched is the global
          // max. Clamp the dispenser so no worker claims a higher window.
          globalMax = Math.min(globalMax, start + chunk);
        }
      }
    };

    const n = Math.max(1, this.warmConcurrency);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return [...byId.values()];
  }

  /** Page through every ad-object (in parallel) and normalize it into the store. */
  private async build(onProgress?: ScanProgress): Promise<void> {
    const raw = await this.fetchAllParallel(onProgress);
    this.objects = raw.map((r) => this.toStored(r));

    // Credential-weakness enrichment: fold each passwordHashScan companion
    // object onto the principal it describes (joined by distinguishedName), so
    // isbreached / is*blank / isweak become queryable attributes on the
    // principal. Scan objects themselves stay in `objects` (they're filtered out
    // of the control graph, not the store) but contribute their signal here.
    // (Phase 5a, CONTROL_GRAPH_DESIGN §10.3)
    const scanByDn = new Map<string, QueryRecord>();
    for (const obj of this.objects) {
      if (!hasObjectClass(obj.record, PASSWORD_HASH_SCAN_CLASS)) continue;
      const dn = obj.record['distinguishedname'];
      // Only Retrieved scans carry meaningful flags; skip empty-DN records.
      if (typeof dn === 'string' && dn) scanByDn.set(dn.toLowerCase(), obj.record);
    }
    if (scanByDn.size > 0) {
      for (const obj of this.objects) {
        if (hasObjectClass(obj.record, PASSWORD_HASH_SCAN_CLASS)) continue; // don't self-enrich
        const dn = obj.record['distinguishedname'];
        if (typeof dn !== 'string' || !dn) continue;
        const scan = scanByDn.get(dn.toLowerCase());
        if (!scan) continue;
        const facts = credentialFactsFrom(scan);
        // Fold derived facts onto the principal's queryable record. Don't clobber
        // a real same-named attribute the principal already has.
        for (const [k, v] of Object.entries(facts)) {
          if (v === undefined) continue;
          // Record keys are lower-cased throughout (query field lookup lower-
          // cases too), so fold with a lower-cased key or camelCase facts like
          // isweakByProfile become unreachable.
          const key = k.toLowerCase();
          if (key in obj.record) continue; // don't clobber a real attribute
          // The flat record holds only scalars/arrays; store the object-valued
          // isweakByProfile as its JSON string (matches how object-typed attrs
          // are normalized), so `:` contains-matching works on it.
          obj.record[key] =
            typeof v === 'object' ? (JSON.stringify(v) as NormalizedValue) : (v as NormalizedValue);
        }
      }
    }

    // Rebuild the SID index and invalidate the derived schema map so both
    // reflect the new snapshot generation.
    this.sidIndex = new Map();
    for (const obj of this.objects) {
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
