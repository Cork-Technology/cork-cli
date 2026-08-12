/** The HTTP-mode route list, shared by the three surfaces that advertise it (the `ch mcp`
 *  commander description, the pre-commander --help page, and the server startup log). The
 *  copies had already diverged once — two of them still said `/docs/signing` after the docs
 *  route went topic-generic. Deliberately a tiny leaf module: bin.ts's mcp branch runs BEFORE
 *  commander loads and must stay import-light. */
export const MCP_HTTP_ROUTES = "endpoint /mcp, health /healthz, readiness /readyz, docs /docs/<topic>";
