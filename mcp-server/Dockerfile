# cipherwake-mcp Dockerfile — used by glama.ai/mcp/servers introspection check.
#
# The server runs over MCP stdio (no port to bind). Glama's check starts the
# container, sends an `initialize` request, and verifies the server responds
# with its tool list. Nothing else is exercised here; runtime tool calls go
# out to https://cipherwake.io/api/* (no extra setup needed inside the container).
FROM node:20-alpine

WORKDIR /app

# Copy manifest first for layer caching.
COPY package.json ./

# Install runtime deps only (no dev / test).
RUN npm install --omit=dev --no-audit --no-fund

# Then the source.
COPY index.js README.md ./

# MCP stdio servers don't bind a port — Glama exec's `node index.js` and
# pipes its initialize request over stdin.
CMD ["node", "index.js"]
