import { describe, expect, it } from "vitest";
import { summarizeBundle } from "@cork/core";
import type { DecodedLeg } from "@cork/core";

const ADP = "0xccccccccccccbad6f772a511b337d9ccc9570407" as const;
const USER = "0x00000000000000000000000000000000000000aa" as const;
const ATTACKER = "0x00000000000000000000000000000000000000ee" as const;
const TOKEN = "0x0000000000000000000000000000000000000010" as const;
const MAX_UINT = (1n << 256n) - 1n;

const opts = { adapter: ADP, account: USER, tokenRoles: { [TOKEN]: "collateral" } };
const leg = (over: Partial<DecodedLeg> & { kind: DecodedLeg["kind"] }): DecodedLeg =>
  ({ to: ADP, value: 0n, skipRevert: false, ...over }) as DecodedLeg;

describe("summarizeBundle", () => {
  it("numbers every leg, in execution order", () => {
    const lines = summarizeBundle(
      [
        leg({ kind: "leg", fn: "erc20TransferFrom", args: [TOKEN, ADP, 5n] }),
        leg({ kind: "cork", action: "safeSwap", params: { receiver: USER } }),
        leg({ kind: "leg", fn: "erc20Transfer", args: [TOKEN, USER, MAX_UINT] }),
      ],
      opts,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1\. fund: pull 5 of collateral/);
    expect(lines[1]).toMatch(/^2\. run Cork 'safeSwap'/);
    expect(lines[2]).toMatch(/^3\. return the entire remaining balance/);
  });

  it("renders the full-balance sentinel as words, not 1.16e77", () => {
    const [line] = summarizeBundle([leg({ kind: "leg", fn: "erc20Transfer", args: [TOKEN, USER, MAX_UINT] })], opts);
    expect(line).toContain("the entire remaining balance");
    expect(line).not.toContain("115792089");
  });

  it("names known addresses: you, the adapter, token roles", () => {
    const [line] = summarizeBundle([leg({ kind: "leg", fn: "erc20TransferFrom", args: [TOKEN, ADP, 5n] })], opts);
    expect(line).toContain("collateral");
    expect(line).toContain("the adapter");
    expect(line).toContain("from you");
  });

  it("shows a bare address when nothing is known about it (no invented labels)", () => {
    const [line] = summarizeBundle([leg({ kind: "leg", fn: "erc20Transfer", args: [TOKEN, ATTACKER, 5n] })], {});
    expect(line).toMatch(/0x0000…0010/);
    expect(line).toMatch(/0x0000…00ee/);
    expect(line).not.toContain("you");
  });

  it("surfaces a redirected receiver rather than assuming it is the signer", () => {
    // The whole point: if the proceeds go somewhere else, the summary must say so plainly.
    const [line] = summarizeBundle([leg({ kind: "cork", action: "safeSwap", params: { receiver: ATTACKER } })], opts);
    expect(line).toContain("proceeds to");
    expect(line).toContain("0x0000…00ee");
    expect(line).not.toContain("proceeds to you");
  });

  it("reports the owner shares are burned from", () => {
    const [line] = summarizeBundle([leg({ kind: "cork", action: "safeWithdraw", params: { receiver: USER, owner: ATTACKER } })], opts);
    expect(line).toContain("shares burned from");
  });

  it("calls an undecodable leg unreadable and says not to sign", () => {
    const [line] = summarizeBundle([leg({ kind: "unknown", selector: "0xdeadbeef", data: "0xdeadbeef" })], opts);
    expect(line).toContain("UNREADABLE");
    expect(line).toContain("0xdeadbeef");
    expect(line).toMatch(/[Dd]o not sign/);
  });

  it("flags the caveats that change what signing means", () => {
    const [silent] = summarizeBundle([leg({ kind: "cork", action: "safeMint", params: {}, skipRevert: true })], opts);
    expect(silent).toContain("MAY FAIL SILENTLY");
    const [native] = summarizeBundle([leg({ kind: "cork", action: "safeMint", params: {}, value: 7n })], opts);
    expect(native).toContain("sends 7 wei");
  });

  it("indents a nested bundle under its parent", () => {
    const lines = summarizeBundle(
      [leg({ kind: "bundle", legs: [leg({ kind: "leg", fn: "erc20Transfer", args: [TOKEN, USER, 1n] })] })],
      opts,
    );
    expect(lines[0]).toContain("a nested bundle");
    expect(lines[0]).toContain("(1 leg)");
    expect(lines[1]).toMatch(/^ {3}1\. return 1 of collateral/);
  });

  it("empty bundle -> no lines", () => {
    expect(summarizeBundle([], opts)).toEqual([]);
  });
});
