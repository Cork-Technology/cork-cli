// The eval runner's auth decision — three modes, two contracts (CI self-skip vs gateway
// fail-loud), one function. Mutation probes aim at the skip and ambient branches.
import { describe, expect, it } from "vitest";
import { evalAuthMode } from "./auth-mode.ts";

describe("evalAuthMode", () => {
  it("skips when nothing is configured (the CI/fork contract — a red main over a missing secret is the 2026-08-10 regression)", () => {
    expect(evalAuthMode({})).toBe("skip");
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" })).toBe("skip");
    expect(evalAuthMode({ EVAL_GATE: "1" })).toBe("skip"); // the gate only gates runs that happen
  });

  it("goes ambient when a gateway base URL is configured without a key (keyless local runs; fails loud there, never skips)", () => {
    expect(evalAuthMode({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" })).toBe("ambient");
  });

  it("prefers an explicit key/token over everything (reproducible runs)", () => {
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "sk-x" })).toBe("keyed");
    expect(evalAuthMode({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBe("keyed");
    expect(evalAuthMode({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://gw" })).toBe("keyed");
  });
});
