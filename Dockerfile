# Feature-box SANDBOX image (2026-08-29): the MCP HTTP server run FROM SOURCE with Bun — for a
# ship-feature sandbox slot, where the current tree must serve before a release exists. This is
# NOT the release image (packaging/cork-cli.apko.yaml builds that from attested compiled
# binaries); it exists so a feature box can serve an unreleased main.
#
#   docker build -t cork-mcp:<slug> .   (Dockerfile at the repo root — the ship-feature services[] convention)
#   docker run -d --name cork-<slug>-mcp --network cork-net \
#     -e CORK_CONFIG_NO_FETCH=1 -e CORK_RPC_URL=<vnet rpc> cork-mcp:<slug>
#
# CORK_CONFIG_NO_FETCH=1 is load-bearing on a sandbox: config is remote-first from the PUBLIC
# repo's cork-defaults.json, which trails this tree (e.g. no `marketCreator` until the port
# lands) — the sandbox must serve the bundled copy of the tree it was built from.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
EXPOSE 8080
ENV CORK_CONFIG_NO_FETCH=1
ENTRYPOINT ["bun", "packages/cli/src/bin.ts"]
CMD ["mcp", "--http", "--host", "0.0.0.0", "--port", "8080"]
