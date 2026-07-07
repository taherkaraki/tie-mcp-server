# Tenable Identity Exposure MCP Server - Project Plan

## Project Overview
Building an MCP server for Tenable Identity Exposure (TIE) API to enable Claude to interact with TIE environments.

## Decisions Made

### Technology Stack
- **Language**: TypeScript
- **SDK**: `@modelcontextprotocol/sdk`
- **Code Generation**: Auto-generate from OpenAPI spec

### Scope
- **Coverage**: Complete (all 88 endpoints)
- **Use Cases**: All categories
  - Security Analysis (attacks, deviances, checkers)
  - Infrastructure Management (directories, infrastructures, profiles)
  - Monitoring & Alerts (alerts, events, notifications)
  - Reporting (exports, dashboards, topology)
  - User & Role Management

### Authentication Strategy
- **Credentials**: Client-side only (not stored in MCP server)
- **Configuration**: Set during `claude mcp add` or in MCP client config
- **Environment Variables**:
  - `TIE_BASE_URL` - Base URL (e.g., `https://customer1.tenable.ad`)
  - `TIE_API_KEY` - API key for x-api-key header
- **Multi-tenant Support**: Users add multiple MCP server instances
  - Example: "tie-customer1", "tie-customer2" as separate servers
  - Each with different BASE_URL and API_KEY

## API Overview

### Authentication
- **Method**: API Key in header
- **Header**: `x-api-key`
- **Base URL Pattern**: `https://{customer}.tenable.ad`

### Endpoint Summary
- **Total Endpoints**: 88
- **Categories**: 34
- **HTTP Methods**: GET, POST, PATCH, PUT, DELETE

### Key Resource Categories

#### Core Security (IoA/IoE)
- Attacks (Indicators of Attack)
- Deviances (Indicators of Exposure)
- Checkers (security implementations)
- Alerts
- Events
- Scores

#### Infrastructure
- Infrastructures
- Directories
- AD Objects
- Profiles

#### Management
- Users
- Roles
- API Keys
- Dashboards & Widgets

#### Integrations
- Email Notifiers
- Syslogs
- LDAP/SAML Configuration

## Architecture Decisions

### Tool Design: One Tool Per Endpoint
- **Approach**: Direct 1:1 mapping (88 tools total)
- **Rationale**: Granular security control
  - Organizations filter dangerous operations (Edit/Delete)
  - Each tool can be allowed/blocked independently
  - Better compliance with security policies
- **Trade-off**: More tools to discover vs security flexibility

## Next Steps
1. Clarify tool architecture approach
2. Design credential management for multi-tenant
3. Set up TypeScript project structure
4. Generate TypeScript client from OpenAPI spec
5. Implement MCP server wrapper
6. Test with sample TIE environment
