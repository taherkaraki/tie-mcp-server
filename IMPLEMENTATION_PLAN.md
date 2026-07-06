# Implementation Plan

## Phase 1: Foundation ✅

- [x] Project structure
- [x] TypeScript configuration
- [x] Package dependencies
- [x] Git initialization
- [x] Documentation (README, API endpoints, architecture)

## Phase 2: Type Generation ⏳

### Steps
1. Install Node.js and npm
2. Install project dependencies
3. Generate TypeScript types from OpenAPI spec using `openapi-typescript`
4. Verify generated types

### Output
- `src/generated/api-types.ts` - All API request/response types

### Command
```bash
npm run generate:client
```

## Phase 3: Tool Implementation

### Strategy: Auto-Generation

Since we have 88 endpoints, we'll auto-generate tool implementations from the OpenAPI spec.

### 3.1: Tool Generator Script

Create a script that:
1. Reads `identity-exposure-openapi.json`
2. For each endpoint:
   - Generates tool name (using naming convention)
   - Extracts parameters and schemas
   - Creates tool handler function
   - Generates input schema validation
   - Maps to HTTP client method
3. Outputs organized tool files

**Files to create**:
- `scripts/generate-tools.ts` - Tool generator script
- `src/tools/index.ts` - Tool registry
- `src/tools/{category}.ts` - Tool implementations by category

### 3.2: Tool Categories (34 files)

Based on OpenAPI tags:
- `about.ts` - System information
- `ad-objects.ts` - AD object operations
- `alerts.ts` - Alert management
- `api-keys.ts` - API key operations
- `attacks.ts` - Attack (IoA) operations
- `attack-types.ts` - Attack type management
- `categories.ts` - Category operations
- `checkers.ts` - Checker (IoE) operations
- `dashboards.ts` - Dashboard management
- `deviances.ts` - Deviance operations
- `directories.ts` - Directory management
- `email-notifiers.ts` - Email notification config
- `events.ts` - Event search and retrieval
- `infrastructures.ts` - Infrastructure management
- `ldap.ts` - LDAP configuration
- `license.ts` - License management
- `lockout.ts` - Lockout policy
- `metrics.ts` - Metrics
- `preferences.ts` - User preferences
- `profiles.ts` - Profile management
- `reasons.ts` - Reason operations
- `relays.ts` - Relay operations
- `reports.ts` - Report access tokens
- `roles.ts` - Role management
- `saml.ts` - SAML configuration
- `settings.ts` - Application settings
- `syslogs.ts` - Syslog configuration
- `users.ts` - User management
- `widgets.ts` - Widget management
- ... (and other categories)

### 3.3: Tool Handler Template

Each tool follows this pattern:

```typescript
import { TIEClient } from '../client.js';
import { z } from 'zod';

// Input schema for validation
export const GetAlertSchema = z.object({
  id: z.string(),
});

export type GetAlertInput = z.infer<typeof GetAlertSchema>;

// Tool definition
export const getAlertTool = {
  name: 'get_alert',
  description: 'Get details of a specific alert',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Alert ID',
      },
    },
    required: ['id'],
  },
};

// Tool handler
export async function getAlert(
  client: TIEClient,
  input: GetAlertInput
): Promise<unknown> {
  const validated = GetAlertSchema.parse(input);
  return await client.get(`/api/alerts/${validated.id}`);
}
```

### 3.4: Tool Registry

`src/tools/index.ts` exports all tools and a handler map:

```typescript
import * as aboutTools from './about.js';
import * as alertTools from './alerts.js';
// ... import all categories

export const allTools = [
  aboutTools.getAboutTool,
  alertTools.getAlertTool,
  alertTools.updateAlertTool,
  // ... all 88 tools
];

export const toolHandlers = {
  get_about: aboutTools.getAbout,
  get_alert: alertTools.getAlert,
  update_alert: alertTools.updateAlert,
  // ... all 88 handlers
};
```

## Phase 4: Server Integration

### 4.1: Update Main Server

Modify `src/index.ts` to:
1. Import tool registry
2. Register all tools in `ListToolsRequestSchema` handler
3. Route tool calls to handlers in `CallToolRequestSchema` handler

### 4.2: Error Handling

Enhance error handling:
- Validation errors (bad input)
- API errors (4xx, 5xx)
- Network errors
- Timeout errors

### 4.3: Response Formatting

Format tool responses:
- Success: Return formatted JSON
- Error: Return error message with context

## Phase 5: Testing

### 5.1: Unit Tests (Optional)

Create tests for:
- Configuration loading
- Client error handling
- Tool input validation

### 5.2: Integration Testing

Test with real TIE instance:
1. Configure test environment
2. Test read operations (get_about, list_attacks)
3. Test write operations (create_dashboard)
4. Test error scenarios (invalid ID, unauthorized)

### 5.3: MCP Client Testing

Test with Claude Code:
1. Add server to config
2. Test tool discovery
3. Test tool execution
4. Test multi-turn conversations
5. Test error handling

## Phase 6: Documentation

### 6.1: Tool Documentation

Generate documentation for each tool:
- Purpose
- Parameters
- Return type
- Example usage
- Error codes

### 6.2: Usage Examples

Create example conversations:
- Security analysis workflow
- Infrastructure management
- Alert handling
- Report generation

### 6.3: API Reference

Complete API reference:
- All 88 tools organized by category
- Input schemas
- Output schemas
- Security levels (safe/moderate/dangerous)

## Phase 7: Release

### 7.1: Versioning

- Follow semantic versioning
- Tag releases in git
- Maintain CHANGELOG.md

### 7.2: Distribution

Options:
1. **npm package** - Publish to npm registry
2. **GitHub releases** - Download and run locally
3. **Docker image** - Containerized deployment

### 7.3: CI/CD (Optional)

Set up automated:
- Type checking
- Linting
- Building
- Testing
- Publishing

## Current Status

**Phase 1**: ✅ Complete  
**Phase 2**: ⏳ In Progress (waiting for Node.js installation)  
**Phase 3**: ⏳ Pending  
**Phase 4**: ⏳ Pending  
**Phase 5**: ⏳ Pending  
**Phase 6**: ⏳ Pending  
**Phase 7**: ⏳ Pending  

## Estimated Timeline

- Phase 2: 10 minutes (type generation)
- Phase 3: 2-3 hours (tool generation and implementation)
- Phase 4: 1 hour (server integration)
- Phase 5: 1-2 hours (testing)
- Phase 6: 1 hour (documentation)
- Phase 7: 30 minutes (release prep)

**Total**: ~6-8 hours of development time

## Automation Opportunities

Most of Phase 3 can be automated:
1. Parse OpenAPI spec
2. Generate tool definitions
3. Generate handlers
4. Generate schemas
5. Generate registry

This reduces implementation time significantly.
