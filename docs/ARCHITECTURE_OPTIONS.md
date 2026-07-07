# MCP Server Architecture Options

## Tool Design Approaches

### Option A: One Tool Per Endpoint (88 tools)
**Approach**: Direct 1:1 mapping of API endpoints to MCP tools.

**Example**:
```
- get_about()
- list_ad_objects()
- get_ad_object_by_directory(directoryId, id)
- get_alert(id)
- update_alert(id, data)
- list_attacks(profileId)
- export_attacks(profileId)
... (88 total tools)
```

**Pros**:
- Simple, direct mapping
- Easy to auto-generate
- Clear documentation

**Cons**:
- 88 tools is overwhelming for users
- Lots of similar operations scattered
- Poor discoverability

---

### Option B: Smart Grouping (Recommended)
**Approach**: Group related operations into cohesive tools with action parameters.

**Example** - Instead of 7 separate deviance tools:
```typescript
// ❌ Without grouping (7 tools)
get_deviance(id)
list_deviances(infrastructureId, directoryId)
update_deviance(infrastructureId, directoryId, id, data)
create_deviances(profileId, checkerId, data)
bulk_update_deviances(profileId, checkerId, data)
get_changed_deviances()
get_checker_deviances(profileId, infrastructureId, directoryId, checkerId)

// ✅ With smart grouping (1 tool)
manage_deviances({
  action: "list" | "get" | "update" | "create" | "bulk_update" | "get_changed" | "search",
  profileId?: string,
  infrastructureId?: string,
  directoryId?: string,
  checkerId?: string,
  devianceId?: string,
  data?: object,
  filters?: object
})
```

**Grouping Strategy**:
1. **Security Analysis** (5-7 tools)
   - `manage_attacks` - List, get, export attacks
   - `manage_deviances` - CRUD operations on deviances
   - `manage_checkers` - Query checkers, options, reasons
   - `manage_alerts` - Get, update alerts
   - `search_events` - Search AD events

2. **Infrastructure** (3-4 tools)
   - `manage_infrastructures` - CRUD infrastructures
   - `manage_directories` - CRUD directories
   - `manage_profiles` - CRUD profiles, commit, unstage
   - `query_ad_objects` - Search and retrieve AD objects

3. **User Management** (2 tools)
   - `manage_users` - CRUD users, roles, password
   - `manage_roles` - CRUD roles, permissions

4. **Configuration** (3-4 tools)
   - `manage_dashboards` - CRUD dashboards and widgets
   - `manage_notifications` - Email notifiers, syslogs
   - `manage_auth_config` - LDAP, SAML configuration
   - `manage_settings` - Application settings, preferences

5. **Reports & Data** (2 tools)
   - `get_scores` - Get security scores
   - `get_topology` - Get topology
   - `export_data` - Export various data types

6. **System** (2 tools)
   - `get_system_info` - About, metrics, license
   - `manage_api_keys` - Generate, list API keys

**Total: ~15-20 well-organized tools instead of 88**

**Pros**:
- Better user experience (fewer tools to discover)
- Logical grouping by domain
- Easier to document and understand
- Still covers all 88 endpoints

**Cons**:
- More complex parameter validation
- Requires thoughtful design (not pure auto-gen)
- Action parameter adds one level of indirection

---

### Option C: Hybrid (Resources + Tools)
**Approach**: MCP Resources for reads, MCP Tools for writes.

**Resources** (read-only URIs):
```
tie://attacks/{profileId}
tie://deviances/{infrastructureId}/{directoryId}
tie://checkers
tie://directories
tie://users
```

**Tools** (mutations):
```
create_deviance(...)
update_alert(...)
delete_infrastructure(...)
```

**Pros**:
- Clean separation of concerns
- Resources are cacheable
- Tools are discoverable

**Cons**:
- Two different patterns to learn
- Resources need URI design
- May not fit all use cases

---

## Recommendation: Smart Grouping (Option B)

**Why**:
1. **User Experience**: 15-20 intuitive tools vs 88 scattered tools
2. **Discoverability**: Users can find "manage_attacks" instead of remembering 3 different attack tools
3. **Flexibility**: Still exposes all 88 endpoints, just organized better
4. **Documentation**: Easier to document and provide examples
5. **Auto-generation**: Can still auto-generate the grouped structure from OpenAPI tags

**Implementation**:
- Use OpenAPI `tags` to determine groups
- Generate TypeScript types from schemas
- Each grouped tool validates `action` parameter and routes to appropriate endpoint
- Comprehensive JSDoc for each action within a tool

---

## Multi-Tenant Credential Management

### For MCP Servers with Multiple Customer Environments

**Challenge**: Users need to connect to different TIE instances (customer1.tenable.ad, customer2.tenable.ad) with different API keys.

**Recommended Approach**: Connection Profiles

```typescript
// In MCP server configuration
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_CONNECTIONS": JSON.stringify({
          "customer1": {
            "baseUrl": "https://customer1.tenable.ad",
            "apiKey": "key1..."
          },
          "customer2": {
            "baseUrl": "https://customer2.tenable.ad", 
            "apiKey": "key2..."
          },
          "default": "customer1"
        })
      }
    }
  }
}
```

**Tool Usage**:
```typescript
// User calls tool with optional connection parameter
manage_attacks({
  action: "list",
  profileId: "profile-123",
  connection: "customer2"  // Optional, defaults to "default" connection
})
```

**Benefits**:
1. ✅ Multiple environments in one MCP server instance
2. ✅ Easy to switch between customers
3. ✅ Credentials stored securely in Claude Code config
4. ✅ Default connection for convenience
5. ✅ Clear which environment you're querying

**Alternative**: Separate MCP server instances per customer (less flexible)

---

## Next Decision Needed

Do you want to proceed with **Smart Grouping (Option B)** for the tool architecture?
