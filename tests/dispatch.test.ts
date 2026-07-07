/**
 * Tests for the generic dispatcher (src/dispatch.ts).
 *
 * Uses a fake TIEClient that records each call instead of making HTTP requests,
 * so we can assert exactly how a descriptor + args become an HTTP request:
 * path substitution, query building, body placement, and method routing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../src/dispatch.js';
import type { TIEClient } from '../src/client.js';
import type { ToolDescriptor } from '../src/generated/tools.js';

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  config?: unknown;
}

/** A fake client that records the last call and returns a sentinel value. */
function makeFakeClient(): { client: TIEClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fake = {
    get(path: string, config?: unknown) {
      calls.push({ method: 'get', path, config });
      return Promise.resolve('GET_RESULT');
    },
    delete(path: string, config?: unknown) {
      calls.push({ method: 'delete', path, config });
      return Promise.resolve('DELETE_RESULT');
    },
    post(path: string, body?: unknown, config?: unknown) {
      calls.push({ method: 'post', path, body, config });
      return Promise.resolve('POST_RESULT');
    },
    put(path: string, body?: unknown, config?: unknown) {
      calls.push({ method: 'put', path, body, config });
      return Promise.resolve('PUT_RESULT');
    },
    patch(path: string, body?: unknown, config?: unknown) {
      calls.push({ method: 'patch', path, body, config });
      return Promise.resolve('PATCH_RESULT');
    },
  };
  return { client: fake as unknown as TIEClient, calls };
}

/** Build a descriptor with sensible defaults for the fields under test. */
function descriptor(overrides: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: 'test_tool',
    description: 'test',
    category: 'Test',
    safety: 'read',
    method: 'get',
    path: '/api/test',
    pathParams: [],
    queryParams: [],
    hasBody: false,
    licenseTypes: [],
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  };
}

test('substitutes and URL-encodes path parameters', async () => {
  const { client, calls } = makeFakeClient();
  const d = descriptor({
    method: 'get',
    path: '/api/infrastructures/{infrastructureId}/directories/{directoryId}',
    pathParams: ['infrastructureId', 'directoryId'],
  });

  await dispatchTool(client, d, { infrastructureId: 3, directoryId: 'a/b c' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/infrastructures/3/directories/a%2Fb%20c');
});

test('throws on missing, null, or empty path parameter', async () => {
  const { client } = makeFakeClient();
  const d = descriptor({ path: '/api/x/{id}', pathParams: ['id'] });

  for (const bad of [undefined, null, '']) {
    await assert.rejects(
      () => dispatchTool(client, d, { id: bad }),
      /Missing required path parameter: id/
    );
  }
});

test('includes only supplied declared query params', async () => {
  const { client, calls } = makeFakeClient();
  const d = descriptor({
    method: 'get',
    path: '/api/things',
    queryParams: ['limit', 'offset', 'sort'],
  });

  // `sort` not supplied; `offset` explicitly null -> both omitted.
  await dispatchTool(client, d, { limit: 10, offset: null, extra: 'ignored' });

  assert.deepEqual(calls[0].config, { params: { limit: 10 } });
});

test('omits the params config entirely when no query params are supplied', async () => {
  const { client, calls } = makeFakeClient();
  const d = descriptor({ method: 'get', path: '/api/things', queryParams: ['limit'] });

  await dispatchTool(client, d, {});

  assert.equal(calls[0].config, undefined);
});

test('passes body only when descriptor.hasBody is true', async () => {
  const { client, calls } = makeFakeClient();
  const withBody = descriptor({ method: 'post', path: '/api/x', hasBody: true });
  const withoutBody = descriptor({ method: 'post', path: '/api/y', hasBody: false });

  await dispatchTool(client, withBody, { body: { name: 'n' } });
  await dispatchTool(client, withoutBody, { body: { name: 'n' } });

  assert.deepEqual(calls[0].body, { name: 'n' });
  assert.equal(calls[1].body, undefined);
});

test('routes GET and DELETE with (path, config) signature', async () => {
  const { client, calls } = makeFakeClient();
  await dispatchTool(client, descriptor({ method: 'get', path: '/api/g' }), {});
  await dispatchTool(client, descriptor({ method: 'delete', path: '/api/d' }), {});

  assert.equal(calls[0].method, 'get');
  assert.equal(calls[1].method, 'delete');
  // config is the 2nd arg for these verbs; body is never recorded
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].body, undefined);
});

test('routes POST, PUT, PATCH with (path, body, config) signature', async () => {
  const { client, calls } = makeFakeClient();
  const args = { body: { k: 'v' }, q: 1 };
  await dispatchTool(client, descriptor({ method: 'post', path: '/api/p', hasBody: true, queryParams: ['q'] }), args);
  await dispatchTool(client, descriptor({ method: 'put', path: '/api/u', hasBody: true, queryParams: ['q'] }), args);
  await dispatchTool(client, descriptor({ method: 'patch', path: '/api/c', hasBody: true, queryParams: ['q'] }), args);

  for (const call of calls) {
    assert.deepEqual(call.body, { k: 'v' });
    assert.deepEqual(call.config, { params: { q: 1 } });
  }
});

test('returns the client response unchanged', async () => {
  const { client } = makeFakeClient();
  const result = await dispatchTool(client, descriptor({ method: 'get' }), {});
  assert.equal(result, 'GET_RESULT');
});

test('throws on an unsupported HTTP method', async () => {
  const { client } = makeFakeClient();
  const d = descriptor({ method: 'head' as unknown as ToolDescriptor['method'] });
  await assert.rejects(() => dispatchTool(client, d, {}), /Unsupported HTTP method: head/);
});
