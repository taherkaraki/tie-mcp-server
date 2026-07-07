# Type Generation Process

## Overview

TypeScript type generation is a **build-time operation**, not a runtime operation. It only needs to be performed when the OpenAPI specification changes.

## When to Generate Types

### ✅ You SHOULD generate types:

1. **Initial setup** - First time setting up the project
2. **API updates** - When Tenable releases a new version of the Identity Exposure API
3. **Spec changes** - When you download an updated `identity-exposure-openapi.json`
4. **Development** - If you manually modify the spec for testing

### ❌ You DON'T need to generate types:

1. **Runtime** - MCP server startup/operation
2. **User installation** - When others install your MCP server
3. **Normal builds** - `npm run build` uses existing types
4. **Every commit** - Generated types are committed to git

## How It Works

### Step 1: Generate Types (One-time or on spec update)

```bash
npm run generate:client
```

This runs:
```bash
openapi-typescript identity-exposure-openapi.json -o src/generated/api-types.ts
```

**Output**: `src/generated/api-types.ts` (~5000-10000 lines)

This file contains TypeScript interfaces for:
- All request parameters
- All response schemas
- All API paths
- Enum types
- Component schemas

### Step 2: Commit Generated Types

```bash
git add src/generated/api-types.ts
git commit -m "Generate TypeScript types from OpenAPI spec"
```

The generated types become part of your source code.

### Step 3: Use Types in Development

```typescript
import type { paths } from './generated/api-types.js';

// Type-safe API responses
type AboutResponse = paths['/api/about']['get']['responses']['200']['content']['application/json'];

// Type-safe parameters
type GetAlertParams = paths['/api/alerts/{id}']['get']['parameters']['path'];
```

### Step 4: Build Project

```bash
npm run build
```

TypeScript compiler:
1. Reads `src/**/*.ts` (including generated types)
2. Type-checks all code
3. Compiles to JavaScript in `build/`
4. Types are erased - JavaScript doesn't include them

### Step 5: Runtime

```bash
node build/index.js
```

Only JavaScript runs. No types, no generation needed.

## Generated File Structure

### src/generated/api-types.ts

```typescript
export interface paths {
  "/api/about": {
    get: {
      responses: {
        200: {
          content: {
            "application/json": {
              version?: string;
              hostname?: string;
              // ... more fields
            };
          };
        };
      };
    };
  };
  "/api/alerts/{id}": {
    get: {
      parameters: {
        path: {
          id: string;
        };
      };
      responses: {
        200: {
          content: {
            "application/json": {
              id: string;
              profileId: string;
              // ... more fields
            };
          };
        };
      };
    };
    patch: {
      // ... patch operation types
    };
  };
  // ... all 88 endpoints
}

export interface components {
  schemas: {
    Alert: {
      id: string;
      profileId: string;
      // ...
    };
    Attack: {
      id: string;
      name: string;
      // ...
    };
    // ... all schemas
  };
}
```

## Workflow Examples

### Initial Setup (Developer)

```bash
# 1. Clone repo
git clone <repo-url>
cd tie-mcp-server

# 2. Install dependencies
npm install

# 3. Generate types from spec
npm run generate:client

# 4. Build project
npm run build

# 5. Generated types are now in src/generated/
```

### User Installation

```bash
# 1. Install from npm (or git)
npm install -g tie-mcp-server

# Done! Pre-built JavaScript is already available
# No type generation needed
```

### API Update Workflow

```bash
# 1. Download new OpenAPI spec
curl https://developer.tenable.com/openapi/identity-exposure.json \
  -o identity-exposure-openapi.json

# 2. Regenerate types
npm run generate:client

# 3. Review changes
git diff src/generated/api-types.ts

# 4. Update tool implementations if needed
# (new endpoints, changed schemas, etc.)

# 5. Rebuild
npm run build

# 6. Test
npm run dev

# 7. Commit
git add identity-exposure-openapi.json src/generated/api-types.ts
git commit -m "Update to TIE API v2.0"
```

## Benefits of This Approach

### ✅ Type Safety
- Catch errors at compile time
- IDE autocomplete for API types
- Refactoring safety

### ✅ Always in Sync
- Types match the spec exactly
- Auto-generated = no manual errors
- Easy to update when API changes

### ✅ No Runtime Overhead
- Types erased during compilation
- No performance impact
- JavaScript bundle stays small

### ✅ Developer Experience
- IntelliSense in VSCode
- Type hints for parameters
- Documentation from OpenAPI descriptions

## Comparison: Build-time vs Runtime

| Aspect | Build-time (our approach) | Runtime (alternative) |
|--------|---------------------------|------------------------|
| When executed | During `npm run build` | Every MCP server start |
| Performance | No runtime cost | Slow startup |
| Bundle size | Types erased | Spec included (~260KB) |
| Type safety | Full TypeScript checking | None or limited |
| Updates | Manual regeneration | Auto-sync possible |
| Complexity | Simple, standard | Complex, custom |

## Tools Used

### openapi-typescript

```bash
npm install -D openapi-typescript
```

**Features**:
- Generates types from OpenAPI 3.x specs
- Supports JSON and YAML formats
- Handles complex schemas
- Creates path-based types
- Preserves descriptions as JSDoc

**Alternatives**:
- `openapi-generator` - More features but heavier
- Manual types - Not recommended (too error-prone)

## Summary

**Type generation is a development tool**, not a runtime requirement. The workflow is:

1. **Once**: Generate types from spec
2. **Commit**: Types become source code
3. **Build**: Compile TypeScript to JavaScript
4. **Distribute**: Only JavaScript
5. **Update**: Regenerate only when spec changes

This gives you full type safety during development with zero runtime cost.
