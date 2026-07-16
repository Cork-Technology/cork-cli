# 1inch Fusion: Dutch-auction price math & extension decoding (research)

Date: 2026-07-16. Researched for the cork CLI/MCP decoder: recognize a Fusion order inside a 1inch
LOP v4 order's `extension` blob and compute its current Dutch-auction price deterministically
off-chain.

Primary sources:

- `github.com/1inch/fusion-protocol` (formerly `limit-order-settlement`; npm
  `@1inch/limit-order-settlement`) — master = **v3.1.2**, pins
  `@1inch/limit-order-protocol-contract@4.3.2`. Tags: `1.0.0`, `2.0.x`, `2.1.0`, `3.0.0`, `3.1.0`,
  `3.1.1`.
- Local LOP v4 clone: `/Users/work/Projects/euler-research/limit-order-protocol` (master,
  2026-06-09).
- Local SDK clone: `/Users/work/Projects/euler-research/limit-order-sdk` (`@1inch/limit-order-sdk`
  5.3.1, 2026-06-29).
- `github.com/1inch/fusion-sdk` (`@1inch/fusion-sdk`, latest **2.4.10**, 2026-06-29).

---

## 1. Repo map & deployed addresses

Fusion is **not** a separate trading protocol. It is a set of contracts that plug into LOP v4
(`0x111111125421cA6dc452d289314280a0f8842A65`) through three LOP extension hooks:

| Hook | LOP mechanism | What Fusion does with it |
|---|---|---|
| `IAmountGetter.getMakingAmount` / `getTakingAmount` | `extension.makingAmountData` / `takingAmountData` (first 20 bytes = getter address, rest = `extraData`) | Dutch-auction price: applies time-decaying `rateBump` + resolver/integrator fee markup |
| `IPostInteraction.postInteraction` | `extension.postInteractionData` | Enforces resolver whitelist / access token, splits fees, takes surplus fee, forwards to optional extra post-interaction |
| (v3 `Settlement` only) same post-interaction | — | Additionally caps `tx.gasprice - basefee` (priority-fee rule) |

`contracts/` on master (v3.1.x):

- **`SimpleSettlement.sol`** — the whole Fusion price logic (`_getRateBump`, `_getAuctionBump`,
  auction-wrapped `_getMakingAmount`/`_getTakingAmount`, time-gated whitelist, surplus fee).
  Inherits **`FeeTaker`** from the LOP repo (`contracts/extensions/FeeTaker.sol`), which inherits
  **`AmountGetterWithFee`** → **`AmountGetterBase`** (both LOP repo). So the inheritance chain is:
  `Settlement → SimpleSettlement → FeeTaker → AmountGetterWithFee → AmountGetterBase (IAmountGetter)`.
- **`Settlement.sol`** — `SimpleSettlement` + mainnet priority-fee validation in
  `_postInteraction` (see §7).
- `WhitelistRegistry.sol`, `CrosschainWhitelistRegistry.sol`, `PowerPod.sol`, `KycNFT.sol` —
  resolver-registration infra (staking-share gated registry). Not needed for price computation:
  the *effective* whitelist is snapshotted into each order's extension bytes.
- v2-era contracts (`extensions/BaseExtension.sol`, `ResolverValidationExtension.sol`,
  `IntegratorFeeExtension.sol`, `FeeBank/FeeBankCharger.sol`) exist only at tag `2.1.0` and earlier.

Deployed Settlement addresses (from `deployments/` in the repo):

| Version | Mainnet | Arbitrum | Notes |
|---|---|---|---|
| v1 (`1.0.0`, LOP **v3**) | `0xA88800CD213dA5Ae406ce248380802BD53b47647` | same | Auction params packed into order **salt** (`OrderSaltParser`), fills via `settleOrders()`. Legacy; not LOP v4. |
| v2 (`2.x`, first LOP v4) | `0xfb2809A5314473E1165f6B58018E20ed8F07B840` | same | "SettlementExtension". Confirmed by `1inch/fusion-resolver-example` `test/helpers/constants.ts` (`SETTLEMENT_EXTENSION = '0xfb2809...'`) and fusion-sdk v2-era test fixtures (API order `version: '2.2'`). |
| v3.0 (`3.0.0`) | `0xAbD4e5fB590Aa132749bbF2A04eA57EFbaAC399E` | — | `deployments/mainnet/Settlement.json@3.0.0` |
| **v3.1 (current master)** | **`0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5`** | **same address** (CREATE3; mainnet = `Settlement`, arbitrum = `SimpleSettlement`) | `deployments/{mainnet,arbitrum}/*.json@master`; mainnet deploy block 22 582 356 (~May 2025). Constructor args: `(LOP=0x1111...2a65, accessToken=0xAccE550000863572B867E661647CD7D97b72C507, WETH, owner)`. |

The production settlement address for a given order is whatever address is embedded in its
extension bytes — the fusion-sdk itself takes it from the quoter API response, so **do not
hardcode**: decode it from `makingAmountData[0:20]` and (optionally) check against the known set
above to classify the version.

---

## 2. LOP v4 `extension` byte-level encoding (what our decoder must implement)

From `contracts/libraries/ExtensionLib.sol` + `OffsetsLib.sol` (local LOP clone).

```
extension = offsets_word (32 bytes) ‖ concat(fields...) ‖ customData
```

- The first 32 bytes are eight **little-endian-indexed uint32 end-offsets** into the concatenated
  blob that follows. Field index `i` occupies bits `[32*i, 32*i+32)` of the word (index 0 = lowest
  bits), and stores the **end** offset of that field within `concat`. Field `i`'s slice is
  `concat[ end[i-1] : end[i] ]` (with `end[-1] = 0`).
- Field order (`ExtensionLib.DynamicField`):

```solidity
enum DynamicField {
    MakerAssetSuffix,    // 0
    TakerAssetSuffix,    // 1
    MakingAmountData,    // 2
    TakingAmountData,    // 3
    Predicate,           // 4
    MakerPermit,         // 5
    PreInteractionData,  // 6
    PostInteractionData, // 7
    CustomData           // (everything after end[7]; no offset of its own)
}
```

- Extraction (`OffsetsLib.get`):

```solidity
let bitShift := shl(5, index)                                   // index * 32
let begin := and(0xffffffff, shr(bitShift, shl(32, offsets)))   // end[i-1] (0 for i=0)
let end   := and(0xffffffff, shr(bitShift, offsets))            // end[i]
```

- `customData` = `extension[0x20 + (offsets >> 224):]` (tail after the 8th field).
- If `extension.length < 0x20`, every field is empty.

TS reference implementation: `Extension.decode()` in
`limit-order-sdk/src/limit-order/extensions/extension.ts` (local clone) — iterates the 8 fields,
`offset & UINT_32_MAX`, shifts by 32 per field, remainder = customData. Reuse or copy this.

### Salt ↔ extension binding (LOP v4 validation rule — verified)

`contracts/OrderLib.sol` (local LOP clone), `isValidExtension`:

```solidity
if (order.makerTraits.hasExtension()) {            // makerTraits bit 249
    if (extension.length == 0) return (false, MissingOrderExtension.selector);
    // Lowest 160 bits of the order salt must be equal to the lowest 160 bits of the extension hash
    if (uint256(keccak256(extension)) & type(uint160).max != order.salt & type(uint160).max)
        return (false, InvalidExtensionHash.selector);
} else {
    if (extension.length > 0) return (false, UnexpectedOrderExtension.selector);
}
```

So: `salt[159:0] == keccak256(extension)[159:0]`, exactly. The SDK builds salt as
`(baseSalt << 160n) | (extension.keccak256() & UINT_160_MAX)` (`LimitOrder.buildSalt`,
`limit-order-sdk/src/limit-order/limit-order.ts:134`); bits `[224,255]` of the upper 96 bits carry
an order-source tracking code. The extension itself is *not* part of the EIP-712 order struct —
only the salt commits to it; takers supply the extension bytes in `fillOrderArgs` calldata.

Relevant `MakerTraits` bits (`MakerTraitsLib.sol`): bit 255 `NO_PARTIAL_FILLS`, 254
`ALLOW_MULTIPLE_FILLS`, 252 `PRE_INTERACTION_CALL`, 251 `POST_INTERACTION_CALL`, 249
`HAS_EXTENSION`; `allowedSender` = lowest 80 bits; **expiration = `(makerTraits >> 80) & type(uint40).max`**
(0 = never). A Fusion order sets HAS_EXTENSION + POST_INTERACTION + ALLOW_MULTIPLE_FILLS/partial
fills as configured, and expiration ≈ auctionStart + duration + buffer.

### Recognizing a Fusion (v3) order

1. `makerTraits` bit 249 set and salt check passes.
2. `makingAmountData[0:20] == takingAmountData[0:20] == postInteractionData[0:20]` = the Settlement
   address; fusion-sdk asserts additionally `takingAmountData == makingAmountData` byte-for-byte
   (`FusionExtension.fromExtension`, fusion-sdk `src/fusion-order/fusion-extension.ts`).
3. Classify version by that address (§1 table): `0xfb2809...` ⇒ v2 layout (no points-count byte,
   different post-interaction), `0xAbD4...`/`0x2Ad5...` ⇒ v3 layout below.

---

## 3. The auction price formula (v3.x, current — EXACT)

All quotes from `fusion-protocol/contracts/SimpleSettlement.sol` @ master (pragma 0.8.23).

Constants:

```solidity
uint256 private constant _BASE_POINTS = 10_000_000;   // rate-bump denominator, 100% = 1e7
uint256 private constant _GAS_PRICE_BASE = 1_000_000; // gasPriceEstimate unit: 1000 = 1 Gwei
// From AmountGetterWithFee (LOP repo):
uint256 internal constant _BASE_1E5 = 1e5;             // fee denominator
uint256 internal constant _BASE_1E2 = 100;             // share/discount denominator
```

### 3.1 AuctionDetails blob (tight-packed, lives at the head of the amount-getter `extraData`)

```solidity
 * struct AuctionDetails {
 *     bytes3 gasBumpEstimate;
 *     bytes4 gasPriceEstimate;
 *     bytes4 auctionStartTime;
 *     bytes3 auctionDuration;
 *     bytes3 initialRateBump;
 *     (bytes3,bytes2)[N] pointsAndTimeDeltas;   // v3: prefixed by uint8 N (see code)
 * }
```

Byte offsets (v3):

| offset | size | field | unit |
|---|---|---|---|
| 0 | 3 | `gasBumpEstimate` | rate-bump units (1e7 = 100%) |
| 3 | 4 | `gasPriceEstimate` | 1000 = 1 Gwei (i.e. baseFee / 1e6) |
| 7 | 4 | `auctionStartTime` | unix seconds |
| 11 | 3 | `auctionDuration` | seconds |
| 14 | 3 | `initialRateBump` | 1e7 = 100% |
| 17 | 1 | `N` = points count (**v3 only**; absent in v2) |
| 18 | 5·N | per point: `uint24 rateBump ‖ uint16 timeDelta(sec)` | cumulative deltas |

### 3.2 Rate bump at time `t` (piecewise linear, integer division)

```solidity
function _getRateBump(bytes calldata auctionDetails) private view returns (uint256, bytes calldata) {
    unchecked {
        uint256 gasBumpEstimate = uint24(bytes3(auctionDetails[0:3]));
        uint256 gasPriceEstimate = uint32(bytes4(auctionDetails[3:7]));
        uint256 gasBump = gasBumpEstimate == 0 || gasPriceEstimate == 0
            ? 0 : gasBumpEstimate * block.basefee / gasPriceEstimate / _GAS_PRICE_BASE;
        uint256 auctionStartTime = uint32(bytes4(auctionDetails[7:11]));
        uint256 auctionFinishTime = auctionStartTime + uint24(bytes3(auctionDetails[11:14]));
        uint256 initialRateBump = uint24(bytes3(auctionDetails[14:17]));
        (uint256 auctionBump, bytes calldata tail) =
            _getAuctionBump(auctionStartTime, auctionFinishTime, initialRateBump, auctionDetails[17:]);
        return (auctionBump > gasBump ? auctionBump - gasBump : 0, tail);
    }
}

function _getAuctionBump(uint256 auctionStartTime, uint256 auctionFinishTime,
    uint256 initialRateBump, bytes calldata pointsAndTimeDeltas
) private view returns (uint256, bytes calldata) {
    unchecked {
        uint256 currentPointTime = auctionStartTime;
        uint256 currentRateBump = initialRateBump;
        uint256 pointsCount = uint8(pointsAndTimeDeltas[0]);
        pointsAndTimeDeltas = pointsAndTimeDeltas[1:];
        bytes calldata tail = pointsAndTimeDeltas[5 * pointsCount:];

        if (block.timestamp <= auctionStartTime) {
            return (initialRateBump, tail);
        } else if (block.timestamp >= auctionFinishTime) {
            return (0, tail);
        }

        for (uint256 i = 0; i < pointsCount; i++) {
            uint256 nextRateBump = uint24(bytes3(pointsAndTimeDeltas[:3]));
            uint256 nextPointTime = currentPointTime + uint16(bytes2(pointsAndTimeDeltas[3:5]));
            if (block.timestamp <= nextPointTime) {
                return (((block.timestamp - currentPointTime) * nextRateBump
                       + (nextPointTime - block.timestamp) * currentRateBump)
                       / (nextPointTime - currentPointTime), tail);
            }
            currentRateBump = nextRateBump;
            currentPointTime = nextPointTime;
            pointsAndTimeDeltas = pointsAndTimeDeltas[5:];
        }
        return ((auctionFinishTime - block.timestamp) * currentRateBump
                / (auctionFinishTime - currentPointTime), tail);
    }
}
```

Semantics: the curve starts at `initialRateBump` at `auctionStartTime`, is linearly interpolated
between successive points `(rateBump_i, startTime + Σ delta_1..i)`, and the implicit last point is
`(0, auctionFinishTime)`. Before start ⇒ `initialRateBump`; after finish ⇒ `0`. Then
`rateBump = max(auctionBump - gasBump, 0)` where
`gasBump = gasBumpEstimate * basefee / gasPriceEstimate / 1e6` (0 if either estimate is 0).

### 3.3 From rate bump to amounts

`SimpleSettlement` wraps the fee getter, which wraps the linear base
(`AmountGetterBase`: `makingAmount * takingAmount' / takingAmount` with floor, and
`takingAmount * makingAmount' / makingAmount` with **ceil**):

```solidity
// SimpleSettlement
function _getMakingAmount(...) internal view override returns (uint256) {
    (uint256 rateBump, bytes calldata tail) = _getRateBump(extraData);
    return Math.mulDiv(
        super._getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, tail),
        _BASE_POINTS, _BASE_POINTS + rateBump);
}
function _getTakingAmount(...) internal view override returns (uint256) {
    (uint256 rateBump, bytes calldata tail) = _getRateBump(extraData);
    return Math.mulDiv(
        super._getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, tail),
        _BASE_POINTS + rateBump, _BASE_POINTS, Math.Rounding.Ceil);
}
```

```solidity
// AmountGetterWithFee (LOP repo) — super of the above
_getMakingAmount: super(...).mulDiv(_BASE_1E5, _BASE_1E5 + integratorFee + resolverFee)          // floor
_getTakingAmount: super(...).mulDiv(_BASE_1E5 + integratorFee + resolverFee, _BASE_1E5, Ceil)    // ceil
```

**Closed form** (per requested `makingAmount` m, order totals M = `order.makingAmount`,
T = `order.takingAmount`, fees f = `integratorFee + resolverFee` in 1e-5 units, rateBump b in 1e-7
units, all integer ops in the exact nesting order above):

```
takerPays(m, t)  = ceil( ceil( ceil(T·m / M) · (1e5 + f) / 1e5 ) · (1e7 + b) / 1e7 )
makerGives(t', t)= floor( floor( floor(M·t' / T) · 1e5 / (1e5 + f) ) · 1e7 / (1e7 + b) )
```

where `f` uses the whitelist-discounted resolver fee if the taker is whitelisted
(`resolverFee = resolverFee * whitelistDiscountNumerator / 1e2`, from `_parseFeeData`). Note the
"taking amount" returned by the getter **includes** the fees; the fee slice is split out later in
`postInteraction`, and the maker receives `takingAmount - integratorFeeAmount - protocolFeeAmount`.
The maker-facing "price" therefore decays from `(1+b0/1e7)·T/M` toward `T/M` over the auction.

### 3.4 Amount-getter `extraData` layout (v3, what follows the 20-byte getter address in `makingAmountData`)

Built by `FusionExtension.buildAmountGetterData(true)` (fusion-sdk) and parsed by
`SimpleSettlement._getMakingAmount` → `_getRateBump` → (tail) → `AmountGetterWithFee._parseFeeData`:

```
AuctionDetails (17 + 1 + 5N bytes, §3.1)
uint16 integratorFee        (1e5 base)
uint8  integratorShare      (1e2 base)
uint16 resolverFee          (1e5 base)
uint8  whitelistDiscountNumerator (1e2 base; contract stores 100 - discount)
uint8  whitelistSize
bytes10[whitelistSize]      last-10-bytes of each resolver address (no time deltas here)
```

(If a further 20-byte tail remained, `AmountGetterBase` would delegate to yet another external
`IAmountGetter` — Fusion orders leave it empty so the linear base formula applies.)

### 3.5 Post-interaction `extraData` layout (v3) — fill gating & fees

Built by `FusionExtension.buildInteractionData()`; parsed by `FeeTaker._postInteraction` +
`SimpleSettlement._getFeeAmounts` / `_isWhitelistedPostInteractionImpl`:

```
uint8   flags                      (bit0 = custom receiver present)
address integratorFeeRecipient     (20)
address protocolFeeRecipient       (20)
[address customReceiver]           (20, optional per flag)
uint16  integratorFee | uint8 integratorShare | uint16 resolverFee | uint8 whitelistDiscountNumerator
uint32  allowedTime (resolvingStartTime)
uint8   whitelistSize
(bytes10 addressHalf ‖ uint16 timeDelta)[whitelistSize]   // cumulative delays
uint256 estimatedTakingAmount      (surplus baseline)
uint8   protocolSurplusFee         (1e2 base)
[bytes  extra post-interaction: 20-byte target ‖ data]    (optional)
```

Whitelist gating (`SimpleSettlement._isWhitelistedPostInteractionImpl`): iterate entries; entry
`i` becomes eligible at `allowedTime + Σ delta_0..i-1`; matching is on the **lowest 10 bytes**
(`uint80`) of the taker address; if `block.timestamp < allowedTime` at the reached position ⇒
revert `AllowedTimeViolation`. A non-whitelisted taker can fill only after the last cumulative
`allowedTime` **and** only if it holds ≥1 unit of the access token
(`FeeTaker._getFeeAmounts`: `if (!isWhitelisted && _ACCESS_TOKEN.balanceOf(taker) == 0) revert OnlyWhitelistOrAccessToken()`);
mainnet access token: `0xAccE550000863572B867E661647CD7D97b72C507`.

Surplus fee (`SimpleSettlement._getFeeAmounts`): if the taker pays more than
`estimatedTakingAmount` scaled by fill fraction, `protocolSurplusFee`% of the excess is added to
the protocol fee — affects maker proceeds, **not** the taker-side price.

---

## 4. v2 (Settlement `0xfb2809...`) differences

From `contracts/extensions/BaseExtension.sol` @ tag `2.1.0` (identical `_getRateBump` math and
`AuctionDetails` header, same 1e7 base and gas-bump formula) except:

- **No points-count byte**: `_getAuctionBump` loops `while (pointsAndTimeDeltas.length > 0)` — the
  points run to the end of the getter `extraData`. Getter data = 20-byte address + 17-byte header +
  5-byte points only (no fee/whitelist section in the amount data).
- Amounts applied directly to order totals in one step:
  `getTakingAmount = mulDiv(T, m·(1e7+b), M·1e7, Ceil)`; no 1e5 fee markup inside the getter (v2
  charged resolver fees via `FeeBank` balances and `IntegratorFeeExtension` in post-interaction
  instead).
- Post-interaction data: `4 bytes resolvingStartTime ‖ (bytes10 addressHalf ‖ uint16 delta)[N] ‖ ... ‖ 1 byte flags`
  (whitelist size derived, tail flag byte; `ResolverValidationExtension` @2.1.0) — different enough
  that the settlement address must drive which parser you use.
- Sample real v2 extension (fusion-sdk test fixture): `0x000000830000005e0000005e0000005e0000005e0000002f00000000` +
  `00000000` offsets word, then `fb2809...840 ‖ 0c956a00 003e1b 662a5994 0000b4 0ecaaa 002b1d0054 0e41ea003c` …

v1 (`1.0.0`) is LOP **v3**: auction start/duration/initial bump packed in the order **salt**
(`OrderSaltParser`), settlement via `settleOrders()` + `fillOrderInteraction` callback. Out of
scope for an LOP-v4 decoder; recognize and reject.

---

## 5. TypeScript SDK state (mid-2026)

- **`@1inch/fusion-sdk` 2.4.10** (2026-06-29; actively maintained, rc cadence ~monthly). Exposes
  everything we need — we do **not** have to reimplement the math:
  - `AuctionCalculator` (`src/amount-calculator/auction-calculator/auction-calculator.ts`):
    `calcRateBump(time, blockBaseFee=0n)` (mirrors `_getRateBump` incl. gas bump),
    `calcAuctionTakingAmount` / `calcAuctionMakingAmount` (1e7 base, correct ceil/floor),
    `fromAuctionData(details)`, plus helpers `calcInitialRateBump(startAmount,endAmount)`,
    `calcGasBumpEstimate`, `baseFeeToGasPriceEstimate`.
  - `AuctionDetails.decode / decodeFrom / fromExtension(extension)` — exact byte layout of §3.1
    incl. the uint8 points count; `fromExtension` slices `makingAmountData` after the 20-byte
    address (`.slice(42)`).
  - `FusionExtension.decode(bytes)` / `.fromExtension(Extension)` — full v3 parse (auction, fees,
    whitelist, surplus, custom receiver) with cross-consistency asserts between getter data and
    post-interaction data.
  - `AmountCalculator` (`src/amount-calculator/amount-calculator.ts`) composes auction + fee math
    end-to-end; `FusionOrder.fromDataAndExtension()` reconstructs a whole order.
  - Deps: `@1inch/limit-order-sdk@5.3.1`, `@1inch/byte-utils`, `ethers@6.16`, `ws`. No zod —
    plain classes + `assert`; ESM+CJS builds. We'd wrap decode results in our own zod schemas.
  - Caveat: it only implements the **current** (v3/FeeTaker) layout; decoding a live v2-era order
    would need the old byte layout (§4) — older fusion-sdk 2.1.x implements it if ever needed.
- **`@1inch/limit-order-sdk` 5.3.1** (same release train): `Extension.decode/encode`,
  `LimitOrder.buildSalt/verifySalt` (salt↔extension rule), `MakerTraits`, `TakerTraits`,
  `FeeTakerExtension` + `FeeCalculator` (`src/limit-order/extensions/fee-taker/`), `mulDiv` with
  `Rounding`. Local clone available at `/Users/work/Projects/euler-research/limit-order-sdk`.
- `@1inch/fusion-sdk` pins the exact limit-order-sdk version; both are CC0/MIT-ish 1inch packages
  published from the public repos.

Recommendation: depend on `@1inch/fusion-sdk` for parse + price (`FusionExtension.fromExtension`,
`AuctionCalculator`), and keep a ~60-line fallback implementation of §3 (it is fully specified
above) so the CLI stays dependency-light/deterministic if the SDK churns.

---

## 6. Off-chain "current price" gotchas

1. **`block.timestamp` is the only time input.** Price is a pure function
   `(auctionDetails, feeData, taker, basefee, timestamp)`. For "price now", use wall-clock seconds;
   fills land within a block or two, so quote at `t` and `t+12` if you want a bound.
2. **Gas-price coupling**: if `gasBumpEstimate` and `gasPriceEstimate` are both non-zero, the
   effective bump depends on `block.basefee` (v3 *and* v2). Deterministic only given a basefee
   input; expose `--basefee` (default 0 ⇒ upper-bound price, matching
   `AuctionCalculator.calcRateBump(time, 0n)` which skips the gas bump entirely).
3. **Taker-dependent price**: resolver fee is discounted by `whitelistDiscountNumerator/100` for
   whitelisted takers, so whitelisted vs access-token takers pay different totals. Compute both.
4. **Partial fills don't change the unit price**: the getter math scales off `order.makingAmount` /
   `order.takingAmount` totals, never `remainingMakingAmount`. Only remaining size changes (query
   LOP `remainingInvalidatorForOrder` / `bitInvalidatorForOrder` if fill state is needed —
   the one thing that does require RPC).
5. **Rounding is asymmetric and nested** — replicate the exact nesting: linear base (floor/ceil),
   then fee markup (floor/ceil), then rate bump (floor/ceil). Naive single-expression math will be
   off by a few wei and fail conformance tests against `AuctionCalculator`.
6. **Fillability gates besides price**: makerTraits expiration (`(traits>>80)&0xffffffffff`),
   whitelist time cascade (§3.5) — before the first `allowedTime` *nobody* can fill; mainnet
   `Settlement` additionally reverts fills whose priority fee exceeds the DAO cap
   (baseFee<10.6 gwei ⇒ tip≤70% of baseFee; 10.6–104.1 gwei ⇒ ≤50%; >104.1 gwei ⇒ ≤65%).
7. **After `auctionFinishTime`** the bump is 0 (price floor = order's nominal `takingAmount` + fees)
   until makerTraits expiration; **before `auctionStartTime`** the bump is pinned at
   `initialRateBump`.
8. **Version dispatch**: key the parser off `makingAmountData[0:20]`. Unknown settlement address ⇒
   still decodable *if* it follows the v3 shape, but flag it as unverified.

## Source index

- `fusion-protocol/contracts/SimpleSettlement.sol` (master, v3.1.2): auction math, whitelist, surplus —
  https://github.com/1inch/fusion-protocol/blob/master/contracts/SimpleSettlement.sol
- `fusion-protocol/contracts/Settlement.sol` (master): priority-fee cap.
- `fusion-protocol/contracts/extensions/BaseExtension.sol` @ `2.1.0`: v2 auction math.
- `fusion-protocol/deployments/{mainnet,arbitrum}/*.json` @ master / `3.0.0` / `2.1.0`: addresses.
- Local LOP v4: `contracts/OrderLib.sol` (salt rule), `contracts/libraries/{ExtensionLib,OffsetsLib,MakerTraitsLib}.sol`,
  `contracts/extensions/{FeeTaker,AmountGetterWithFee,AmountGetterBase}.sol`
  (`/Users/work/Projects/euler-research/limit-order-protocol`).
- fusion-sdk (main): `src/amount-calculator/auction-calculator/auction-calculator.ts`,
  `src/fusion-order/{auction-details/auction-details.ts,fusion-extension.ts,whitelist/whitelist.ts,surplus-params.ts}`.
- Local limit-order-sdk 5.3.1: `src/limit-order/{limit-order.ts,extensions/extension.ts,extensions/fee-taker/}`.
- v2 settlement address confirmation: `1inch/fusion-resolver-example/test/helpers/constants.ts`.
