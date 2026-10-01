// rollover-intent HOOKS (2026-10-01, the 2026-10-01 integration triage, item 4, found by the fork rehearsal): a
// roll order's intent must carry the pre-hook that pulls the holder's src cPT into the clone and
// the post-hook that returns the minted dst cPT, and both are hashed into the signed commitment.
// The builder never carried hooks, so no order it built could complete on chain. `standardHooks`
// composes the two canonical modules of the settler generation; `hooks` takes explicit calls.
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress } from "viem";
import { buildRolloverIntent, intentStructHash, ownerTokenPullModuleAbi, postRolloverDstCptTransferModuleAbi, resolveRollover, runTool, standardRolloverHooks } from "@cork/core";

const NOW = 1_790_000_000n;
const CHAIN = 8453;
const HOLDER = getAddress("0x00000000000000000000000000000000000000ab");
const CLONE = getAddress("0x0000000000000000000000000000000000000c10");
const SRC_CST = getAddress("0x00000000000000000000000000000000000000c1");
const DST_CST = getAddress("0x00000000000000000000000000000000000000c2");
const SRC_CPT = getAddress("0x00000000000000000000000000000000000000d1");
const DST_CPT = getAddress("0x00000000000000000000000000000000000000d2");
const PREMIUM = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const rollover = (await resolveRollover(CHAIN)).rollover!;
const EXACT = rollover.exactSettler as `0x${string}`;
const MODULES = rollover.modules as { ownerTokenPull: `0x${string}`; postRolloverDstCptTransfer: `0x${string}` };
const base = { chainId: CHAIN, user: HOLDER, settler: EXACT, rolloverContract: CLONE, srcCstToken: SRC_CST, dstCstToken: DST_CST, premiumToken: PREMIUM, srcPoolId: `0x${"11".repeat(32)}` as const, dstPoolId: `0x${"22".repeat(32)}` as const, orderSize: 10n ** 18n, minPremiumPerShare: 62n, openDeadline: NOW + 600n, fillDeadline: NOW + 1200n, clientRequestId: "hooks-0001" };

describe("standardRolloverHooks — the two canonical modules, encoded from their own ABIs", () => {
  it("pre = OwnerTokenPullModule.execute(srcCpt, orderSize, allowUnderfill); post = PostRolloverDstCptTransferModule.execute(dstCpt, recipient); both delegatecall, zero value, non-optional", () => {
    const h = standardRolloverHooks({ modules: MODULES, srcCptToken: SRC_CPT, dstCptToken: DST_CPT, orderSize: 5n, recipient: HOLDER, allowUnderfill: true });
    expect(h.preRolloverHooks).toHaveLength(1);
    expect(h.postRolloverHooks).toHaveLength(1);
    const pre = h.preRolloverHooks[0]!;
    expect(pre).toMatchObject({ target: MODULES.ownerTokenPull, value: 0n, allowFailure: false, isDelegateCall: true });
    expect(decodeFunctionData({ abi: ownerTokenPullModuleAbi, data: pre.callData })).toEqual({ functionName: "execute", args: [SRC_CPT, 5n, true] });
    const post = h.postRolloverHooks[0]!;
    expect(post).toMatchObject({ target: MODULES.postRolloverDstCptTransfer, value: 0n, allowFailure: false, isDelegateCall: true });
    expect(decodeFunctionData({ abi: postRolloverDstCptTransferModuleAbi, data: post.callData })).toEqual({ functionName: "execute", args: [DST_CPT, HOLDER] });
    // The live intents on Base (underwriter-one, 2026-09-30) use exactly these selectors.
    expect(pre.callData.slice(0, 10)).toBe("0x7ea72f84");
    expect(post.callData.slice(0, 10)).toBe("0xd80aea15");
  });

  it("hooks change the signed commitment: rolloverIntentHash is the zero-digest struct hash OVER the hooks, and the venue post carries them", () => {
    const hooks = standardRolloverHooks({ modules: MODULES, srcCptToken: SRC_CPT, dstCptToken: DST_CPT, orderSize: base.orderSize, recipient: HOLDER, allowUnderfill: false });
    const plain = buildRolloverIntent(base);
    const withHooks = buildRolloverIntent({ ...base, hooks });
    expect(withHooks.rolloverIntentHash).not.toBe(plain.rolloverIntentHash);
    expect(withHooks.rolloverIntentHash).toBe(intentStructHash(withHooks.intent));
    expect(withHooks.intent.preRolloverHooks).toEqual(hooks.preRolloverHooks);
    expect(withHooks.order.rolloverIntentHash).toBe(withHooks.rolloverIntentHash);
    expect(withHooks.orderDigest).not.toBe(plain.orderDigest);
    expect(withHooks.venuePost.intent.preRolloverHooks).toEqual([{ target: MODULES.ownerTokenPull.toLowerCase(), value: "0", callData: hooks.preRolloverHooks[0]!.callData, allowFailure: false, isDelegateCall: true }]);
    expect(withHooks.venuePost.intent.postRolloverHooks[0]!.target).toBe(MODULES.postRolloverDstCptTransfer.toLowerCase());
    expect(withHooks.venuePost.intent.midRolloverHooks).toEqual([]);
  });
});

describe("runTool rollover-intent with hooks", () => {
  const prepare = (extra: Record<string, unknown>) =>
    runTool("cork_prepare_orders", { chainId: CHAIN, account: HOLDER, clientRequestId: "hooks-0002", action: { type: "rollover-intent", settler: EXACT, rolloverContract: CLONE, srcPoolId: base.srcPoolId, dstPoolId: base.dstPoolId, srcCstToken: SRC_CST, dstCstToken: DST_CST, premiumToken: PREMIUM, orderSize: "1000000000000000000", minPremiumPerShare: "62", openDeadline: (NOW + 600n).toString(), fillDeadline: (NOW + 1200n).toString(), ...extra } }, { nowSeconds: NOW });
  type Data = { intentHooks: { pre: number; mid: number; post: number; premiumPhase: number; standard?: boolean; modules?: unknown }; venuePost: { intent: { preRolloverHooks: unknown[]; postRolloverHooks: unknown[] } }; rolloverIntentHash: string; typedData: { message: { rolloverIntentHash: string } } };
  const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code);

  it("standardHooks composes the settler generation's modules, binds the recipient to the account, and tells the holder to approve the clone", async () => {
    const env = await prepare({ standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    expect(env.state).toBe("ok");
    const d = env.data as Data;
    expect(d.intentHooks).toEqual({ pre: 1, mid: 0, post: 1, premiumPhase: 0, standard: true, modules: MODULES });
    const expected = standardRolloverHooks({ modules: MODULES, srcCptToken: SRC_CPT, dstCptToken: DST_CPT, orderSize: 10n ** 18n, recipient: HOLDER, allowUnderfill: false });
    expect((d.venuePost.intent.preRolloverHooks[0] as { callData: string }).callData).toBe(expected.preRolloverHooks[0]!.callData);
    // The post-hook's recipient is the HOLDER (the account), never the clone or anyone else.
    const post = decodeFunctionData({ abi: postRolloverDstCptTransferModuleAbi, data: (d.venuePost.intent.postRolloverHooks[0] as { callData: `0x${string}` }).callData });
    expect(post.args).toEqual([DST_CPT, HOLDER]);
    expect(d.typedData.message.rolloverIntentHash).toBe(d.rolloverIntentHash);
    expect(codes(env)).toContain("owner_managed_funding");
    expect(env.warnings.find((w) => w.code === "owner_managed_funding")!.message).toMatch(/approve the CLONE/u);
    expect(codes(env)).not.toContain("invalid_order_terms");
  });

  it("explicit hooks pass through the same shape rule the venue applies; no hooks at all is warned, never silently signed", async () => {
    const good = await prepare({ hooks: { preRolloverHooks: [{ target: MODULES.ownerTokenPull, value: "0", callData: "0x7ea72f84", allowFailure: false, isDelegateCall: true }] } });
    expect(good.state).toBe("ok");
    expect((good.data as Data).intentHooks).toEqual({ pre: 1, mid: 0, post: 0, premiumPhase: 0 });
    const bad = await prepare({ hooks: { postRolloverHooks: [{ target: MODULES.postRolloverDstCptTransfer, value: "0", callData: "0xd80aea15", allowFailure: false, isDelegateCall: false }] } });
    expect(bad.state).toBe("unavailable");
    expect(bad.warnings[0]!.message).toMatch(/delegatecall-only/u);
    const both = await prepare({ hooks: {}, standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    expect(both.state).toBe("unavailable");
    expect(both.warnings[0]!.message).toMatch(/mutually exclusive/u);
    const none = await prepare({});
    expect(none.state).toBe("ok");
    expect(codes(none)).toContain("invalid_order_terms");
    expect(none.warnings.find((w) => w.code === "invalid_order_terms")!.message).toMatch(/NO intent hooks/u);
  });

  it("a partial-fill order pulls with the module's clamp (every fill re-pulls orderSize against a shrinking balance) and teaches a standing allowance; an exact order pulls exactly", async () => {
    const partial = await prepare({ settler: rollover.partialSettler, allowPartialFills: true, standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    expect(partial.state).toBe("ok");
    const pre = decodeFunctionData({ abi: ownerTokenPullModuleAbi, data: ((partial.data as Data).venuePost.intent.preRolloverHooks[0] as { callData: `0x${string}` }).callData });
    expect(pre.args).toEqual([SRC_CPT, 10n ** 18n, true]);
    expect(partial.warnings.find((w) => w.code === "owner_managed_funding")!.message).toMatch(/standing across fills.*OwnerTokenPullModule__NothingPullable/u);
    const exact = await prepare({ standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    const preExact = decodeFunctionData({ abi: ownerTokenPullModuleAbi, data: ((exact.data as Data).venuePost.intent.preRolloverHooks[0] as { callData: `0x${string}` }).callData });
    expect(preExact.args).toEqual([SRC_CPT, 10n ** 18n, false]);
    expect(exact.warnings.find((w) => w.code === "owner_managed_funding")!.message).not.toMatch(/standing across fills/u);
    const underfill = await prepare({ allowUnderfill: true, standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    expect(decodeFunctionData({ abi: ownerTokenPullModuleAbi, data: ((underfill.data as Data).venuePost.intent.preRolloverHooks[0] as { callData: `0x${string}` }).callData }).args).toEqual([SRC_CPT, 10n ** 18n, true]);
  });

  it("a generation without configured modules refuses standardHooks and points at explicit hooks", async () => {
    const previous = rollover.generations!.find((g) => g.label === "phoenix/v0.3-rc.1")!;
    expect(previous.modules).toBeUndefined();
    const env = await prepare({ settler: previous.exactSettler, standardHooks: { srcCptToken: SRC_CPT, dstCptToken: DST_CPT } });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("unknown_deployment");
    expect(env.warnings[0]!.message).toMatch(/configures no hook modules/u);
  });
});
