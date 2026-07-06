# syntax=docker/dockerfile:1

# ---- Builder: install all deps and compile TypeScript ----
FROM node:22-alpine AS builder
WORKDIR /app

# Install dependencies against the lockfile-free manifest. `npm ci` needs a
# lockfile; since this project gitignores it, use `npm install`.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Compile. `prepare` also runs tsc, but we copy sources first and build
# explicitly so the layer cache is predictable.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only runtime deps carry into the final image.
RUN npm prune --omit=dev

# ---- Runtime: minimal image with just the compiled server + prod deps ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the built-in unprivileged `node` user, not root.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/build ./build
COPY --chown=node:node package.json ./

USER node

# The server speaks MCP over stdio, so it must attach to the container's
# stdin/stdout. Run with:  docker run -i --rm -e TIE_BASE_URL -e TIE_API_KEY tie-mcp-server
ENTRYPOINT ["node", "build/index.js"]
