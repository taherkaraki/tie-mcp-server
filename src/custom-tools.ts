/**
 * Hand-written convenience tools that don't map 1:1 to a single API endpoint.
 *
 * These live OUTSIDE src/generated/tools.ts so `npm run generate:tools` never
 * clobbers them. Each tool carries its own `handler` that orchestrates one or
 * more calls to the TIE client and returns a plain JS value (serialized to the
 * MCP response by index.ts).
 *
 * Design notes:
 * - TIE has two orthogonal axes. The *topology* axis is real containment:
 *   Infrastructure (Forest) -> Directory (Domain). The *configuration* axis is
 *   a set of selectable lenses: Profile -> per-checker options -> customizations.
 *   A profile does NOT own infrastructures; it is a view applied over them.
 * - When no profile is specified, the correct default is the user's preferred
 *   profile (`preferredProfileId` from GET /api/preferences), not profile 1.
 */

import type { TIEClient } from './client.js';
import type { ToolInputSchema } from './generated/tools.js';

export interface CustomTool {
  name: string;
  description: string;
  category: string;
  safety: 'read' | 'write' | 'destructive';
  inputSchema: ToolInputSchema;
  handler: (client: TIEClient, args: Record<string, unknown>) => Promise<unknown>;
}

/** Minimal shapes of the API responses we consume (see the OpenAPI spec). */
interface Infrastructure {
  id: number;
  name: string;
}
interface Directory {
  id: number;
  name: string;
  infrastructureId: number;
  infrastructureName?: string;
  type?: string;
  dns?: string;
}
interface Profile {
  id: number;
  name: string;
}
interface Preferences {
  language?: string;
  preferredProfileId?: number;
}

export const customTools: CustomTool[] = [
  {
    name: 'get_topology',
    description:
      'Discover the Active Directory environment as a Forest -> Domain tree. ' +
      'Returns each infrastructure (forest) with its directories (domains) and ' +
      'their IDs, so you can obtain the infrastructureId / directoryId values ' +
      'required by other tools. This is the topology (containment) axis and is ' +
      'independent of profiles. Call this first when you do not already know the ' +
      'IDs of the forests or domains you need to query.',
    category: 'Discovery',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(client) {
      const [infras, dirs] = await Promise.all([
        client.get<Infrastructure[]>('/api/infrastructures'),
        client.get<Directory[]>('/api/directories'),
      ]);

      // Group domains by their forest. Infrastructures form the spine so that
      // forests with zero domains still appear.
      const byInfra = new Map<number, Directory[]>();
      for (const d of dirs) {
        const list = byInfra.get(d.infrastructureId) ?? [];
        list.push(d);
        byInfra.set(d.infrastructureId, list);
      }

      const forests = infras.map((infra) => ({
        infrastructureId: infra.id,
        infrastructureName: infra.name,
        domains: (byInfra.get(infra.id) ?? []).map((d) => ({
          directoryId: d.id,
          directoryName: d.name,
          type: d.type,
          dns: d.dns,
        })),
      }));

      return {
        forests,
        totals: { forests: forests.length, domains: dirs.length },
      };
    },
  },
  {
    name: 'get_preferred_profile',
    description:
      "Return the user's preferred (default) profile — its id and name — from " +
      'GET /api/preferences. TIE profiles are configuration lenses, not ' +
      'containers; one is marked preferred. Use this profileId by default in ' +
      'profile-scoped tools unless the user explicitly names a different ' +
      'profile. Prevents querying the wrong profile and getting empty results.',
    category: 'Discovery',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(client) {
      const prefs = await client.get<Preferences>('/api/preferences');
      const preferredProfileId = prefs.preferredProfileId ?? null;

      let preferredProfileName: string | null = null;
      if (preferredProfileId !== null) {
        const profiles = await client.get<Profile[]>('/api/profiles');
        preferredProfileName =
          profiles.find((p) => p.id === preferredProfileId)?.name ?? null;
      }

      return { preferredProfileId, preferredProfileName };
    },
  },
];
