// Minimal read ABIs (subset of phoenix interfaces) needed for state reads + parity.
export const poolManagerAbi = [
  {
    // Global circuit breaker (PausableUpgradeable). Every _corkPool*NotPaused helper checks this
    // BEFORE the per-pool bit, so a global pause blocks all 13 actions on every pool.
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    // Per-pool pause bits — see PAUSE_BIT in handlers.ts for the action mapping.
    type: "function",
    name: "getPausedBitMap",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "pauseBitMap", type: "uint16" }],
  },
  {
    type: "function",
    name: "swapRate",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "rate", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapFee",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "fees", type: "uint256" }],
  },
  {
    type: "function",
    name: "unwindSwapFee",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "fees", type: "uint256" }],
  },
  {
    type: "function",
    name: "shares",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "principalToken", type: "address" },
      { name: "swapToken", type: "address" },
    ],
  },
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      {
        name: "parameters",
        type: "tuple",
        components: [
          { name: "collateralAsset", type: "address" },
          { name: "referenceAsset", type: "address" },
          { name: "expiryTimestamp", type: "uint256" },
          { name: "rateMin", type: "uint256" },
          { name: "rateMax", type: "uint256" },
          { name: "rateChangePerDayMax", type: "uint256" },
          { name: "rateChangeCapacityMax", type: "uint256" },
          { name: "rateOracle", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "previewSwap",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "collateralAssetsOut", type: "uint256" },
    ],
    outputs: [
      { name: "cstSharesIn", type: "uint256" },
      { name: "referenceAssetsIn", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewUnwindSwap",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "collateralAssetsIn", type: "uint256" },
    ],
    outputs: [
      { name: "cstSharesOut", type: "uint256" },
      { name: "referenceAssetsOut", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewExercise",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "cstSharesIn", type: "uint256" },
    ],
    outputs: [
      { name: "collateralAssetsOut", type: "uint256" },
      { name: "referenceAssetsIn", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewExerciseOther",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "referenceAssetsIn", type: "uint256" },
    ],
    outputs: [
      { name: "collateralAssetsOut", type: "uint256" },
      { name: "cstSharesIn", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewUnwindExercise",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "cstSharesOut", type: "uint256" },
    ],
    outputs: [
      { name: "collateralAssetsIn", type: "uint256" },
      { name: "referenceAssetsOut", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewUnwindExerciseOther",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "referenceAssetsOut", type: "uint256" },
    ],
    outputs: [
      { name: "collateralAssetsIn", type: "uint256" },
      { name: "cstSharesOut", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
] as const;

/** The 10-field `market()` view (phoenix v1.4.0-rc.1, the cork/v0.4 generation): the
 *  same eight words plus the two fee percentages that are now PART of the Market struct and its
 *  id. Kept as its own ABI beside the 8-field entry on `poolManagerAbi` on purpose — viem decodes
 *  a 10-word return through the 8-field ABI SILENTLY (the trailing words are dropped, no error),
 *  so the ABI must be chosen by the manager's declared wire, never by trying one and falling
 *  back. `marketAbiFor(wire)` is the one chooser. */
export const poolManagerMarket10Abi = [
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      {
        name: "parameters",
        type: "tuple",
        components: [
          { name: "collateralAsset", type: "address" },
          { name: "referenceAsset", type: "address" },
          { name: "expiryTimestamp", type: "uint256" },
          { name: "rateMin", type: "uint256" },
          { name: "rateMax", type: "uint256" },
          { name: "rateChangePerDayMax", type: "uint256" },
          { name: "rateChangeCapacityMax", type: "uint256" },
          { name: "rateOracle", type: "address" },
          { name: "swapFeePercentage", type: "uint256" },
          { name: "unwindSwapFeePercentage", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** The `market()` ABI for a pool manager's declared wire — the ONLY place the 8-field/10-field
 *  choice is made for a read. */
export function marketAbiFor(wire: "8-field" | "10-field"): typeof poolManagerAbi | typeof poolManagerMarket10Abi {
  return wire === "10-field" ? poolManagerMarket10Abi : poolManagerAbi;
}

export const constraintAdapterAbi = [
  {
    type: "function",
    name: "constraints",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "lastAdjustedRate", type: "uint256" },
      { name: "lastAdjustmentTimestamp", type: "uint256" },
      { name: "remainingCredits", type: "uint256" },
    ],
  },
] as const;

export const rateOracleAbi = [
  { type: "function", name: "rate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const whitelistManagerAbi = [
  {
    type: "function",
    name: "isWhitelisted",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  // Per-scope views (IWhitelistManager) — the [K7] verification legs for the event-derived
  // whitelisted-addresses enumeration (the membership mappings themselves are not enumerable).
  {
    type: "function",
    name: "isGlobalWhitelisted",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isMarketWhitelisted",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isMarketWhitelistEnabled",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const poolShareAbi = [
  { type: "function", name: "issuedAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Uniswap Permit2 AllowanceTransfer view — the INTERNAL (user, token, spender) allowance the
 *  permit2 funding leg actually consumes (distinct from the ERC-20 approval TO Permit2). */
export const permit2AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;
