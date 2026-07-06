# Fix npm 403 Errors with Netskope

## Problem
Netskope intercepts SSL/TLS traffic, causing npm to reject the modified certificates, resulting in 403 Forbidden errors.

## Solutions

### Option 1: Disable SSL Verification (Quick Fix)

**⚠️ Warning**: This disables SSL certificate validation. Only use on trusted networks.

```bash
npm config set strict-ssl false
```

Then retry:
```bash
npm install
```

To re-enable later:
```bash
npm config set strict-ssl true
```

### Option 2: Trust Netskope Certificate (Recommended)

Your company likely has a Netskope root certificate. You need to configure npm to trust it.

1. **Find the Netskope certificate**:
   - Usually located in system keychain or provided by IT
   - On macOS: Check Keychain Access for "Netskope" certificate
   - Export it as a `.pem` or `.crt` file

2. **Configure npm to use it**:
```bash
npm config set cafile /path/to/netskope-cert.pem
```

### Option 3: Use Company npm Registry

Your company might have an internal npm registry (like Artifactory or Nexus).

Ask your IT team for the registry URL, then:
```bash
npm config set registry https://your-company-registry.com/repository/npm/
```

### Option 4: Configure Proxy (If Required)

If Netskope requires proxy settings:
```bash
npm config set proxy http://proxy.company.com:port
npm config set https-proxy http://proxy.company.com:port
```

## Checking Current Configuration

```bash
npm config list
npm config get strict-ssl
npm config get registry
npm config get proxy
npm config get cafile
```

## Reset Configuration

If you need to start fresh:
```bash
npm config delete strict-ssl
npm config delete cafile
npm config delete proxy
npm config delete https-proxy
npm config delete registry
```

## Testing Connection

After configuration:
```bash
# Test npm registry access
npm ping

# Try searching for a package
npm search axios

# Try installing a single package
npm install axios
```
