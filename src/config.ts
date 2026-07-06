/**
 * Configuration for TIE MCP Server
 * Reads from environment variables set by MCP client
 */

export interface TIEConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
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
  };
}
