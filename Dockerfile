# Root-level Dockerfile — exists only so Glama (glama.ai/mcp/servers) finds it
# at the repo root during its introspection check for cipherwake-mcp.
#
# The actual MCP server source lives at `mcp-server/`. This Dockerfile
# delegates: copy only the mcp-server files, install runtime deps, run.
# Glama starts the container, sends an MCP `initialize` request over
# stdin, and verifies the server responds with its tool list.
#
# Customers running the MCP server in production install via:
#   npx -y cipherwake-mcp
# (no container needed; this is for Glama's check only).
FROM node:20-alpine

WORKDIR /app

# Manifest first for layer caching.
COPY mcp-server/package.json ./

# Runtime deps only (no dev / test).
RUN npm install --omit=dev --no-audit --no-fund

# Then the source — only the two files cipherwake-mcp ships.
COPY mcp-server/index.js mcp-server/README.md ./

# MCP stdio: no port to bind; Glama exec's `node index.js` and pipes
# its initialize request over stdin.
CMD ["node", "index.js"]
