# Project Status - TIE MCP Server

**Last Updated**: 2026-07-07
**Current Version**: 0.2.1 (published to npm as `tie-mcp-server`)

## ✅ Shipped

The server is fully built, published, and working.

1. **Complete API coverage** - All 131 TIE API operations exposed as MCP tools,
   auto-generated from the OpenAPI spec into `src/generated/tools.ts`.
2. **Discovery tools** - 2 hand-written custom tools (`get_topology`,
   `get_preferred_profile`) in `src/custom-tools.ts` that survive regeneration.
   **Total: 133 tools.**
3. **Generic dispatcher** - `src/dispatch.ts` turns any descriptor + args into an
   HTTP call; custom handlers run first, then fall back to the generic path.
4. **Security controls** - Client-side credentials only; server-side
   `TIE_ALLOWED_SAFETY` env var filters tools by risk tier (read/write/destructive).
5. **Packaging** - Published to npm, MIT LICENSE, multi-stage Dockerfile.
6. **Distribution** - Public GitHub repo at
   https://github.com/taherkaraki/tie-mcp-server. PRs #1 and #2 merged.

## 📦 Release History

See [CHANGELOG.md](CHANGELOG.md) for full details.

- **0.2.1** - Fixed custom tool JSON schema validation (`additionalProperties: false`)
- **0.2.0** - Added discovery tools + custom tools architecture + profile scope hints
- **0.1.1** - Fixed naming for POST-but-read deviance endpoints
- **0.1.0** - Initial release, 131 operations, published to npm

## 📊 Project Statistics

- **Total tools**: 133 (131 generated + 2 custom)
- **Generated from**: 88 OpenAPI paths / 131 operations
- **Safety tiers**: 70 read, 51 write, 10 destructive (generated) + 2 custom read
- **Source files**: `index.ts`, `config.ts`, `client.ts`, `dispatch.ts`,
  `custom-tools.ts`, `generated/tools.ts`

## 📁 File Structure

```
TIE_MCP/
├── .gitignore
├── package.json                    # Dependencies & scripts
├── tsconfig.json
├── Dockerfile                      # Multi-stage build
├── identity-exposure-openapi.json  # OpenAPI spec (261KB)
├── formatted-spec.json             # Formatted OpenAPI spec
├── scripts/
│   └── generate-tools.mjs          # OpenAPI spec -> src/generated/tools.ts
├── src/
│   ├── index.ts                    # MCP server entry point
│   ├── config.ts                   # Environment configuration
│   ├── client.ts                   # HTTP client (axios)
│   ├── dispatch.ts                 # Generic descriptor -> HTTP request
│   ├── custom-tools.ts             # Hand-written discovery tools
│   └── generated/
│       └── tools.ts                # 131 auto-generated tool descriptors
├── Temp/                           # Local scratch (gitignored)
└── *.md                            # Documentation (see README.md)
```

## 🔑 Key Decisions

1. **Language**: TypeScript with `@modelcontextprotocol/sdk`
2. **Architecture**: One tool per endpoint (131 tools) for granular security
3. **Authentication**: Client-side credentials via environment variables
4. **Scope**: Complete coverage of all TIE API operations
5. **Code Generation**: Auto-generate from OpenAPI spec; custom tools kept separate
6. **Type Generation**: Build-time only (not runtime)

## 💡 Important Notes

### Security
- Credentials NEVER stored in server
- Client configures via MCP client settings
- Multi-tenant: each TIE environment = separate MCP server instance
- Granular tool filtering (read/write/destructive) via `TIE_ALLOWED_SAFETY`

### Regeneration
- Re-run `npm run generate:tools` when the OpenAPI spec changes
- Custom tools in `src/custom-tools.ts` survive regeneration
- Profile scope hints are baked in at generation time

## 🎯 Possible Next Steps

- Integration testing against a live TIE instance
- Optional: HTTP/SSE transport for centrally-hosted deployment (see README
  "Hosting as a shared service")

## 🤝 Contributors

- taherkaraki <mtaher@gmail.com>
- Claude (AI Assistant)
