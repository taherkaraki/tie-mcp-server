# Authentication & Security Design

## Security Principles

### 1. Client-Side Credentials Only
**Problem**: If API keys are stored in the MCP server configuration, any MCP client connecting to that server can access those credentials.

**Solution**: Credentials must be configured on the client side and passed to the MCP server process.

### 2. How MCP Credential Flow Works

```
┌─────────────────┐
│   MCP Client    │
│ (Claude Code)   │
│                 │
│ Config stored:  │
│ - TIE_BASE_URL  │
│ - TIE_API_KEY   │
└────────┬────────┘
         │
         │ Launches process with env vars
         ▼
┌─────────────────┐
│   MCP Server    │
│   (tie-mcp)     │
│                 │
│ Reads from env: │
│ - TIE_BASE_URL  │
│ - TIE_API_KEY   │
└────────┬────────┘
         │
         │ Makes API calls with credentials
         ▼
┌─────────────────┐
│  TIE API        │
│  customer.      │
│  tenable.ad     │
└─────────────────┘
```

## Configuration Example

### Single TIE Environment

User runs:
```bash
claude mcp add tie-mcp
```

Claude Code config (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer1.tenable.ad",
        "TIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Multiple TIE Environments

For multiple customer environments, add multiple server instances:

```json
{
  "mcpServers": {
    "tie-customer1": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer1.tenable.ad",
        "TIE_API_KEY": "key-for-customer1"
      }
    },
    "tie-customer2": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer2.tenable.ad",
        "TIE_API_KEY": "key-for-customer2"
      }
    }
  }
}
```

**Usage**: When Claude calls tools, it automatically uses the appropriate server instance based on context or user specification.

## Environment Variables

### Required
- `TIE_BASE_URL` - Base URL for TIE API (e.g., `https://customer.tenable.ad`)
- `TIE_API_KEY` - API key for authentication

### Optional
- `TIE_TIMEOUT` - Request timeout in milliseconds (default: 30000)
- `TIE_MAX_RETRIES` - Max retry attempts for failed requests (default: 3)

## Security Benefits

1. ✅ **No credential storage in server code**
2. ✅ **Credentials stay in client's secure config**
3. ✅ **Each client manages their own credentials**
4. ✅ **Multiple environments = multiple server instances**
5. ✅ **Standard MCP pattern used by other servers**
6. ✅ **No cross-client credential leakage**

## Tool-Level Security

### Granular Permission Control

Organizations can filter MCP tools by operation type:

**Read-Only Tools** (Safe):
- `get_*` - Get single resource
- `list_*` - List resources
- `search_*` - Search operations
- `export_*` - Export data

**Write Tools** (Requires approval):
- `create_*` - Create new resources
- `update_*` - Modify existing resources
- `patch_*` - Partial updates

**Dangerous Tools** (Often blocked):
- `delete_*` - Delete resources

**Example Tool Filtering**:
```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/path/to/tie-mcp-server/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://customer.tenable.ad",
        "TIE_API_KEY": "key"
      },
      "allowedTools": [
        "get_*",
        "list_*",
        "search_*",
        "export_*"
      ],
      "deniedTools": [
        "delete_*",
        "update_*",
        "patch_*"
      ]
    }
  }
}
```

This granular control is **only possible** with one-tool-per-endpoint design, not with grouped tools.
