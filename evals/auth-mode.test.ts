// The eval runner's auth decision — four modes, two contracts (CI self-skip vs configured-but-
// broken fail-loud), one function. Mutation probes aim at the skip, ambient, and aws branches.
import { describe, expect, it } from "vitest";
import { evalAuthMode } from "./auth-mode.ts";

describe("evalAuthMode", () => {
  it("skips when nothing is configured (the CI/fork contract — a red main over a missing secret is the 2026-08-10 regression)", () => {
    expect(evalAuthMode({})).toBe("skip");
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" })).toBe("skip");
    // CI exports unset repo variables as EMPTY STRINGS — empty AWS vars must read as unset,
    // or every fork run would go aws-mode and die instead of skipping green.
    expect(evalAuthMode({ ANTHROPIC_AWS_WORKSPACE_ID: "", ANTHROPIC_AWS_API_KEY: "", AWS_REGION: "" })).toBe("skip");
    expect(evalAuthMode({ EVAL_GATE: "1" })).toBe("skip"); // the gate only gates runs that happen
  });

  it("goes ambient when a gateway base URL is configured without a key (keyless local runs; fails loud there, never skips)", () => {
    expect(evalAuthMode({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" })).toBe("ambient");
  });

  it("prefers an explicit key/token over a gateway (reproducible runs)", () => {
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "sk-x" })).toBe("keyed");
    expect(evalAuthMode({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBe("keyed");
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://gw" })).toBe("keyed");
  });

  it("goes aws when Claude Platform on AWS is configured — either marker alone suffices", () => {
    expect(evalAuthMode({ ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01x" })).toBe("aws");
    expect(evalAuthMode({ ANTHROPIC_AWS_API_KEY: "aws-external-anthropic-api-key-x" })).toBe("aws");
  });

  it("aws config outranks a leftover first-party key (deliberate two-variable config beats one stale secret)", () => {
    expect(evalAuthMode({ ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01x", ANTHROPIC_API_KEY: "sk-dead" })).toBe("aws");
    expect(evalAuthMode({ ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01x", ANTHROPIC_BASE_URL: "http://gw" })).toBe("aws");
  });
});
