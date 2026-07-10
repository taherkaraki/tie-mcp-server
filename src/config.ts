/**
 * Configuration for TIE MCP Server
 * Reads from environment variables set by MCP client
 */

export interface TIEConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
  /**
   * When true, eagerly scan and build the AD-object snapshot at startup so the
   * first `query_ad_objects`/`get_ad_object` call is fast instead of paying the
   * full-directory scan (~100s on a large tenant). On by default: warming runs
   * in the background after connect(), so it never delays startup, and a query
   * arriving mid-scan simply joins the in-flight build. Set TIE_WARM_CACHE=false
   * to disable (e.g. to avoid the startup scan on a tenant you never search, or
   * to reduce load when running many server instances).
   */
  warmCache: boolean;
  /**
   * How long a built AD-object snapshot is considered fresh, in ms. After this
   * the next query rescans. Undefined uses the store default (1 day). Override
   * with TIE_CACHE_TTL_MS to trade freshness for scan cost.
   */
  cacheTtlMs?: number;
  /**
   * When true, build the control graph (attack-path / blast-radius / asset-
   * exposure edges) in the background *after* the attribute snapshot warms. Off
   * by default: it is tens of seconds of extra CPU + memory, wasted on sessions
   * that don't do relationship analysis. Enable with TIE_BUILD_GRAPH=true.
   */
  buildGraph: boolean;
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): TIEConfig {
  const baseUrl = process.env.TIE_BASE_URL;
  const apiKey = process.env.TIE_API_KEY;

  if (!baseUrl) {
    throw new Error('TIE_BASE_URL environment variable is required');
  }

  if (!apiKey) {
    throw new Error('TIE_API_KEY environment variable is required');
  }

  // Remove trailing slash from base URL if present
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  return {
    baseUrl: normalizedBaseUrl,
    apiKey,
    timeout: process.env.TIE_TIMEOUT ? parseInt(process.env.TIE_TIMEOUT, 10) : 30000,
    maxRetries: process.env.TIE_MAX_RETRIES ? parseInt(process.env.TIE_MAX_RETRIES, 10) : 3,
    // On by default; only an explicit "false" disables warming.
    warmCache: process.env.TIE_WARM_CACHE !== 'false',
    cacheTtlMs: process.env.TIE_CACHE_TTL_MS
      ? parseInt(process.env.TIE_CACHE_TTL_MS, 10)
      : undefined,
    buildGraph: process.env.TIE_BUILD_GRAPH === 'true',
  };
}
