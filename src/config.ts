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
   * full-directory scan. Off by default: the scan is expensive and pointless for
   * sessions that never search AD objects (and doubles across multi-environment
   * setups). Enable with TIE_WARM_CACHE=true.
   */
  warmCache: boolean;
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
    warmCache: process.env.TIE_WARM_CACHE === 'true',
  };
}
