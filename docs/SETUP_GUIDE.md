# Setup Guide

## Prerequisites

### Node.js Installation

The TIE MCP server requires Node.js 18 or higher.

#### macOS (Homebrew)
```bash
brew install node
```

#### Verify Installation
```bash
node --version  # Should be v18.0.0 or higher
npm --version   # Should be 9.0.0 or higher
```

## Project Setup

### 1. Install Dependencies

```bash
cd /Users/tkaraki/Claude/TIE_MCP
npm install
```

This will install:
- `@modelcontextprotocol/sdk` - MCP server framework
- `axios` - HTTP client
- `zod` - Runtime type validation
- Development tools (TypeScript, linters, etc.)

### 2. Generate TypeScript Types

Generate TypeScript types from the OpenAPI specification:

```bash
npm run generate:client
```

This creates `src/generated/api-types.ts` with all API types.

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `build/` directory.

## Development Workflow

### Watch Mode

For active development, use watch mode to automatically rebuild on changes:

```bash
npm run watch
```

### Run Without Building

For quick testing during development:

```bash
npm run dev
```

### Type Checking

Check types without building:

```bash
npm run typecheck
```

### Linting

Check code quality:

```bash
npm run lint
```

## Testing the Server

### Manual Testing

1. Set environment variables:
```bash
export TIE_BASE_URL="https://your-customer.tenable.ad"
export TIE_API_KEY="your-api-key"
```

2. Run the server:
```bash
npm run dev
```

3. The server will start on stdio and wait for MCP requests.

### Integration with Claude Code

1. Build the project:
```bash
npm run build
```

2. Add to Claude Code config (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/Users/tkaraki/Claude/TIE_MCP/build/index.js"],
      "env": {
        "TIE_BASE_URL": "https://your-customer.tenable.ad",
        "TIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. Restart Claude Code

4. Test the connection:
```
Claude, call the get_about tool to get TIE system information
```

## Next Steps

1. ✅ Project structure created
2. ✅ Dependencies defined
3. ⏳ Install Node.js and dependencies
4. ⏳ Generate TypeScript types from OpenAPI spec
5. ⏳ Implement tool handlers
6. ⏳ Build and test
7. ⏳ Integrate with Claude Code

## Troubleshooting

### "Cannot find module" errors

Make sure you've run:
```bash
npm install
npm run build
```

### Type generation fails

Check that `identity-exposure-openapi.json` exists in the project root:
```bash
ls -la identity-exposure-openapi.json
```

### Connection errors

Verify environment variables are set correctly:
```bash
echo $TIE_BASE_URL
echo $TIE_API_KEY
```

### API authentication errors

- Verify your API key is valid
- Check that the base URL is correct (no trailing slash)
- Ensure you have necessary permissions in TIE
