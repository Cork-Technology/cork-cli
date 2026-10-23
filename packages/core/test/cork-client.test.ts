// The Cork client header contract: every HTTP call to a Cork server (the venue API) carries
// `User-Agent` and `X-Cork-Client` naming the client and its version — attribution only.
import { describe, expect, it } from "vitest";
import { BUILD_VERSION, corkClientHeaders, formatCorkClient, formatCorkUserAgent, getRfqs, mcpClientLabel, postLopOrder, runTool, withMcpClient } from "@cork/core";
import { readNativeApiCapability } from "../src/handlers/native-history-capability.ts";
import { corkClientVersion, withCorkClientHeaders } from "../src/cork-client.ts";

const V = corkClientVersion(BUILD_VERSION);

/** A venue stub that records the two attribution headers of every request it sees. */
function recordingFetch(): { fetch: (url: string, init?: RequestInit) => Promise<Response>; seen: Array<{ url: string; method: string; ua: string | null; client: string | null; extra: string | null }> } {
  const seen: Array<{ url: string; method: string; ua: string | null; client: string | null; extra: string | null }> = [];
  return {
    seen,
    fetch: async (url, init) => {
      const h = new Headers(init?.headers);
      seen.push({ url, method: (init?.method ?? "GET").toUpperCase(), ua: h.get("user-agent"), client: h.get("x-cork-client"), extra: h.get("content-type") });
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

describe("cork client header values", () => {
  it("X-Cork-Client is the bare <client>/<semver>", () => {
    expect(formatCorkClient({ client: "cork-cli" }, "v0.7.1")).toBe("cork-cli/0.7.1");
    expect(formatCorkClient({ client: "cork-cli-mcp", comment: { surface: "mcp", client: "claude-code" } }, "v0.7.1")).toBe("cork-cli-mcp/0.7.1");
    expect(formatCorkClient({ client: "cork-mcp", comment: { client: "cursor-vscode" } }, "v0.7.1-rc.2")).toBe("cork-mcp/0.7.1-rc.2");
    expect(formatCorkClient(undefined, "dev")).toBe("cork-sdk/0.0.0-dev");
    // Not semver-shaped → a fixed placeholder, never the raw string.
    expect(corkClientVersion("v1.2")).toBe("0.0.0-unknown");
    expect(corkClientVersion("1.2.3 (evil)")).toBe("0.0.0-unknown");
    expect(corkClientVersion(`1.2.3-${"a".repeat(80)}`)).toBe("0.0.0-unknown");
    expect(corkClientVersion("v1.2.3+build.7")).toBe("1.2.3+build.7");
    expect(corkClientVersion("v1.2.3-alpha-1")).toBe("1.2.3-alpha-1");
    // Pre-release AND build metadata is not one suffix in the API's pattern.
    expect(corkClientVersion("v1.2.3-rc.1+abc")).toBe("0.0.0-unknown");
    // A source run: 0.0.0-dev (the npm dist stamps the package version instead).
    expect(corkClientVersion("dev")).toBe("0.0.0-dev");
    // Every value sent passes the API's X-Cork-Client version pattern.
    for (const v of ["v0.7.1", "dev", "v1.2.3+build.7", "garbage"]) expect(corkClientVersion(v)).toMatch(/^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$/u);
  });

  it("User-Agent keeps the (surface; client) comment, allowlisted, and the runtime's token last", () => {
    expect(formatCorkUserAgent({ client: "cork-cli" }, "v0.7.1", "Bun/1.3.14")).toBe("cork-cli/0.7.1 Bun/1.3.14");
    expect(formatCorkUserAgent({ client: "cork-cli-mcp", comment: { surface: "mcp", client: "cursor-vscode" } }, "v0.7.1", "Bun/1.3.14")).toBe("cork-cli-mcp/0.7.1 (surface=mcp; client=cursor) Bun/1.3.14");
    expect(formatCorkUserAgent({ client: "cork-mcp", comment: { client: "Cursor 1.2 <script>" } }, "v0.7.1", "")).toBe("cork-mcp/0.7.1 (client=cursor)");
    // A hostile MCP client name cannot inject a header line, free text, an address or an e-mail.
    for (const evil of [`evil\r\nx-cork-api-key: k ${"a".repeat(500)}`, "0x1111111111111111111111111111111111111111", "claude-code 0xdeadbeef", "alice@example.com", "deadbeefdeadbeefdeadbeef", "my-own-agent"]) {
      const value = formatCorkUserAgent(withMcpClient({ client: "cork-mcp" }, evil), "v1.0.0", "");
      expect(value).toBe("cork-mcp/1.0.0 (client=other)");
    }
    // The real runtime token is a plain product token.
    expect(corkClientHeaders({ client: "cork-cli" }, "v1.2.3")["user-agent"]).toMatch(/^cork-cli\/1\.2\.3( [A-Za-z][A-Za-z0-9.-]*\/[0-9][A-Za-z0-9.+-]*)?$/u);
  });

  it("maps real MCP clientInfo names onto the closed list", () => {
    const cases: Array<[string, string]> = [
      ["claude-code", "claude-code"], ["Claude Code", "claude-code"], ["Anthropic/ClaudeAI", "claude-ai"], ["claude-ai", "claude-ai"],
      ["Claude Desktop", "claude-desktop"], ["cursor-vscode", "cursor"], ["Visual Studio Code", "vscode"], ["GitHub Copilot", "vscode"],
      ["Cline", "cline"], ["Roo Code", "roo-code"], ["continue-client", "continue"], ["Zed", "zed"], ["goose", "goose"],
      ["codex-mcp-client", "codex"], ["openai-mcp", "chatgpt"], ["gemini-cli-mcp-client", "gemini-cli"], ["windsurf-client", "windsurf"],
      ["opencode", "opencode"], ["amp-mcp-client", "amp"], ["mcp-inspector", "mcp-inspector"], ["inspector-client", "mcp-inspector"],
      ["cork-agent", "cork-agent"], ["Cork Agent", "cork-agent"], ["totally-unknown-thing", "other"], ["", "other"],
    ];
    for (const [raw, label] of cases) expect(mcpClientLabel(raw), raw).toBe(label);
    expect(mcpClientLabel(undefined)).toBeUndefined();
    expect(mcpClientLabel(42)).toBe("other");
  });

  it("the attribution pair wins over a call site's own headers; an existing User-Agent is kept AFTER ours", () => {
    const h = withCorkClientHeaders({ "User-Agent": "spoofed/1.0", "X-Cork-Client": "cork-cli/9.9.9", "content-type": "application/json" }, { client: "cork-mcp" });
    expect(h.get("x-cork-client")).toBe(formatCorkClient({ client: "cork-mcp" }));
    expect(h.get("user-agent")).toBe(`${corkClientHeaders({ client: "cork-mcp" })["user-agent"]} spoofed/1.0`);
    expect(h.get("content-type")).toBe("application/json");
    // Without one, the User-Agent is exactly ours.
    expect(withCorkClientHeaders({}, { client: "cork-mcp" }).get("user-agent")).toBe(corkClientHeaders({ client: "cork-mcp" })["user-agent"]);
  });
});

describe("every venue call sends the attribution headers", () => {
  it("GET (read) and POST (relay) alike, injected fetch included, beside the call site's own headers", async () => {
    const rec = recordingFetch();
    const client = { client: "cork-cli" as const };
    await getRfqs({ fetch: rec.fetch, client }, {});
    await postLopOrder({ fetch: rec.fetch, client }, { any: "body" });
    expect(rec.seen.map((s) => s.method)).toEqual(["GET", "POST"]);
    for (const s of rec.seen) {
      expect(s.ua).toBe(formatCorkUserAgent({ client: "cork-cli" }));
      expect(s.client).toBe(`cork-cli/${V}`);
    }
    expect(rec.seen[1]!.extra).toBe("application/json");
  });

  it("an embedder that names nobody is cork-sdk", async () => {
    const rec = recordingFetch();
    await getRfqs({ fetch: rec.fetch }, {});
    expect(rec.seen[0]!.client).toBe(`cork-sdk/${V}`);
  });

  it("runTool forwards ctx.corkClient to every venue read and to the native-API metadata probe", async () => {
    const rec = recordingFetch();
    const corkClient = { client: "cork-mcp" as const, comment: { client: "claude-code" } };
    const ua = formatCorkUserAgent(corkClient);
    expect(ua).toMatch(new RegExp(`^cork-mcp/${V.replace(/[.+]/gu, "\\$&")} \\(client=claude-code\\)`, "u"));
    const env = await runTool("cork_query", { resource: "rfqs" }, { venueFetch: rec.fetch, corkClient, nowSeconds: 1_800_000_000n });
    expect(env.schemaVersion).toBeDefined();
    await readNativeApiCapability({ venueFetch: rec.fetch, corkClient });
    expect(rec.seen.length).toBeGreaterThanOrEqual(2);
    expect(rec.seen.some((s) => s.url.endsWith("/meta/v1"))).toBe(true);
    for (const s of rec.seen) {
      expect(s.client).toBe(`cork-mcp/${V}`);
      expect(s.ua).toBe(ua);
    }
  });
});
