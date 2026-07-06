/**
 * Generic tool dispatcher.
 *
 * Every TIE MCP tool is described by a `ToolDescriptor` (see
 * src/generated/tools.ts). Rather than hand-writing 131 handlers, this module
 * turns a descriptor plus the caller's arguments into a single HTTP request:
 * path params fill the URL template, query params become the query string, and
 * `body` becomes the request payload.
 */

import type { TIEClient } from './client.js';
import type { ToolDescriptor } from './generated/tools.js';

/** Substitute {param} placeholders in the path template with encoded values. */
function buildPath(descriptor: ToolDescriptor, args: Record<string, unknown>): string {
  return descriptor.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** Collect declared query params that were actually supplied. */
function buildQuery(
  descriptor: ToolDescriptor,
  args: Record<string, unknown>
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const name of descriptor.queryParams) {
    if (args[name] !== undefined && args[name] !== null) {
      params[name] = args[name];
    }
  }
  return params;
}

/**
 * Execute the API call described by `descriptor` with the given `args`.
 * Returns the parsed response body from the TIE API.
 */
export async function dispatchTool(
  client: TIEClient,
  descriptor: ToolDescriptor,
  args: Record<string, unknown>
): Promise<unknown> {
  const path = buildPath(descriptor, args);
  const query = buildQuery(descriptor, args);
  const hasQuery = Object.keys(query).length > 0;
  const requestConfig = hasQuery ? { params: query } : undefined;
  const body = descriptor.hasBody ? args.body : undefined;

  switch (descriptor.method) {
    case 'get':
      return client.get(path, requestConfig);
    case 'delete':
      return client.delete(path, requestConfig);
    case 'post':
      return client.post(path, body, requestConfig);
    case 'put':
      return client.put(path, body, requestConfig);
    case 'patch':
      return client.patch(path, body, requestConfig);
    default:
      throw new Error(`Unsupported HTTP method: ${descriptor.method}`);
  }
}
