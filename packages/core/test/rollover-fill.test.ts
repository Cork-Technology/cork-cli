// cork_prepare_orders rollover-fill + deploy-rollover-contract (2026-10-01): the FILLER side of
// a rollover. Real bytes throughout — the roll order is built by the
// same intent builder a holder signs with, signed with a throwaway key, and the fill calldata is
// decoded back through the BaseFiller ABI to prove the job the contract will read.
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, hashTypedData, type Hex, keccak256, encodeAbiParameters, toHex, zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRolloverIntent,
  computeOrderDigest,
  corkSettlerDomainSeparator,
  decodeBaseFillerCall,
  encodeOriginData,
  fillerAuthTypedData,
  gaslessOrderOf,
  hashFillerAuth,
  GASLESS_ORDER_COMPONENTS,
  hashJitMarketParams,
  parseRolloverPayload,
  requiredPremium,
  resolveGenerations,
  resolveRollover,
  runTool,
  type HandlerContext,
  type RolloverVenuePost,
} from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";
import { cloneAdmission } from "../src/handlers/rollover-clone-admission.ts";
import { chainStatusName } from "../src/rollover-verify.ts";

// The public Anvil #1 key — a well-known test vector, never a secret: the EXCLUSIVE filler.
const exclusive = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const NOW = 1_790_000_000n;
const CHAIN = 8453;
// The public Anvil #0 key — a well-known test vector, never a secret. The cPT HOLDER (order user).
const holder = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const FILLER = getAddress("0x00000000000000000000000000000000000000f1");
const CLONE = getAddress("0x0000000000000000000000000000000000000c10");
const SRC_CST = getAddress("0x00000000000000000000000000000000000000c1");
const DST_CST = getAddress("0x00000000000000000000000000000000000000c2");
const PREMIUM = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const SRC_POOL = `0x${"11".repeat(32)}` as const;
const SRC_CPT = getAddress("0x00000000000000000000000000000000000000d1");
const DST_CPT = getAddress("0x00000000000000000000000000000000000000d2");
/** Both pools' collateral: a 6-decimal token, so the source share quantum is 1e12. OTHER is an
 *  18-decimal collateral for the cross-collateral cases. */
const COLLATERAL = getAddress("0x00000000000000000000000000000000000000ca");
const OTHER_COLLATERAL = getAddress("0x00000000000000000000000000000000000000cb");
const TOKEN_DECIMALS: Record<string, number> = { [COLLATERAL.toLowerCase()]: 6, [OTHER_COLLATERAL.toLowerCase()]: 18 };
/** The live Base values (read 2026-10-09): the factory's one default attester at threshold 1, the
 *  Rhinestone ERC-7484 registry, and the trust-config timelock whose delay is 0. MALLORY is a
 *  holder's own attester. */
const DEFAULT_ATTESTER = getAddress("0x3BbA97CDCb1593A16Fba8E7AE79a424386F3a600");
const MALLORY_ATTESTER = getAddress("0x0000000000000000000000000000000000007777");
const REGISTRY = getAddress("0x000000000069E2a187AEFFb852bF3cCdC95151B2");
const TRUST_TIMELOCK = getAddress("0x81954908bA5EB09caa9B39b3dD732fdDcbB32Dd7");
const DST_POOL = `0x${"22".repeat(32)}` as const;
type Seen = { url: string; method: string };

const rollover = (await resolveRollover(CHAIN)).rollover!;
const EXACT = rollover.exactSettler as `0x${string}`;
const PARTIAL = rollover.partialSettler as `0x${string}`;
const BASE_FILLER = rollover.baseFiller!;
const FACTORY = rollover.factory as `0x${string}`;
const PREVIOUS = rollover.generations!.find((g) => g.label === "phoenix/v0.3-rc.1")!;

/** A signed roll order the way the venue stores it: the intent builder's venuePost + the
 *  holder's EIP-712 signature + the envelope the venue derives. */
async function signedOrder(over: Partial<Parameters<typeof buildRolloverIntent>[0]> = {}) {
  const built = buildRolloverIntent({
    chainId: CHAIN, user: holder.address, settler: EXACT, rolloverContract: CLONE, srcCstToken: SRC_CST, dstCstToken: DST_CST, premiumToken: PREMIUM,
    srcPoolId: SRC_POOL, dstPoolId: DST_POOL, orderSize: 10n ** 18n, minPremiumPerShare: 62n, openDeadline: NOW + 600n, fillDeadline: NOW + 1200n,
    clientRequestId: "fill-test-0001", ...over,
  });
  const signature = await holder.signTypedData({ domain: built.domain, types: built.types, primaryType: "OrderData", message: built.order });
  const payload = { chainId: CHAIN, order: built.venuePost.order, intent: built.venuePost.intent, signature, envelope: { orderDataType: built.orderDataType, originData: encodeOriginData(gaslessOrderOf(built.order)) } };
  return { built, payload, digest: built.orderDigest };
}

/** Where the factory deploys for an owner that has no clone yet: the holder's is CLONE (the
 *  address the test orders name), anyone else's a fixed other address. */
const PREDICTED_ELSEWHERE = getAddress("0x0000000000000000000000000000000000000b0b");
/** The chain as the pre-flight reads it: settler orderStatus, the rollover factory, the clone's
 *  owner(), balances, allowances. The factory is ONE world — `clones` maps each owner to the clone
 *  deployed for it, `predicted` overrides where an owner WOULD get one — and isDeployed /
 *  rolloverContractOf / predictRolloverContractOf / owner() all derive from it, so no test can
 *  describe a factory whose views disagree. owner() on an address that is no clone reverts, as a
 *  call to it on chain would. */
/** Phoenix as CorkPoolManager answers for one pool: the pool lives on ONE pool manager (shares and
 *  market answer there only), and both previews are the contract's 1:1 conversion after decimal
 *  normalization — previewUnwindMint(shares) = shares / 10^(18 − d) (0 under one quantum, 0 while
 *  the unwind is paused or the pool expired), previewDeposit(c) = c × 10^(18 − d) (0 while
 *  deposits are paused or the pool expired). depositHaircutBps models a pool manager whose
 *  deposit mints fewer shares (a future protocol fee), to show the floor follows the chain. */
interface PoolSpec { pm: string; cpt: string; cst: string; collateral: string; depositPaused?: boolean; unwindPaused?: boolean; expired?: boolean; depositHaircutBps?: bigint }
/** ERC-7484 attestations: module → attester → the module types it attests. */
type Attestations = Record<string, Record<string, bigint[]>>;
interface PoolWorld {
  /** Per-pool overrides of the default world; null removes the pool. */
  pools?: Record<string, Partial<PoolSpec> | null>;
  /** Attestations ADDED to the default ones (the default attester vouches for the two standard
   *  modules, for their own phases only). */
  attestations?: Attestations;
  cloneAttesters?: string[];
  cloneThreshold?: number;
  /** pendingTrustConfig(clone) as [threshold, attesters, effectiveAt]. */
  pending?: [number, string[], bigint];
  snapshot?: Error;
  previewError?: Error;
  checkError?: Error;
  /** Every pool manager's shares() throws: no manager answered, which is not an absent pool. */
  sharesError?: Error;
}
const lc = (a: string) => a.toLowerCase();
const execReverted = (why: string) => new Error(`execution reverted: ${why}`);
/** A failure that is no revert (a lagging node behind a load balancer): no verdict either way. */
const NOT_A_REVERT = new Error("header not found");
const DERIVED_FLOOR = 10n ** 18n;
/** A floor the caller states (the no-RPC paths cannot derive one). */
const FLOOR_GIVEN = "1000000000000000000";
const PRIMARY_LABEL = rollover.generations!.find((g) => g.primary)!.label;
const pmOf = async (label: string) => (await resolveGenerations(CHAIN)).generations.find((g) => g.label === label)!.phoenix!.poolManager as string;
const PRIMARY_PM = await pmOf(PRIMARY_LABEL);
const PREVIOUS_PM = await pmOf(PREVIOUS.label);
const OWNER_PULL = getAddress(rollover.modules!.ownerTokenPull!);
const DST_CPT_TRANSFER = getAddress(rollover.modules!.postRolloverDstCptTransfer!);
const STANDARD_ATTESTATIONS: Attestations = { [lc(OWNER_PULL)]: { [lc(DEFAULT_ATTESTER)]: [5n] }, [lc(DST_CPT_TRANSFER)]: { [lc(DEFAULT_ATTESTER)]: [7n] } };
function chain(o: PoolWorld & { status?: number; clones?: Record<string, string>; predicted?: Record<string, string>; srcBal?: bigint; premBal?: bigint; allow?: Record<string, bigint>; code?: Record<string, string>; isValidSignature?: string | Error } = {}) {
  const clones = new Map(Object.entries(o.clones ?? { [holder.address]: CLONE }).map(([owner, clone]) => [owner.toLowerCase(), getAddress(clone)]));
  const factories = new Set([FACTORY, PREVIOUS.factory as string].map((a) => a.toLowerCase()));
  const factoryOnly = (c: StubCall) => {
    if (!factories.has(c.address.toLowerCase())) throw new Error(`${c.functionName} called on ${c.address}, not a configured rollover factory`);
  };
  const predictedFor = (owner: string) =>
    clones.get(owner.toLowerCase()) ?? getAddress(o.predicted?.[owner] ?? (owner.toLowerCase() === holder.address.toLowerCase() ? CLONE : PREDICTED_ELSEWHERE));
  const defaults: Record<string, PoolSpec> = {
    [SRC_POOL]: { pm: PRIMARY_PM, cpt: SRC_CPT, cst: SRC_CST, collateral: COLLATERAL },
    [DST_POOL]: { pm: PRIMARY_PM, cpt: DST_CPT, cst: DST_CST, collateral: COLLATERAL },
  };
  const pools = new Map<string, PoolSpec>();
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(o.pools ?? {})])) {
    const over = o.pools?.[id];
    if (over === null) continue;
    pools.set(id, { ...defaults[id]!, ...over });
  }
  /** The pool a pool-manager call names, on THAT manager — a manager that does not host it
   *  answers as Phoenix does for an uninitialized id. */
  const poolAt = (c: StubCall) => {
    const spec = pools.get(String(c.args?.[0]));
    return spec !== undefined && lc(spec.pm) === lc(c.address) ? spec : undefined;
  };
  const quantumOf = (spec: PoolSpec) => 10n ** BigInt(18 - TOKEN_DECIMALS[lc(spec.collateral)]!);
  const attestations: Attestations = structuredClone(STANDARD_ATTESTATIONS);
  for (const [m, by] of Object.entries(o.attestations ?? {})) for (const [a, types] of Object.entries(by)) ((attestations[lc(m)] ??= {})[lc(a)] ??= []).push(...types);
  return stubRpc((c: StubCall) => {
    switch (c.functionName) {
      case "orderStatus": return BigInt(o.status ?? 1);
      case "isDeployedRolloverContract": factoryOnly(c); return [...clones.values()].some((v) => v.toLowerCase() === String(c.args?.[0]).toLowerCase());
      case "rolloverContractOf": factoryOnly(c); return clones.get(String(c.args?.[0]).toLowerCase()) ?? zeroAddress;
      case "predictRolloverContractOf": factoryOnly(c); return predictedFor(String(c.args?.[0]));
      case "owner": {
        const owner = [...clones].find(([, clone]) => clone.toLowerCase() === c.address.toLowerCase())?.[0];
        if (owner === undefined) throw execReverted(`${c.address} is not a rollover clone`);
        return getAddress(owner);
      }
      case "shares": { if (o.sharesError) throw o.sharesError; const spec = poolAt(c); return spec ? [spec.cpt, spec.cst] : [zeroAddress, zeroAddress]; }
      case "market": { const spec = poolAt(c); if (!spec) throw execReverted("NotInitialized()"); return { collateralAsset: getAddress(spec.collateral) }; }
      case "decimals": { const d = TOKEN_DECIMALS[lc(c.address)]; if (d === undefined) throw execReverted(`${c.address} is no stubbed token`); return d; }
      case "previewUnwindMint": {
        if (o.previewError) throw o.previewError;
        const spec = poolAt(c);
        if (!spec) throw execReverted("NotInitialized()");
        const shares = c.args?.[1] as bigint;
        if (spec.unwindPaused || spec.expired) return 0n;
        if (shares > 0n && shares < quantumOf(spec)) return 0n;
        return shares / quantumOf(spec);
      }
      case "previewDeposit": {
        if (o.previewError) throw o.previewError;
        const spec = poolAt(c);
        if (!spec) throw execReverted("NotInitialized()");
        if (spec.depositPaused || spec.expired) return 0n;
        const out = (c.args?.[1] as bigint) * quantumOf(spec);
        return out - (out * (spec.depositHaircutBps ?? 0n)) / 10_000n;
      }
      case "defaultAttesters": factoryOnly(c); return [DEFAULT_ATTESTER];
      case "DEFAULT_TRUST_THRESHOLD": factoryOnly(c); return 1;
      case "trustConfigTimelock": factoryOnly(c); return TRUST_TIMELOCK;
      case "getMinDelay": if (lc(c.address) !== lc(TRUST_TIMELOCK)) throw execReverted("not the timelock"); return 0n;
      case "pendingTrustConfig": factoryOnly(c); return o.pending ? [o.pending[0], o.pending[1].map((a) => getAddress(a)), o.pending[2]] : [0, [], 0n];
      case "rolloverContractSnapshot": {
        if (![...clones.values()].some((v) => lc(v) === lc(c.address))) throw execReverted(`${c.address} is not a rollover clone`);
        if (o.snapshot) throw o.snapshot;
        return { erc7484Registry: REGISTRY, liveTrustThreshold: o.cloneThreshold ?? 1, liveTrustAttesters: (o.cloneAttesters ?? [DEFAULT_ATTESTER]).map((a) => getAddress(a)) };
      }
      case "check": {
        // ERC-7484 check(module, type, attesters, threshold): the attesters strictly ascending, and
        // at least `threshold` of them attesting `module` for `type`.
        if (lc(c.address) !== lc(REGISTRY)) throw execReverted("not the registry");
        if (o.checkError) throw o.checkError;
        const [module, moduleType, attesters, threshold] = c.args as [string, bigint, string[], bigint];
        for (let i = 1; i < attesters.length; i++) if (BigInt(attesters[i - 1]!) >= BigInt(attesters[i]!)) throw execReverted("InvalidAttesters()");
        const vouching = attesters.filter((a) => attestations[lc(module)]?.[lc(a)]?.includes(moduleType)).length;
        if (BigInt(vouching) < threshold) throw execReverted("InsufficientAttestations()");
        return undefined;
      }
      case "balanceOf": return c.address.toLowerCase() === SRC_CST.toLowerCase() ? (o.srcBal ?? 10n ** 18n) : (o.premBal ?? 10n ** 9n);
      case "allowance": { const [owner, spender] = c.args as [string, string]; return o.allow?.[`${c.address}:${owner}:${spender}`.toLowerCase()] ?? 0n; }
      case "isValidSignature":
        // Only a contract answers ERC-1271: a call to an address without code returns no data.
        if (o.code?.[c.address.toLowerCase()] === undefined) throw new Error(`execution reverted: ${c.address} has no code (returned no data "0x")`);
        if (o.isValidSignature instanceof Error) throw o.isValidSignature;
        return o.isValidSignature ?? "0x1626ba7e";
      default: throw new Error(`no stub for ${c.functionName}`);
    }
  }, { code: o.code ?? {} });
}
function venue(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET" });
    const r = routes.find((r) => url.includes(r.match));
    if (!r) return new Response(JSON.stringify({ statusCode: 404, error: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
}
const fill = (action: Record<string, unknown>, ctx: Partial<HandlerContext> = {}) =>
  runTool("cork_prepare_orders", { chainId: CHAIN, account: FILLER, clientRequestId: "fill-0001", action: { type: "rollover-fill", ...action } }, { nowSeconds: NOW, resolveRpc: chain(), ...ctx });
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code);
/** The minDstPerSrc the fill calldata actually carries, decoded from the bytes. */
const job = (env: { data: unknown }) => (decodeBaseFillerCall((env.data as { calldata: Hex }).calldata).args[0] as unknown as { minDstPerSrc: bigint }).minDstPerSrc;
type Data = Record<string, unknown> & { calldata: Hex; approvals: Array<{ token: string; spender: string; amount: string; kind: string; satisfied?: boolean }> };

describe("rollover-fill — the filler's BaseFiller.execute from the signed payload", () => {
  it("inline payload: the job decodes back field-for-field, the envelope is abi.encode(order), both allowances go to BaseFiller, the premium cap defaults to ceil(size × rate / 1e18)", async () => {
    const { built, payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload });
    expect(env.state).toBe("ok");
    const d = env.data as Data;
    expect(d).toMatchObject({ kind: "rollover-fill", to: BASE_FILLER, fillFunction: "execute", orderDigest: digest, settler: EXACT, settlerKind: "EXACT", settlerGeneration: "phoenix/v0.5", jitMarketWire: "0.2", chainStatus: "Opened", cloneVerified: true, destination: FILLER, premiumCapEstimated: true });
    expect(d.fillerSrcCst).toBe((10n ** 18n).toString());
    expect(d.premiumCap).toBe(requiredPremium(10n ** 18n, 62n).toString());
    expect(d.premiumCap).toBe("62");
    const { functionName, args } = decodeBaseFillerCall(d.calldata);
    expect(functionName).toBe("execute");
    const job = args[0] as unknown as { settler: string; order: { originSettler: string; user: string; nonce: bigint; originChainId: bigint; openDeadline: number; fillDeadline: number; orderDataType: Hex; orderData: Hex }; userSig: Hex; srcCst: string; premiumToken: string; fillerSrcCst: bigint; intent: { rolloverContract: string; orderDigest: Hex; deadline: bigint; nonce: bigint; preRolloverHooks: unknown[] }; premiumCap: bigint; minDstPerSrc: bigint; fillerAuthSig: Hex };
    expect(job.settler).toBe(EXACT);
    expect(job.order).toMatchObject({ originSettler: EXACT, user: holder.address, nonce: built.order.orderSalt, originChainId: BigInt(CHAIN), openDeadline: Number(NOW + 600n), fillDeadline: Number(NOW + 1200n), orderDataType: built.orderDataType });
    expect(job.order.orderData.length).toBe(2 + 864 * 2);
    expect(job.userSig).toBe(payload.signature);
    expect(job.srcCst).toBe(SRC_CST);
    expect(job.premiumToken).toBe(PREMIUM);
    expect(job.fillerSrcCst).toBe(10n ** 18n);
    expect(job.intent).toMatchObject({ rolloverContract: CLONE, orderDigest: digest, deadline: built.intent.deadline, nonce: built.intent.nonce });
    expect(job.premiumCap).toBe(62n);
    expect(job.minDstPerSrc).toBe(DERIVED_FLOOR); // derived from the two previews, less 1%
    expect(job.fillerAuthSig).toBe("0x");
    // The envelope the settler re-encodes and compares byte-for-byte.
    const [reencoded] = decodeAbiParameters([{ type: "tuple", components: GASLESS_ORDER_COMPONENTS }], d.originData as Hex);
    expect(reencoded).toEqual(job.order);
    expect(computeOrderDigest(CHAIN, parseRolloverPayload(payload).order)).toBe(digest);
    expect(d.approvals.map((a) => [a.token, a.spender, a.amount, a.kind, a.satisfied])).toEqual([[SRC_CST, BASE_FILLER, (10n ** 18n).toString(), "exact", false], [PREMIUM, BASE_FILLER, "62", "cap", false]]);
    expect(codes(env)).toEqual(["premium_cap_estimated", "approval_missing", "dst_floor_derived", "unsigned_artifact"]);
    expect(d["minDstPerSrcSource"]).toBe("derived");
    expect(d["dstFloor"]).toEqual({ honestRate: "1000000000000000000", srcBurned: "1000000000000000000", quantum: "1000000000000", collateralOut: "1000000", collateralAsset: COLLATERAL, expectedDstCst: "1000000000000000000", depositPreviewedOn: "destination" });
    expect((d["trust"] as { cloneMatchesDefaults: boolean }).cloneMatchesDefaults).toBe(true);
    expect(env.provenance.source).toBe("config");
    expect((d.execution as { kind: string }).kind).toBe("eth-transaction");
  });

  it("venue path: the record is fetched by digest, the digest is RECOMPUTED, a payload that hashes elsewhere is a conflict and never filled", async () => {
    const { payload, digest } = await signedOrder();
    const seen: Seen[] = [];
    const ok = await fill({ orderDigest: digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${digest}`, body: { order: { orderDigest: digest, remainingSize: "1000000000000000000", payload }, fills: [], slots: [] } }], seen) });
    expect(ok.state).toBe("ok");
    expect(ok.provenance.source).toBe("service");
    expect(seen[0]!.url).toContain(`/rollover/v1/orders/${digest}`);
    const other = `0x${"ab".repeat(32)}` as const;
    const lie = await fill({ orderDigest: other }, { venueFetch: venue([{ match: `/rollover/v1/orders/${other}`, body: { order: { orderDigest: other, payload }, fills: [], slots: [] } }]) });
    expect(lie.state).toBe("conflict");
    expect(codes(lie)).toEqual(["order_hash_mismatch"]);
    expect((lie.data as { localOrderDigest: string }).localOrderDigest).toBe(digest);
    const missing = await fill({ orderDigest: other }, { venueFetch: venue([]) });
    expect(missing.state).toBe("unavailable");
    expect(codes(missing)).toEqual(["order_not_found"]);
  });

  it("the settler's own rules, pre-empted by name: full size on an ExactSettler, mode vs settler kind, a passed fillDeadline, a reserved filler, a terminal status", async () => {
    const { payload, digest } = await signedOrder();
    const short = await fill({ orderDigest: digest, signedOrder: payload, fillerSrcCst: "500000000000000000" });
    expect(short.state).toBe("unavailable");
    expect(short.warnings[0]!.message).toMatch(/Settler__ExactFillRequiresFullOrderSize/u);
    const partialOnExact = await signedOrder({ allowPartialFills: true });
    const mode = await fill({ orderDigest: partialOnExact.digest, signedOrder: partialOnExact.payload });
    expect(mode.state).toBe("unavailable");
    expect(codes(mode)).toEqual(["settler_mode_mismatch"]);
    const expired = await signedOrder({ fillDeadline: NOW - 1n, openDeadline: NOW - 2n });
    const late = await fill({ orderDigest: expired.digest, signedOrder: expired.payload });
    expect(late.state).toBe("unavailable");
    expect(late.warnings[0]!.message).toMatch(/Settler__FillAfterDeadline/u);
    const reserved = await signedOrder({ exclusiveFiller: exclusive.address });
    const priv = await fill({ orderDigest: reserved.digest, signedOrder: reserved.payload });
    expect(priv.state).toBe("unavailable");
    expect(codes(priv)).toEqual(["private_order"]);
    // Every terminal status refuses, by its own name.
    for (const name of ["Settled", "Expired", "Cancelled", "Closing"]) {
      const status = [0, 1, 2, 3, 4, 5].find((i) => chainStatusName(i) === name)!;
      const terminal = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ status }) });
      expect(terminal.state, name).toBe("conflict");
      expect(codes(terminal)).toEqual(["status_mismatch"]);
      expect(terminal.warnings[0]!.message).toContain(name);
    }
    const opened = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ status: 1 }) });
    expect(opened.state).toBe("ok");
  });

  it("a RESERVED order: settler.fill's caller is BaseFiller, so even the exclusive filler itself needs a FillerAuth signature over the account that calls BaseFiller; the signature is verified the way the settler verifies it", async () => {
    const { payload, digest } = await signedOrder({ exclusiveFiller: exclusive.address });
    const priv = await fill({ orderDigest: digest, signedOrder: payload });
    const td = (priv.data as { fillerAuthTypedData: Parameters<typeof hashTypedData>[0]; fillerAuthDigest: Hex }).fillerAuthTypedData;
    // The typed data the refusal hands back IS the digest the settler checks: LibFillerAuth.hashFillerAuth
    // = toTypedDataHash(domain, keccak(FILLER_AUTH_TYPEHASH ‖ orderDigest ‖ destination ‖ subFiller)).
    const typehash = keccak256(toHex("FillerAuth(bytes32 orderDigest,address destination,bytes32 subFiller)"));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [typehash, digest, FILLER, `0x${FILLER.slice(2).toLowerCase().padStart(64, "0")}` as Hex]));
    const manual = keccak256(`0x1901${corkSettlerDomainSeparator(CHAIN, EXACT).slice(2)}${structHash.slice(2)}` as Hex);
    expect(hashTypedData(td)).toBe(manual);
    expect(hashFillerAuth({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER })).toBe(manual);
    expect((priv.data as { fillerAuthDigest: Hex }).fillerAuthDigest).toBe(manual);
    // The exclusive filler (an EOA) delegates to FILLER: verified chain-free by ecrecover.
    const auth = await exclusive.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER }));
    const authed = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: auth });
    expect(authed.state).toBe("ok");
    expect((authed.data as Data).fillerAuth).toBe("eoa-verified");
    expect((decodeBaseFillerCall((authed.data as Data).calldata).args[0] as { fillerAuthSig: Hex }).fillerAuthSig).toBe(auth);
    // The wrong signer: ecrecover yields someone else and the filler's isValidSignature (an EOA
    // has none — the staticcall reverts) rejects → a conflict, no bytes.
    const wrong = await holder.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER }));
    const bad = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: wrong });
    expect(bad.state).toBe("conflict");
    expect(codes(bad)).toEqual(["signature_or_reconstruction_mismatch"]);
    expect((bad.data as { recoveredSigner: string }).recoveredSigner.toLowerCase()).toBe(holder.address.toLowerCase());
    // A signature over a DIFFERENT account (the exclusive filler delegating to someone else) is
    // not this fill's authorization.
    const forOther = await exclusive.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: holder.address }));
    const other = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: forOther });
    expect(other.state).toBe("conflict");
    // Without an RPC a non-recovering signature rides unverified, said so.
    const blind = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: wrong, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc: async () => null });
    expect(blind.state).toBe("ok");
    expect((blind.data as Data).fillerAuth).toBe("unverified");
    expect(blind.warnings.find((w) => w.code === "funding_needs_rpc")!.message).toMatch(/does not ecrecover to/u);
    // A reservation for the ACCOUNT ITSELF is still gated: the contract sees BaseFiller as the caller.
    const self = await signedOrder({ exclusiveFiller: FILLER });
    const selfRefused = await fill({ orderDigest: self.digest, signedOrder: self.payload });
    expect(selfRefused.state).toBe("unavailable");
    expect(codes(selfRefused)).toEqual(["private_order"]);
    expect(selfRefused.warnings[0]!.message).toMatch(/YOUR OWN signature/u);
    // A reservation for BaseFiller itself is the one direct pass through this path.
    const forBaseFiller = await signedOrder({ exclusiveFiller: BASE_FILLER as `0x${string}` });
    const direct = await fill({ orderDigest: forBaseFiller.digest, signedOrder: forBaseFiller.payload });
    expect(direct.state).toBe("ok");
    expect((direct.data as Data).fillerAuth).toBe("reserved-for-base-filler");
  });

  it("an order signed under another chain's settler domain cannot be filled here; a passed openDeadline is disclosed chain-free and refused once the chain says the order is still None", async () => {
    const foreign = await signedOrder({ chainId: 42161 });
    const env = await fill({ orderDigest: foreign.digest, signedOrder: foreign.payload });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.message).toMatch(/originChainId is 42161, not 8453/u);
    const late = await signedOrder({ openDeadline: NOW - 1n, fillDeadline: NOW + 600n });
    const blind = await fill({ orderDigest: late.digest, signedOrder: late.payload, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc: async () => null });
    expect(blind.state).toBe("ok");
    expect(blind.warnings.find((w) => w.code === "would_revert")!.message).toMatch(/Settler__OpenAfterOpenDeadline/u);
    const none = await fill({ orderDigest: late.digest, signedOrder: late.payload }, { resolveRpc: chain({ status: 0 }) });
    expect(none.state).toBe("unavailable");
    expect(none.warnings[0]!.message).toMatch(/Settler__OpenAfterOpenDeadline/u);
    const opened = await fill({ orderDigest: late.digest, signedOrder: late.payload }, { resolveRpc: chain({ status: 1 }) });
    expect(opened.state).toBe("ok");
  });

  it("the fill size defaults to the venue's remainingSize (string or number); inline on a partial order it defaults to the ORDER size and says so", async () => {
    const p = await signedOrder({ settler: PARTIAL, allowPartialFills: true });
    const asString = await fill({ orderDigest: p.digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${p.digest}`, body: { order: { orderDigest: p.digest, remainingSize: "250000000000000000", payload: p.payload }, fills: [], slots: [] } }]) });
    expect(asString.state).toBe("ok");
    expect((asString.data as Data).fillerSrcCst).toBe("250000000000000000");
    expect(codes(asString)).not.toContain("invalid_order_terms");
    const asNumber = await fill({ orderDigest: p.digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${p.digest}`, body: { order: { orderDigest: p.digest, remainingSize: 250000000000000, payload: p.payload }, fills: [], slots: [] } }]) });
    expect((asNumber.data as Data).fillerSrcCst).toBe("250000000000000");
    const inline = await fill({ orderDigest: p.digest, signedOrder: p.payload });
    expect(inline.state).toBe("ok");
    expect((inline.data as Data).fillerSrcCst).toBe("1000000000000000000");
    expect(inline.warnings.find((w) => w.code === "invalid_order_terms")!.message).toMatch(/inline path has no remaining-size source/u);
    const exact = await signedOrder();
    const exactInline = await fill({ orderDigest: exact.digest, signedOrder: exact.payload });
    expect(codes(exactInline)).not.toContain("invalid_order_terms"); // an exact order fills at its size by definition
  });

  it("the clone the ORDER names is admitted the way the settler admits it: deployed first, then owned by the holder; each refusal names the settler's error and the holder's fix", async () => {
    const p = await signedOrder(); // names CLONE, the address the factory deploys for the holder
    const OTHER_PREDICTED = getAddress("0x0000000000000000000000000000000000000abc");
    const HOLDER_CLONE = getAddress("0x0000000000000000000000000000000000000d0d");
    const STRANGER = getAddress("0x0000000000000000000000000000000000005555");
    const refusal = async (world: Parameters<typeof chain>[0]) => {
      const env = await fill({ orderDigest: p.digest, signedOrder: p.payload }, { resolveRpc: chain(world) });
      expect(env.state).toBe("unavailable");
      const w = env.warnings.find((x) => x.code === "invalid_order_terms")!;
      return { data: env.data as Record<string, unknown>, message: w.message };
    };

    // 1. Not deployed, and the order names the holder's predicted address: the holder deploys,
    //    and this SAME signed order then fills.
    const deploys = await refusal({ clones: {} });
    expect(deploys.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-deploys-clone", rolloverContract: CLONE, holder: holder.address });
    expect(deploys.message).toMatch(new RegExp(`Settler__RolloverContractNotDeployed\\(${holder.address}\\)`, "u"));
    expect(deploys.message).toMatch(/deploy-rollover-contract from their own account[\s\S]*The same signed order then fills/u);

    // 2. Not deployed, and the order names some other address: no deployment helps.
    const elsewhere = await refusal({ clones: {}, predicted: { [holder.address]: OTHER_PREDICTED } });
    expect(elsewhere.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-signs-new-order" });
    expect(elsewhere.message).toMatch(new RegExp(`no deployment can change that[\\s\\S]*new order naming ${OTHER_PREDICTED}`, "u"));

    // 3. Not deployed, while the holder HAS a clone at another address: still check 1, not a
    //    "wrong owner" — and the fix names the clone the holder already has.
    const hasOne = await refusal({ clones: { [holder.address]: HOLDER_CLONE } });
    expect(hasOne.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-signs-new-order" });
    expect(hasOne.message).toMatch(new RegExp(`new order naming their clone ${HOLDER_CLONE}`, "u"));

    // 4. The order names someone else's DEPLOYED clone while the holder has none: check 2.
    const theirs = await refusal({ clones: { [STRANGER]: CLONE } });
    expect(theirs.data).toMatchObject({ settlerError: "Settler__UserNotRolloverContractOwner", fix: "holder-signs-new-order" });
    expect(theirs.message).toMatch(new RegExp(`owned by ${STRANGER}, not by the holder[\\s\\S]*Settler__UserNotRolloverContractOwner\\(${holder.address}, ${CLONE}\\)`, "u"));
    expect(theirs.message).toMatch(new RegExp(`new order naming ${PREDICTED_ELSEWHERE}|new order naming ${CLONE}`, "u"));

    // The admitted case still builds, and says it verified the clone.
    const ok = await fill({ orderDigest: p.digest, signedOrder: p.payload }, { resolveRpc: chain() });
    expect(ok.state).toBe("ok");
    expect((ok.data as Record<string, unknown>).cloneVerified).toBe(true);
  });

  it("a partial-settler order fills at a smaller size; a low premium cap and a short balance are named before the chain says so", async () => {
    const p = await signedOrder({ settler: PARTIAL, allowPartialFills: true });
    const env = await fill({ orderDigest: p.digest, signedOrder: p.payload, fillerSrcCst: "250000000000000000", premiumCap: "10" }, { resolveRpc: chain({ srcBal: 10n ** 17n }) });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ settlerKind: "PARTIAL", fillerSrcCst: "250000000000000000", premiumCap: "10", premiumCapEstimated: false, premiumAtOneToOne: "16" });
    const msgs = env.warnings.filter((w) => w.code === "would_revert").map((w) => w.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/premiumCap 10 is below .* = 16, .*Settler__PremiumExceedsCap/u);
    expect(msgs[1]).toMatch(/you hold 100000000000000000 of the src cST/u);
  });

  it("a JIT commitment: executeWithMarket on the settler generation's wire, the instruction must hash to the signed commitment; missing or surplus instructions refuse", async () => {
    const jit = { collateralAsset: PREMIUM, referenceAsset: DST_CST, expiryTimestamp: NOW + 86_400n * 10n, recipe: getAddress("0x00000000000000000000000000000000000000ec"), rateOverride: 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, additionalData: "0x" as Hex, oracleSalt: zeroHash, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
    const hash = hashJitMarketParams(jit, "0.2");
    const committed = await signedOrder({ jitMarketHash: hash });
    const jitInput = { collateralAsset: jit.collateralAsset, referenceAsset: jit.referenceAsset, expiryTimestamp: jit.expiryTimestamp.toString(), recipe: jit.recipe, constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" } };
    const env = await fill({ orderDigest: committed.digest, signedOrder: committed.payload, jitMarket: jitInput });
    expect(env.state).toBe("ok");
    expect((env.data as Data).fillFunction).toBe("executeWithMarket");
    const { functionName, args } = decodeBaseFillerCall((env.data as Data).calldata);
    expect(functionName).toBe("executeWithMarket");
    expect(args[1]).toMatchObject({ collateralAsset: PREMIUM, referenceAsset: DST_CST, recipe: jit.recipe, oracleSalt: zeroHash, constraint: { rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n } });
    const drifted = await fill({ orderDigest: committed.digest, signedOrder: committed.payload, jitMarket: { ...jitInput, swapFeePercentage: "1000000000000000000" } });
    expect(drifted.state).toBe("conflict");
    expect(codes(drifted)).toEqual(["jit_market_hash_mismatch"]);
    expect((drifted.data as { committedJitMarketHash: string }).committedJitMarketHash).toBe(hash);
    const missing = await fill({ orderDigest: committed.digest, signedOrder: committed.payload });
    expect(missing.state).toBe("unavailable");
    expect(missing.warnings[0]!.message).toMatch(/pass the negotiated jitMarket instruction/u);
    const plain = await signedOrder();
    const surplus = await fill({ orderDigest: plain.digest, signedOrder: plain.payload, jitMarket: jitInput });
    expect(surplus.state).toBe("unavailable");
    expect(surplus.warnings[0]!.message).toMatch(/commits to NO just-in-time market/u);
  });

  it("an rc.2 settler (the previous generation) builds against ITS BaseFiller and refuses a non-zero oracleSalt its struct cannot carry", async () => {
    const jit = { collateralAsset: PREMIUM, referenceAsset: DST_CST, expiryTimestamp: NOW + 86_400n * 10n, recipe: getAddress("0x00000000000000000000000000000000000000ec"), rateOverride: 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, additionalData: "0x" as Hex, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
    const hash = hashJitMarketParams(jit, "rc.2");
    const o = await signedOrder({ settler: PREVIOUS.exactSettler as `0x${string}`, jitMarketHash: hash });
    const jitInput = { collateralAsset: jit.collateralAsset, referenceAsset: jit.referenceAsset, expiryTimestamp: jit.expiryTimestamp.toString(), recipe: jit.recipe, constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" } };
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: jitInput });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ to: PREVIOUS.baseFiller, settlerGeneration: "phoenix/v0.3-rc.1", jitMarketWire: "rc.2", fillFunction: "executeWithMarket" });
    expect(decodeBaseFillerCall((env.data as Data).calldata).args[1]).not.toHaveProperty("oracleSalt");
    const salted = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: { ...jitInput, oracleSalt: `0x${"01".repeat(32)}` } });
    expect(salted.state).toBe("unavailable");
    expect(salted.warnings[0]!.message).toMatch(/oracleSalt/u);
  });

  it("without an RPC the fill is built from the signed payload alone and says what was not read", async () => {
    const { payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect(codes(env)).toEqual(["premium_cap_estimated", "funding_needs_rpc", "unsigned_artifact"]);
    expect((env.data as Data).chainStatus).toBeNull();
    expect((env.data as Data).approvals.every((a) => a.satisfied === undefined)).toBe(true);
  });
});

describe("rollover-fill — the filler's floor (planning#83)", () => {
  // The holder controls the clone's attesters (the trust-config delay is 0) and the hooks it
  // signed; a mid-roll hook can keep the unwound collateral. minDstPerSrc is the settler's only
  // check on value, so an omitted floor is derived from the two previews and a missing one refuses.
  const floorOf = (env: { data: unknown }) => (env.data as Data)["dstFloor"] as Record<string, unknown>;
  const gapOf = (env: { data: unknown }) => (env.data as { gap?: string } | null)?.gap;

  it("omitted: the previewed rate itself, with no tolerance — Phoenix unwinds and deposits at exactly 1:1", async () => {
    const { payload, digest } = await signedOrder({ orderSize: 2n * 10n ** 18n });
    const env = await fill({ orderDigest: digest, signedOrder: payload });
    expect(env.state).toBe("ok");
    expect(job(env)).toBe(10n ** 18n);
    expect(floorOf(env)).toEqual({ honestRate: "1000000000000000000", srcBurned: "2000000000000000000", quantum: "1000000000000", collateralOut: "2000000", collateralAsset: COLLATERAL, expectedDstCst: "2000000000000000000", depositPreviewedOn: "destination" });
    expect(env.warnings.find((w) => w.code === "dst_floor_derived")!.message).toMatch(/previewUnwindMint returns 2000000 collateral for the 2000000000000000000 src cST .*previewDeposit on the destination mints 2000000000000000000 .*no tolerance/u);
  });

  it("the floor follows the chain's answer, not a constant: a destination that mints fewer shares lowers it", async () => {
    const { payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ pools: { [DST_POOL]: { depositHaircutBps: 50n } } }) });
    expect(env.state).toBe("ok");
    expect(job(env)).toBe((10n ** 18n * 9_950n) / 10_000n);
    expect(floorOf(env)["expectedDstCst"]).toBe("995000000000000000");
  });

  it("a fill off the source share quantum is refused by name, with a stated floor and when the destination cannot be priced", async () => {
    const part = await signedOrder({ settler: PARTIAL, allowPartialFills: true, orderSize: 2n * 10n ** 18n });
    for (const [label, extra, world] of [
      ["derived", {}, chain()],
      ["stated", { minDstPerSrc: FLOOR_GIVEN }, chain()],
      ["destination unknown", {}, chain({ pools: { [DST_POOL]: null } })],
    ] as const) {
      const env = await fill({ orderDigest: part.digest, signedOrder: part.payload, fillerSrcCst: "1000000500000000000", ...extra }, { resolveRpc: world });
      expect(env.state, label).toBe("unavailable");
      expect(env.warnings[0]!.code, label).toBe("invalid_order_terms");
      expect(env.warnings[0]!.message, label).toMatch(/not a multiple of the source pool's share quantum 1000000000000 \(10\^\(18 − 6\) for its 6-decimal collateral\) — the settler reverts LibPhoenixShareQuantum__FillAmountNotQuantumAligned/u);
      expect(gapOf(env), label).toBe("fill-refused");
    }
    const aligned = await fill({ orderDigest: part.digest, signedOrder: part.payload, fillerSrcCst: "1000001000000000000" });
    expect(aligned.state).toBe("ok");
    expect(floorOf(aligned)).toMatchObject({ srcBurned: "1000001000000000000", collateralOut: "1000001", expectedDstCst: "1000001000000000000" });
    expect(job(aligned)).toBe(10n ** 18n);
  });

  it("omitted and underivable: no bytes, the gap named in data, the teaching names the explicit input; the same fill with a stated floor builds", async () => {
    const { payload, digest } = await signedOrder();
    const cases: Array<[string, PoolWorld | null, string, RegExp]> = [
      ["no RPC", null, "no-rpc", /no RPC resolved to read previewUnwindMint/u],
      ["destination unknown", { pools: { [DST_POOL]: null } }, "destination-pool-unknown", /destination pool .* is unknown to every pool manager asked/u],
      ["source unknown", { pools: { [SRC_POOL]: null } }, "source-pool-unknown", /source pool .* is unknown to every pool manager asked/u],
      ["another cST", { pools: { [DST_POOL]: { cst: SRC_CPT } } }, "token-mismatch", /destination pool's cST is .*, not the order's dstCstToken/u],
      ["cross-collateral", { pools: { [DST_POOL]: { collateral: OTHER_COLLATERAL } } }, "cross-collateral", /source collateral .* differs from the destination collateral .*no preview prices that conversion/u],
      ["unwind paused", { pools: { [SRC_POOL]: { unwindPaused: true } } }, "source-closed", /previewUnwindMint\(.*\) answers 0: the source pool's unwind is paused or the pool expired/u],
      ["destination expired", { pools: { [DST_POOL]: { expired: true } } }, "destination-closed", /previewDeposit\(.*\) on the destination answers 0: deposits are paused or the pool expired/u],
      ["a read with no verdict", { previewError: NOT_A_REVERT }, "read-failed", /a preview read failed \(header not found\)/u],
      ["a reverting read", { previewError: execReverted("Panic(0x11)") }, "read-failed", /a preview read reverted/u],
      ["no pool manager answered", { sharesError: NOT_A_REVERT }, "read-failed", /every pool-manager read for the source pool failed/u],
    ];
    for (const [label, world, gap, why] of cases) {
      const resolveRpc = world === null ? async () => null : chain(world);
      const env = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc });
      expect(env.state, label).toBe("unavailable");
      const w = env.warnings.find((x) => x.code === "dst_floor_underivable")!;
      expect(w.message, label).toMatch(why);
      expect(w.message, label).toMatch(/pass minDstPerSrc explicitly .*a same-collateral roll mints one dst cST per src cST and 1e18 is its honest floor/u);
      expect(gapOf(env), label).toBe(gap);
      expect((env.data as Record<string, unknown>)["calldata"], label).toBeUndefined();
      expect(codes(env), label).not.toContain("premium_cap_estimated"); // amount notices ride the ok artifact only
      const given = await fill({ orderDigest: digest, signedOrder: payload, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc });
      expect(given.state, label).toBe("ok");
      expect((given.data as Data)["minDstPerSrcSource"], label).toBe("explicit");
      expect((given.data as Data)["dstFloor"], label).toBeNull();
      expect(job(given), label).toBe(BigInt(FLOOR_GIVEN));
    }
  });

  it("a just-in-time destination is priced by its pool manager's deposit rule, read on the source pool; another collateral or another pool manager cannot be priced", async () => {
    const jitOf = (collateralAsset: string) => ({ collateralAsset: getAddress(collateralAsset), referenceAsset: DST_CST, expiryTimestamp: NOW + 86_400n * 10n, recipe: getAddress("0x00000000000000000000000000000000000000ec"), rateOverride: 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, additionalData: "0x" as Hex, oracleSalt: zeroHash, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n });
    const inputOf = (j: ReturnType<typeof jitOf>) => ({ collateralAsset: j.collateralAsset, referenceAsset: j.referenceAsset, expiryTimestamp: j.expiryTimestamp.toString(), recipe: j.recipe, constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" } });
    const noDst = { [DST_POOL]: null };
    const same = jitOf(COLLATERAL);
    const o = await signedOrder({ jitMarketHash: hashJitMarketParams(same, "0.2") });
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: inputOf(same) }, { resolveRpc: chain({ pools: noDst }) });
    expect(env.state).toBe("ok");
    expect(job(env)).toBe(10n ** 18n);
    expect(floorOf(env)["depositPreviewedOn"]).toBe("source (just-in-time destination, same pool manager)");
    const other = jitOf(OTHER_COLLATERAL);
    const o2 = await signedOrder({ jitMarketHash: hashJitMarketParams(other, "0.2") });
    const cross = await fill({ orderDigest: o2.digest, signedOrder: o2.payload, jitMarket: inputOf(other) }, { resolveRpc: chain({ pools: noDst }) });
    expect(gapOf(cross)).toBe("cross-collateral");
    // The source pool lives on the previous generation's manager; the destination would be created
    // on the primary's: no live pool shares its deposit rule.
    const elsewhere = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: inputOf(same) }, { resolveRpc: chain({ pools: { ...noDst, [SRC_POOL]: { pm: PREVIOUS_PM } } }) });
    expect(gapOf(elsewhere)).toBe("destination-pool-unknown");
    expect(elsewhere.warnings.find((w) => w.code === "dst_floor_underivable")!.message).toMatch(new RegExp(`created on pool manager ${PRIMARY_PM}, not on the source pool's ${PREVIOUS_PM}`, "iu"));
  });

  it("a stated floor is measured against the honest rate: 0 gives up the check, below it gives the hooks slack, above it reverts, equal is quiet", async () => {
    const { payload, digest } = await signedOrder();
    const at = (minDstPerSrc: string) => fill({ orderDigest: digest, signedOrder: payload, minDstPerSrc });
    const zero = await at("0");
    expect(job(zero)).toBe(0n);
    expect(zero.warnings.find((w) => w.code === "no_dst_floor")!.message).toMatch(/settler checks no mint rate.*an honest roll mints 1000000000000000000 dst cST here \(floor 1000000000000000000\)/u);
    const slack = await at("600000000000000000");
    expect(slack.warnings.find((w) => w.code === "dst_floor_slack")!.message).toMatch(/below the honest rate 1000000000000000000: an honest roll mints 1000000000000000000 dst cST, and the fill still succeeds at 600000000000000000, so the holder's hooks can keep the collateral behind the other 400000000000000000 dst cST/u);
    // On a destination that mints fewer shares, the slack is measured the settler's way: on the
    // src cST consumed, not on the shares the deposit mints.
    const thin = await fill({ orderDigest: digest, signedOrder: payload, minDstPerSrc: "600000000000000000" }, { resolveRpc: chain({ pools: { [DST_POOL]: { depositHaircutBps: 50n } } }) });
    expect(thin.warnings.find((w) => w.code === "dst_floor_slack")!.message).toMatch(/below the honest rate 995000000000000000: an honest roll mints 995000000000000000 dst cST, and the fill still succeeds at 600000000000000000, so the holder's hooks can keep the collateral behind the other 395000000000000000 dst cST/u);
    const high = await at((10n ** 18n + 1n).toString());
    expect(high.warnings.find((w) => w.code === "would_revert")!.message).toMatch(/above the rate an honest roll mints now \(1000000000000000000: .*\) — the fill reverts Settler__InsufficientMintRate/u);
    const equal = await at(FLOOR_GIVEN);
    for (const code of ["no_dst_floor", "dst_floor_slack", "would_revert", "dst_floor_derived"]) expect(codes(equal)).not.toContain(code);
    for (const env of [zero, slack, high, equal]) expect((env.data as Data)["minDstPerSrcSource"]).toBe("explicit");
  });
});

describe("rollover-fill — the holder's trust (planning#83)", () => {
  const SKIM = getAddress("0x000000000000000000000000000000000000beef");
  const call = (target: string) => ({ target: getAddress(target), value: 0n, callData: "0x" as Hex, allowFailure: false, isDelegateCall: true });
  const STANDARD = { preRolloverHooks: [call(OWNER_PULL)], postRolloverHooks: [call(DST_CPT_TRANSFER)] };
  type Trust = { cloneMatchesDefaults: boolean; clone: { attesters: string[]; threshold: number }; pending: unknown; changeDelaySeconds: string; hooks: Array<{ phase: string; index: number; target: string; vettedByDefaults: boolean | null }> };
  const trustOf = (env: { data: unknown }) => (env.data as Data)["trust"] as Trust | null;
  /** The planning#83 attack: the holder's clone trusts the default attester AND its own, and its
   *  order runs a skim module only its own attester vouches for, in the MID phase. */
  const ATTACK = { cloneAttesters: [DEFAULT_ATTESTER, MALLORY_ATTESTER], attestations: { [SKIM]: { [MALLORY_ATTESTER]: [6n] } } };

  it("a standard roll: the clone trusts the defaults, both standard modules are vetted for their phases, no change is queued, the delay is read", async () => {
    const o = await signedOrder({ hooks: STANDARD });
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload });
    expect(env.state).toBe("ok");
    expect(trustOf(env)).toEqual({
      registry: REGISTRY,
      defaults: { threshold: 1, attesters: [DEFAULT_ATTESTER] },
      clone: { threshold: 1, attesters: [DEFAULT_ATTESTER] },
      cloneMatchesDefaults: true,
      pending: null,
      changeDelaySeconds: "0",
      hooks: [{ phase: "pre", index: 0, target: OWNER_PULL, vettedByDefaults: true }, { phase: "post", index: 0, target: DST_CPT_TRANSFER, vettedByDefaults: true }],
    });
    for (const code of ["rollover_trust_custom", "rollover_trust_pending", "hook_not_vetted", "chain_read_failed"]) expect(codes(env)).not.toContain(code);
  });

  it("the planning#83 attack: a custom attester set and a self-attested mid hook are named, and the derived floor still closes the theft", async () => {
    const o = await signedOrder({ hooks: { ...STANDARD, midRolloverHooks: [call(SKIM)] } });
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain(ATTACK) });
    expect(env.state).toBe("ok");
    const t = trustOf(env)!;
    expect(t.cloneMatchesDefaults).toBe(false);
    expect(t.hooks.find((h) => h.phase === "mid")).toEqual({ phase: "mid", index: 0, target: SKIM, vettedByDefaults: false });
    expect(t.hooks.filter((h) => h.phase !== "mid").every((h) => h.vettedByDefaults)).toBe(true);
    expect(env.warnings.find((w) => w.code === "rollover_trust_custom")!.message).toMatch(/does not trust the factory's default attesters: it trusts \[.*7777.*\] at threshold 1.*queueTrustConfig, then applyTrustConfig.*delay is 0 s.*minDstPerSrc floor is what protects you/u);
    expect(env.warnings.find((w) => w.code === "hook_not_vetted")!.message).toMatch(/do not vouch for mid hook #0 0x000000000000000000000000000000000000bEEF — a MID-roll hook runs between the source unwind and the destination deposit/u);
    expect(job(env)).toBe(DERIVED_FLOOR);
    // With the floor given up, the same warnings say nothing protects the filler.
    const bare = await fill({ orderDigest: o.digest, signedOrder: o.payload, minDstPerSrc: "0" }, { resolveRpc: chain(ATTACK) });
    expect(bare.warnings.find((w) => w.code === "hook_not_vetted")!.message).toMatch(/with minDstPerSrc = 0 nothing protects you/u);
  });

  it("a module is vetted for its OWN phase only, and against the defaults even when the holder's set vouches for it", async () => {
    // The standard pull module, attested as a PRE hook (type 5), signed into the MID phase.
    const o = await signedOrder({ hooks: { preRolloverHooks: [call(SKIM)], midRolloverHooks: [call(OWNER_PULL)] } });
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain({ ...ATTACK, attestations: { [SKIM]: { [MALLORY_ATTESTER]: [5n] }, [OWNER_PULL]: { [MALLORY_ATTESTER]: [6n] } } }) });
    const t = trustOf(env)!;
    expect(t.hooks).toEqual([
      { phase: "pre", index: 0, target: SKIM, vettedByDefaults: false },
      { phase: "mid", index: 0, target: OWNER_PULL, vettedByDefaults: false },
    ]);
    // The mid hook leads the warning, whatever its position in the intent.
    expect(env.warnings.find((w) => w.code === "hook_not_vetted")!.message).toMatch(new RegExp(`vouch for mid hook #0 ${OWNER_PULL}, pre hook #0 ${SKIM}`, "u"));
  });

  it("a queued trust change is reported; an applied one (OpenZeppelin's done timestamp, 1) is not", async () => {
    const o = await signedOrder({ hooks: STANDARD });
    const queued = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain({ pending: [1, [DEFAULT_ATTESTER, MALLORY_ATTESTER], NOW + 60n] }) });
    expect(trustOf(queued)!.pending).toEqual({ threshold: 1, attesters: [DEFAULT_ATTESTER, MALLORY_ATTESTER], effectiveAt: (NOW + 60n).toString() });
    expect(queued.warnings.find((w) => w.code === "rollover_trust_pending")!.message).toMatch(new RegExp(`queued a trust change .*applicable from ${NOW + 60n} \\(unix seconds\\) by anyone calling applyTrustConfig`, "u"));
    const done = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain({ pending: [0, [], 1n] }) });
    expect(trustOf(done)!.pending).toBeNull();
    expect(codes(done)).not.toContain("rollover_trust_pending");
  });

  it("a read without a verdict is no verdict: an unchecked hook says so, an unreadable clone trust leaves trust null; the floor applies either way", async () => {
    const o = await signedOrder({ hooks: STANDARD });
    const unchecked = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain({ checkError: NOT_A_REVERT }) });
    expect(trustOf(unchecked)!.hooks.every((h) => h.vettedByDefaults === null)).toBe(true);
    expect(codes(unchecked)).not.toContain("hook_not_vetted");
    expect(unchecked.warnings.find((w) => w.code === "chain_read_failed")!.message).toMatch(/registry check of pre hook #0 .*, post hook #0 .* got no verdict/u);
    const unread = await fill({ orderDigest: o.digest, signedOrder: o.payload }, { resolveRpc: chain({ snapshot: NOT_A_REVERT }) });
    expect(unread.state).toBe("ok");
    expect(trustOf(unread)).toBeNull();
    expect(unread.warnings.find((w) => w.code === "chain_read_failed")!.message).toMatch(/clone's trust configuration could not be read/u);
    expect(job(unread)).toBe(DERIVED_FLOOR);
  });
});

describe("deploy-rollover-contract — the per-account clone", () => {
  const deploy = (action: Record<string, unknown>, ctx: Partial<HandlerContext> = {}) =>
    runTool("cork_prepare_orders", { chainId: CHAIN, account: FILLER, clientRequestId: "clone-0001", action: { type: "deploy-rollover-contract", ...action } }, { nowSeconds: NOW, ...ctx });

  it("targets the primary generation's factory with deployRolloverContract(), reports the predicted clone and that none exists", async () => {
    const env = await deploy({}, { resolveRpc: stubRpc((c: StubCall) => (c.functionName === "predictRolloverContractOf" ? CLONE : c.functionName === "rolloverContractOf" ? "0x0000000000000000000000000000000000000000" : (() => { throw new Error(`no stub for ${c.functionName}`); })())) });
    expect(env.state).toBe("ok");
    // deployRolloverContract() — selector 0x39858cf6, no arguments.
    expect(env.data).toMatchObject({ kind: "deploy-rollover-contract", to: FACTORY, calldata: "0x39858cf6", owner: FILLER, predictedRolloverContract: CLONE, existingRolloverContract: null, rolloverGeneration: "phoenix/v0.5", wire: "0.2" });
    expect(codes(env)).toEqual(["unsigned_artifact"]);
  });

  it("an existing clone is reported, and an owner that is not the sender is called out (the factory deploys for msg.sender only)", async () => {
    const env = await deploy({ owner: holder.address }, { resolveRpc: stubRpc((c: StubCall) => (c.functionName === "predictRolloverContractOf" ? CLONE : CLONE)) });
    expect(env.state).toBe("ok");
    expect((env.data as { existingRolloverContract: string }).existingRolloverContract).toBe(CLONE);
    expect(codes(env)).toEqual(["rollover_contract_exists", "invalid_order_terms", "unsigned_artifact"]);
    expect(env.warnings[0]!.message).toMatch(/CorkRolloverContractFactory__AlreadyDeployed/u);
  });
});

export type { RolloverVenuePost };

describe("rollover-fill — the HOLDER's signature is verified the way the settler verifies it", () => {
  // The settler runs SignatureChecker.isValidSignatureNow(order.user, orderDigest, signature) and
  // reverts on a false answer. Bytes for a signature the holder did not give can only revert.
  const CONTRACT_CODE = "0x6080";
  // The same factory world as every other test, with the holder as a contract account.
  const chainWithHolder = (o: { holderCode?: string; isValidSignature?: string | Error }) =>
    chain({ ...(o.isValidSignature !== undefined ? { isValidSignature: o.isValidSignature } : {}), code: o.holderCode !== undefined ? { [holder.address.toLowerCase()]: o.holderCode } : {} });
  type Verdict = Data & { holderSignature: string };

  it("the holder's own signature: eoa-verified, bytes built", async () => {
    const { payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload });
    expect(env.state).toBe("ok");
    expect((env.data as Verdict).holderSignature).toBe("eoa-verified");
  });

  it("a signature the holder did not give over THIS order: refuted, no bytes", async () => {
    const { payload, digest } = await signedOrder();
    const other = await signedOrder({ orderSize: 2n * 10n ** 18n }); // the same key, another order
    for (const signature of [other.payload.signature, `0x${"11".repeat(65)}`]) {
      const env = await fill({ orderDigest: digest, signedOrder: { ...payload, signature } });
      expect(env.state, signature.slice(0, 12)).toBe("conflict");
      expect(codes(env)).toContain("signature_or_reconstruction_mismatch");
      expect(env.warnings.find((w) => w.code === "signature_or_reconstruction_mismatch")!.message).toMatch(/does not verify for .* over the order digest .*is not a contract account.*no fill bytes are built/u);
      expect((env.data as Record<string, unknown>)["calldata"]).toBeUndefined();
    }
  });

  it("no RPC: a signature that does not recover is not refuted — it rides unverified, and says so", async () => {
    const { payload, digest } = await signedOrder();
    const other = await signedOrder({ orderSize: 2n * 10n ** 18n });
    const env = await fill({ orderDigest: digest, signedOrder: { ...payload, signature: other.payload.signature }, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as Verdict).holderSignature).toBe("unverified");
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc" && /the holder's signature does not ecrecover/u.test(w.message))).toBe(true);
    // The holder's real signature needs no chain at all.
    const good = await fill({ orderDigest: digest, signedOrder: payload, minDstPerSrc: FLOOR_GIVEN }, { resolveRpc: async () => null });
    expect((good.data as Verdict).holderSignature).toBe("eoa-verified");
  });

  it("a CONTRACT holder is asked its own isValidSignature: accepted, rejected, and a read that failed", async () => {
    const { payload, digest } = await signedOrder();
    const contractSig = { ...payload, signature: `0x${"22".repeat(65)}` as Hex }; // what a Safe would hand over: not an ECDSA signature of the holder key
    const accepted = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE }) });
    expect(accepted.state, JSON.stringify(accepted.warnings)).toBe("ok");
    expect((accepted.data as Verdict).holderSignature).toBe("erc1271-verified");
    const rejected = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE, isValidSignature: "0xffffffff" }) });
    expect(rejected.state).toBe("conflict");
    expect(rejected.warnings.find((w) => w.code === "signature_or_reconstruction_mismatch")!.message).toMatch(/its isValidSignature did not answer the ERC-1271 magic value/u);
    // An outage is not a verdict: built, labeled.
    const outage = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE, isValidSignature: Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }) }) });
    expect(outage.state, JSON.stringify(outage.warnings)).toBe("ok");
    expect((outage.data as Verdict).holderSignature).toBe("unverified");
    expect(outage.warnings.some((w) => w.code === "chain_read_failed" && /isValidSignature could not be asked/u.test(w.message))).toBe(true);
  });
});

describe("cloneAdmission — the settler's two clone checks as a pure rule", () => {
  const facts = { user: holder.address, named: CLONE, deployed: true, owner: holder.address, predicted: CLONE, holderClone: CLONE } as const;
  it("admits the holder's own deployed clone, and fails closed on a deployed clone whose owner could not be read", () => {
    expect(cloneAdmission(facts, "test")).toEqual({ ok: true });
    // Unreachable through the handler (owner() is read on every deployed clone and a failed read
    // throws), so the rule must not read a missing owner as the holder.
    expect(cloneAdmission({ ...facts, owner: null }, "test")).toMatchObject({ ok: false, settlerError: "Settler__UserNotRolloverContractOwner" });
  });
  it("owner comparison is by address, not by spelling", () => {
    expect(cloneAdmission({ ...facts, owner: holder.address.toLowerCase() as `0x${string}` }, "test")).toEqual({ ok: true });
  });
});
