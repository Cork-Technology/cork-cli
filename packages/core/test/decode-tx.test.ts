// cork_decode kind:"tx" — the validate-before-broadcast step: recover the signer from a SIGNED
// raw transaction, name the target against known Cork deployments, and decode the inner calldata
// to the same labeled legs as kind:"calldata" [K3]. The fixture is generated in-test with a
// throwaway key (Anvil dev account #1), so the recovered-signer assertion is a real ECDSA
// round-trip, not a pinned string.
import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_SIGNED_TX, Envelope } from "@cork/schemas";
import { corkActionCall, encodeMulticall, MAINNET_DEPLOYMENT, runTool, ToolInputError } from "@cork/core";

const NOW = 1_800_000_000n;

// Anvil dev account #1 — a throwaway, present only to make the signature real.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const SIGNER = privateKeyToAccount(PK);

// The examples.ts demo safeSwap multicall (1 sUSDe out of the demo pool, pre-funded).
const DEMO_MULTICALL =
  "0x374f435d000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000ccccccccccccbad6f772a511b337d9ccc957040700000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c4d5f2e59eceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a0000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000c0ffee00000000000000000000000000000000010000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000000000001e8480000000000000000000000000000000000000000000000000000000006a5e14e600000000000000000000000000000000000000000000000000000000" as const;

const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;

let signedBundleTx: `0x${string}`;
let signedApproveTx: `0x${string}`;
let signedUnknownTx: `0x${string}`;

beforeAll(async () => {
  signedBundleTx = await SIGNER.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 7,
    to: MAINNET_DEPLOYMENT.bundler3,
    value: 0n,
    data: DEMO_MULTICALL,
    gas: 400_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  signedApproveTx = await SIGNER.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 8,
    to: SUSDE,
    value: 0n,
    data: encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]), functionName: "approve", args: [MAINNET_DEPLOYMENT.corkAdapter, 10n ** 18n] }),
    gas: 60_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  signedUnknownTx = await SIGNER.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 9,
    to: "0x000000000000000000000000000000000000dEaD",
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
});

describe("runTool: cork_decode kind:'tx'", () => {
  it("round-trips a signed bundle tx: recovered signer, named target, inner legs = calldata decode", async () => {
    const env = await runTool("cork_decode", { kind: "tx", data: signedBundleTx }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.kind).toBe("tx");
    expect((d.signer as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect((d.to as string).toLowerCase()).toBe(MAINNET_DEPLOYMENT.bundler3.toLowerCase());
    expect(d.toLabel).toBe("bundler3");
    expect(d.chainId).toBe(1);
    expect(d.txChainId).toBe(1);
    expect(d.type).toBe("eip1559");
    expect(d.nonce).toBe(7);
    expect(String(d.txHash)).toMatch(/^0x[0-9a-f]{64}$/);
    // No unknown-target warning for a named Cork contract.
    expect(env.warnings.map((w) => w.code)).not.toContain("unknown_target");
    // The inner legs equal the plain kind:"calldata" decode of the same bytes.
    const plain = await runTool("cork_decode", { kind: "calldata", data: DEMO_MULTICALL }, { nowSeconds: NOW });
    expect(d.legs).toEqual((plain.data as Record<string, unknown>).legs);
    expect(d.summary).toEqual((plain.data as Record<string, unknown>).summary);
    const summary = d.summary as string[];
    expect(summary.join(" ")).toMatch(/safeSwap/);
  });

  it("conflicts when the supplied chainId contradicts the tx's own", async () => {
    const env = await runTool("cork_decode", { kind: "tx", data: signedBundleTx, chainId: 42161 }, { nowSeconds: NOW });
    expect(env.state).toBe("conflict");
    expect(env.warnings.map((w) => w.code)).toContain("chainid_mismatch");
    // The decode still resolves against the tx's OWN chain — the signature commits to it.
    expect((env.data as Record<string, unknown>).chainId).toBe(1);
  });

  it("labels a plain ERC-20 approve (authority-op shape): token target warns unknown_target, leg decodes", async () => {
    const env = await runTool("cork_decode", { kind: "tx", data: signedApproveTx }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    // The token is not a Cork deployment contract — the warning says a token target is expected
    // for an approve rather than pretending certainty.
    expect(env.warnings.map((w) => w.code)).toContain("unknown_target");
    const legs = d.legs as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(1);
    expect(legs[0]!.kind).toBe("leg");
    expect(legs[0]!.fn).toBe("approve");
  });

  it("handles a plain value transfer (no calldata) and an unknown target", async () => {
    const env = await runTool("cork_decode", { kind: "tx", data: signedUnknownTx }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.legs).toBeUndefined();
    expect((d.summary as string[]).join(" ")).toMatch(/no calldata/);
    expect(env.warnings.map((w) => w.code)).toContain("unknown_target");
    expect(d.value).toBe("1");
  });

  it("the shipped DEMO_SIGNED_TX example IS the deterministic signature over the demo fields — the constant cannot drift", async () => {
    // ECDSA per RFC 6979 is deterministic: same key + same fields ⇒ same bytes. This binds the
    // examples.ts literal (reused by evals/tasks.ts) to the in-test source of truth.
    expect(signedBundleTx).toBe(DEMO_SIGNED_TX);
  });

  it("summary parity with kind:'calldata' holds even when the SIGNER is a leg participant", async () => {
    // Adversarial: a bundle whose Cork-leg receiver is the signer. A summarizer given the
    // signer as `account` would render it as "you" and silently break the documented parity
    // (and mislabel third-party txs) — this pins the {adapter}-only option set.
    const data = encodeMulticall([
      corkActionCall(MAINNET_DEPLOYMENT.corkAdapter, "safeSwap", { poolId: `0x${"ce".repeat(32)}`, collateralAssetsOut: 10n ** 18n, receiver: SIGNER.address, maxCstSharesIn: 2n * 10n ** 18n, maxReferenceAssetsIn: 2_000_000n, deadline: 1_900_000_000n }),
    ]);
    const signed = await SIGNER.signTransaction({ type: "eip1559", chainId: 1, nonce: 10, to: MAINNET_DEPLOYMENT.bundler3, data, gas: 300_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
    const tx = await runTool("cork_decode", { kind: "tx", data: signed }, { nowSeconds: NOW });
    const cd = await runTool("cork_decode", { kind: "calldata", data }, { nowSeconds: NOW });
    expect((tx.data as Record<string, unknown>).summary).toEqual((cd.data as Record<string, unknown>).summary);
    expect((tx.data as Record<string, unknown>).legs).toEqual((cd.data as Record<string, unknown>).legs);
  });

  it("a tx for a chain outside coverage stays schema-valid: truth in data.txChainId, gap disclosed", async () => {
    const signed = await SIGNER.signTransaction({ type: "eip1559", chainId: 137, nonce: 11, to: MAINNET_DEPLOYMENT.bundler3, value: 0n, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
    const env = await runTool("cork_decode", { kind: "tx", data: signed }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.txChainId).toBe(137);
    // provenance.chainId is a CLOSED enum on the advertised outputSchema — the whole envelope
    // must validate even for an exotic-chain tx.
    expect(env.provenance.chainId).toBe(1);
    expect(Envelope.safeParse(env).success).toBe(true);
    // The address book was skipped, not faked: no toLabel, and the gap is disclosed.
    expect(d.toLabel).toBeNull();
    expect(env.warnings.map((w) => w.code)).toContain("unknown_deployment");
    // A supplied chainId contradicting the exotic tx still conflicts, schema-valid.
    const conf = await runTool("cork_decode", { kind: "tx", data: signed, chainId: 42161 }, { nowSeconds: NOW });
    expect(conf.state).toBe("conflict");
    expect(conf.warnings.map((w) => w.code)).toContain("chainid_mismatch");
    expect(Envelope.safeParse(conf).success).toBe(true);
  });

  it("decodes a legacy EIP-155 tx (chainId recovered from v)", async () => {
    const signed = await SIGNER.signTransaction({ type: "legacy", chainId: 1, nonce: 12, to: MAINNET_DEPLOYMENT.bundler3, value: 0n, gas: 21_000n, gasPrice: 10n ** 9n });
    const env = await runTool("cork_decode", { kind: "tx", data: signed }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.type).toBe("legacy");
    expect(d.txChainId).toBe(1);
    expect((d.signer as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(d.toLabel).toBe("bundler3");
    expect((d.gas as Record<string, unknown>).gasPrice).toBe("1000000000");
  });

  it("a pre-EIP-155 legacy tx (no chainId of its own) falls back to the supplied chain", async () => {
    const signed = await SIGNER.signTransaction({ type: "legacy", nonce: 13, to: MAINNET_DEPLOYMENT.bundler3, value: 0n, gas: 21_000n, gasPrice: 10n ** 9n });
    const env = await runTool("cork_decode", { kind: "tx", data: signed, chainId: 42161 }, { nowSeconds: NOW });
    expect(env.state).toBe("ok"); // no chainId of its own ⇒ nothing to contradict, no conflict
    const d = env.data as Record<string, unknown>;
    expect(d.txChainId).toBeNull();
    expect(d.chainId).toBe(42161);
    expect((d.signer as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
  });

  it("decodes an eip2930 (0x01 envelope) tx", async () => {
    const signed = await SIGNER.signTransaction({ type: "eip2930", chainId: 1, nonce: 14, to: MAINNET_DEPLOYMENT.bundler3, value: 0n, gas: 21_000n, gasPrice: 10n ** 9n, accessList: [] });
    const env = await runTool("cork_decode", { kind: "tx", data: signed }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.type).toBe("eip2930");
    expect((d.signer as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(d.toLabel).toBe("bundler3");
  });

  it("rejects unsigned or undecodable bytes as teachable invalid input", async () => {
    // Inner calldata alone is not a transaction envelope.
    await expect(runTool("cork_decode", { kind: "tx", data: DEMO_MULTICALL }, { nowSeconds: NOW })).rejects.toBeInstanceOf(ToolInputError);
    // A structured record is not accepted — the parse is reconstructed from bytes only [K3].
    await expect(runTool("cork_decode", { kind: "tx", data: { to: SUSDE } }, { nowSeconds: NOW })).rejects.toBeInstanceOf(ToolInputError);
  });
});
