#!/usr/bin/env node
/**
 * TIE MCP tool generator.
 *
 * Parses the Tenable Identity Exposure OpenAPI spec and emits
 * `src/generated/tools.ts` — a flat array of tool descriptors, one per
 * operation. The MCP server consumes these descriptors with a single generic
 * dispatcher (see src/dispatch.ts), so there is no per-endpoint handler code.
 *
 * The spec has no operationIds, so tool names are derived deterministically
 * from the HTTP method + path + tag. Run with `--list` to print the derived
 * names grouped by category without writing any file.
 *
 * Usage:
 *   node scripts/generate-tools.mjs          # write src/generated/tools.ts
 *   node scripts/generate-tools.mjs --list   # dry run: print names only
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SPEC_PATH = resolve(ROOT, 'identity-exposure-openapi.json');
const OUT_PATH = resolve(ROOT, 'src/generated/tools.ts');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
/** Header params handled by the HTTP client, never exposed as tool inputs. */
const IGNORED_HEADERS = new Set(['x-api-key']);

/** Convert a spec token (kebab/camel) into snake_case words. */
function toSnake(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Naive singularize for building `get_<singular>` from a plural resource. */
function singularize(word) {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.replace(/es$/, '');
  if (/ss$/.test(word)) return word; // "settings" style handled by caller
  if (/s$/.test(word)) return word.replace(/s$/, '');
  return word;
}

/**
 * Explicit overrides keyed by "METHOD /path". These capture the intent from
 * TOOL_NAMING_CONVENTION.md for cases the generic rules can't infer:
 * singleton resources (GET-one, so `get_` not `list_`), semantic
 * disambiguators, and action endpoints. Anything not listed here falls through
 * to the generic derivation.
 */
const NAME_OVERRIDES = {
  'GET /api/about': 'get_about',
  'GET /api/api-key': 'get_api_key',
  'GET /api/application-settings': 'get_application_settings',
  'PATCH /api/application-settings': 'update_application_settings',
  'PATCH /api/preferences': 'update_preferences',
  'GET /api/attack-type-configuration': 'get_attack_type_configuration',
  'GET /api/cloud-statistics': 'get_cloud_statistics',
  'GET /api/ldap-configuration': 'get_ldap_configuration',
  'GET /api/license': 'get_license',
  'POST /api/license': 'update_license',
  'GET /api/lockout-policy': 'get_lockout_policy',
  'GET /api/metrics': 'get_metrics',
  'GET /api/preferences': 'get_preferences',
  'GET /api/saml-configuration': 'get_saml_configuration',
  'GET /api/report-access-token': 'get_report_access_token',
  'GET /api/profiles/{profileId}/scores': 'get_profile_scores',
  'GET /api/profiles/{profileId}/topology': 'get_profile_topology',
  'PUT /api/users/{id}/roles': 'set_user_roles',
  'GET /api/directories/{directoryId}/ad-objects/{id}': 'get_ad_object_by_directory',
  'GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/ad-objects/{id}':
    'get_ad_object_by_infrastructure',
  'GET /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{id}': 'get_ad_object_by_checker',
  'GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/ad-objects/{id}':
    'get_ad_object_in_event',
  'GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/ad-objects/{id}/changes':
    'get_ad_object_changes',
  'GET /api/export/profiles/{profileId}/checkers/{checkerId}': 'export_checker_data',
  'PATCH /api/profiles/{profileId}/alerts': 'update_profile_alerts',
  'GET /api/profiles/{profileId}/alerts': 'list_profile_alerts',
  // Deviance query endpoints — several use POST for reads (filter body). Name
  // them by the resource they are scoped to so callers can tell them apart.
  'GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/deviances':
    'list_deviances_by_directory',
  'GET /api/profiles/{profileId}/infrastructures/{infrastructureId}/directories/{directoryId}/checkers/{checkerId}/deviances':
    'list_deviances_by_directory_and_checker',
  'POST /api/profiles/{profileId}/checkers/{checkerId}/deviances': 'list_deviances_by_checker',
  'PATCH /api/profiles/{profileId}/checkers/{checkerId}/deviances': 'update_deviances_by_checker',
  'POST /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{adObjectId}/deviances':
    'search_deviances_by_ad_object',
  'PATCH /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{adObjectId}/deviances':
    'update_deviances_by_ad_object',
  'POST /api/profiles/{profileId}/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/deviances':
    'list_deviances_by_event',
};

/**
 * Split a path into literal segments (dropping /api and {params}).
 * "/api/profiles/{profileId}/attacks/export" -> ["profiles","attacks","export"]
 */
function literalSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .filter((s) => s !== 'api' && !s.startsWith('{'));
}

/** Does the final path segment end in a path parameter (single-resource GET)? */
function endsWithParam(path) {
  const segs = path.split('/').filter(Boolean);
  return segs[segs.length - 1].startsWith('{');
}

/** Extract ordered path params, e.g. ["directoryId","id"]. */
function pathParams(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * A human-readable "scope" for disambiguating colliding names: the nearest
 * meaningful enclosing path parameter with its "Id" suffix stripped, e.g.
 * checkerId -> "checker", eventId -> "event", adObjectId -> "ad_object". The
 * generic "id" param is skipped in favour of a more specific one. Falls back to
 * the first literal path segment, then "2".
 */
function nearestScope(pParams, path) {
  const meaningful = pParams.filter((p) => p !== 'id');
  const chosen = meaningful.length ? meaningful[meaningful.length - 1] : pParams[pParams.length - 1];
  if (chosen) return toSnake(chosen.replace(/Id$/, ''));
  const segs = literalSegments(path);
  return segs.length > 1 ? singularize(toSnake(segs[0])) : '2';
}

/**
 * Derive a tool name from an operation. Aims to match the project's
 * verb_resource[_qualifier] convention. Explicit overrides (above) win first;
 * otherwise names are built generically. Collisions are resolved by the caller.
 *
 * The resource noun comes from the last *literal* path segment, which is
 * naturally plural (e.g. "dashboards") — good for `list_`, singularized for
 * single-object verbs.
 */
function deriveName(method, path, op) {
  const key = `${method.toUpperCase()} ${path}`;
  if (NAME_OVERRIDES[key]) return { base: NAME_OVERRIDES[key] };

  const segs = literalSegments(path);
  const last = segs[segs.length - 1] || 'resource';

  // Action-style trailing segments override the default verb mapping.
  const actionSegs = {
    export: () => `export_${toSnake(segs[segs.length - 2] || last)}`,
    search: () => `search_${toSnake(segs[segs.length - 2] || last)}`,
    unstage: () => 'unstage_profile',
    commit: () => 'commit_profile',
    refresh: () => 'refresh_report_access_token',
    'generate-certificate': () => 'generate_saml_certificate',
    'test-message': () => `test_${singularize(toSnake(segs[segs.length - 2] || last))}`,
    'user-creation-defaults': () => 'get_user_creation_defaults',
    'product-association': () => 'get_product_association',
    'linking-key': () => 'get_relay_linking_key',
    whoami: () => 'get_current_user',
    password: () => 'change_password',
    permissions: () => 'set_role_permissions',
    options: () => (method === 'put' ? 'set_widget_options' : 'get_widget_options'),
    login: () => 'login',
    logout: () => 'logout',
    changed: () => `list_changed_${toSnake(segs[segs.length - 2] || last)}`,
  };
  if (actionSegs[last]) return { base: actionSegs[last]() };

  // ".../{resource}/from/{fromId}" clone pattern -> clone_<resource>.
  // The resource is the segment *before* "from".
  const fromIdx = segs.indexOf('from');
  if (fromIdx > 0) return { base: `clone_${singularize(toSnake(segs[fromIdx - 1]))}` };

  const plural = toSnake(last);
  const singular = singularize(plural);

  let verb;
  switch (method) {
    case 'get':
      verb = endsWithParam(path) ? 'get' : 'list';
      break;
    case 'post':
      // Several TIE endpoints use POST for *reads* — they carry a filter body
      // but return existing data (their summaries start with "Get all ..." or
      // "Search ..."). Naming these `create_` would be wrong and, because the
      // safety tier is derived from the name prefix, would also misclassify
      // them as `write`. Detect the read intent from the summary instead.
      verb = postReadVerb(op) ?? 'create';
      break;
    case 'patch':
      verb = 'update';
      break;
    case 'put':
      verb = 'set';
      break;
    case 'delete':
      verb = 'delete';
      break;
    default:
      verb = method;
  }

  // list_ and search_ use the plural resource; everything else the singular.
  const noun = verb === 'list' || verb === 'search' ? plural : singular;
  return { base: `${verb}_${noun}` };
}

/**
 * If a POST operation is really a read (its summary begins with a query verb),
 * return the appropriate read verb; otherwise null (a genuine create).
 */
function postReadVerb(op) {
  const summary = (op.summary || '').trim().toLowerCase();
  if (/^search\b/.test(summary)) return 'search';
  if (/^(get|list|retrieve|fetch)\b/.test(summary)) return 'list';
  return null;
}

/** Build a JSON-Schema-ish input schema object for the tool. */
function buildInputSchema(op, pParams) {
  const properties = {};
  const required = [];

  // Path params -> required string inputs.
  const paramByName = Object.fromEntries((op.parameters || []).map((p) => [p.name, p]));
  for (const name of pParams) {
    const spec = paramByName[name];
    properties[name] = {
      type: 'string',
      description: spec?.description || `Path parameter: ${name}`,
    };
    required.push(name);
  }

  // Query params.
  for (const p of op.parameters || []) {
    if (p.in !== 'query') continue;
    const schema = p.schema || { type: 'string' };
    properties[p.name] = {
      ...schema,
      description: p.description || schema.description || `Query parameter: ${p.name}`,
    };
    if (p.required) required.push(p.name);
  }

  // Request body: flatten a top-level object schema into `body`.
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    properties.body = {
      ...bodySchema,
      description: bodySchema.description || 'Request body payload',
    };
    if (op.requestBody.required) required.push('body');
  }

  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/** Safety tier from the tool name prefix — drives permission filtering. */
function safetyTier(name) {
  if (/^(get|list|search|export)_/.test(name)) return 'read';
  if (/^(delete|unstage)_/.test(name)) return 'destructive';
  return 'write';
}

function main() {
  const listOnly = process.argv.includes('--list');
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
  const tools = [];
  const taken = new Set(); // final tool names already used

  for (const path of Object.keys(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = spec.paths[path][method];
      if (!op) continue;

      const pParams = pathParams(path);
      const queryParams = (op.parameters || [])
        .filter((p) => p.in === 'query')
        .map((p) => p.name);
      const hasBody = Boolean(op.requestBody?.content?.['application/json']?.schema);

      const { base } = deriveName(method, path, op);

      // Resolve collisions deterministically by qualifying with the nearest
      // enclosing path parameter (the resource the operation is scoped to),
      // e.g. two "list_deviances" become list_deviances and
      // list_deviances_by_checker. Falls back to the first path segment, then a
      // numeric suffix, when no path param is available.
      let name = base;
      if (taken.has(base)) {
        const scope = nearestScope(pParams, path);
        name = `${base}_by_${scope}`;
        let n = 2;
        while (taken.has(name)) name = `${base}_by_${scope}_${n++}`;
      }
      taken.add(name);

      tools.push({
        name,
        description: op.summary || op.description || name,
        category: op.tags?.[0] || 'General',
        safety: safetyTier(name),
        method,
        path,
        pathParams: pParams,
        queryParams,
        hasBody,
        licenseTypes: op['x-tenablead-required-product-license-type'] || [],
        inputSchema: buildInputSchema(op, pParams),
      });
    }
  }

  if (listOnly) {
    const byCat = {};
    for (const t of tools) (byCat[t.category] ||= []).push(t);
    let total = 0;
    for (const cat of Object.keys(byCat).sort()) {
      console.log(`\n### ${cat}`);
      for (const t of byCat[cat]) {
        const tier = { read: '🟢', write: '🟡', destructive: '🔴' }[t.safety];
        console.log(`  ${tier} ${t.name.padEnd(38)} ${t.method.toUpperCase().padEnd(6)} ${t.path}`);
        total++;
      }
    }
    console.log(`\nTotal tools: ${total}`);
    const counts = {};
    for (const t of tools) counts[t.name] = (counts[t.name] || 0) + 1;
    const dupes = Object.entries(counts).filter(([, c]) => c > 1);
    console.log(`Duplicate final names: ${dupes.length ? dupes.map((d) => d[0]).join(', ') : 'none'}`);
    return;
  }

  const header = `/**
 * AUTO-GENERATED by scripts/generate-tools.mjs — do not edit by hand.
 * Regenerate with: npm run generate:tools
 *
 * One descriptor per Tenable Identity Exposure API operation (${tools.length} total).
 */
`;
  const typeDef = `/** JSON Schema for a tool's inputs (compatible with MCP Tool.inputSchema). */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  category: string;
  safety: 'read' | 'write' | 'destructive';
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  licenseTypes: string[];
  inputSchema: ToolInputSchema;
}
`;
  const body = `export const tools: ToolDescriptor[] = ${JSON.stringify(tools, null, 2)};\n`;

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${header}\n${typeDef}\n${body}`);
  console.log(`Wrote ${tools.length} tool descriptors to ${OUT_PATH}`);
}

main();
