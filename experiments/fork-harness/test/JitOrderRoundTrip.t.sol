// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";

// First live end-to-end round-trip of a tool-prepared JIT maker order (Arbitrum One).
// The order + extension + signature are produced by `ch prepare orders` (JIT block) and
// signed with a throwaway maker key; this test loads that artifact verbatim from JSON and
// fires the taker fill through the real 1inch LOP v4, proving prepare -> sign -> fill ->
// market-creation on a fork. Run: forge test --fork-url <arb> -vvvv --match-contract Jit
//
// The artifact path is passed via env JIT_ARTIFACT (a JSON object with the order fields,
// extension, signature). ffi stays off; we read the file with vm.readFile + vm.parseJson.

interface ILOP {
    // 1inch v6 declares Order with `type Address is uint256` and `MakerTraits is uint256`.
    // Custom value types resolve to uint256 for selector computation, so the canonical
    // fillOrderArgs selector is 0xf497df75 (uint256 fields), NOT 0x5d9dbf53 (address fields).
    // The ABI encoding is identical either way; only the 4-byte selector differs — declaring
    // `address` here silently produces the wrong selector and the router reverts at dispatch.
    struct Order {
        uint256 salt;
        uint256 maker;
        uint256 receiver;
        uint256 makerAsset;
        uint256 takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 makerTraits;
    }

    function fillOrderArgs(
        Order calldata order,
        bytes32 r,
        bytes32 vs,
        uint256 amount,
        uint256 takerTraits,
        bytes calldata args
    ) external payable returns (uint256, uint256, bytes32);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IPM {
    function shares(bytes32 poolId) external view returns (address principalToken, address swapToken);
}

contract JitOrderRoundTripTest is Test {
    address constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65;
    address constant PM = 0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2;
    address constant JIT_ADAPTER = 0xea15BF1E5565181Ed8678CcFf39D797272858505;
    address constant SUSDE = 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2;
    // A holder of sUSDe on Arbitrum (from the venue fills feed).
    address constant WHALE = 0xd2F5F275A03341f4c50D3a3B4AB2C60e420b18d0;

    // 1inch takerTraits flags.
    uint256 constant MAKER_AMOUNT_FLAG = 1 << 255;
    uint256 constant ARGS_EXT_LEN_OFFSET = 224;

    function _u(string memory j, string memory k) internal pure returns (uint256) {
        return vm.parseJsonUint(j, k);
    }

    function test_jit_order_fill_creates_market() public {
        string memory j = vm.readFile(vm.envString("JIT_ARTIFACT"));

        ILOP.Order memory order = ILOP.Order({
            salt: _u(j, ".salt"),
            maker: uint256(uint160(vm.parseJsonAddress(j, ".maker"))),
            receiver: uint256(uint160(vm.parseJsonAddress(j, ".receiver"))),
            makerAsset: uint256(uint160(vm.parseJsonAddress(j, ".makerAsset"))),
            takerAsset: uint256(uint160(vm.parseJsonAddress(j, ".takerAsset"))),
            makingAmount: _u(j, ".makingAmount"),
            takingAmount: _u(j, ".takingAmount"),
            makerTraits: _u(j, ".makerTraits")
        });
        bytes memory extension = vm.parseJsonBytes(j, ".extension");
        bytes memory sig = vm.parseJsonBytes(j, ".signature");
        bytes32 toolHash = vm.parseJsonBytes32(j, ".orderHash");
        bytes32 derivedPoolId = vm.parseJsonBytes32(j, ".derivedPoolId");

        // 1) The Aggregation Router V6 does not expose hashOrder()/DOMAIN_SEPARATOR()
        // as external getters (those live on the standalone LimitOrderProtocol); the
        // tool computes orderHash off-chain against the router's eip712Domain. Verify the
        // maker signature recovers against the tool's hash — the router recomputes the
        // same digest internally during the fill, so a passing fill also confirms parity.
        require(sig.length == 65, "sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        bytes32 vs = bytes32((uint256(v - 27) << 255) | uint256(s));

        address rec = ecrecover(toolHash, v, r, s);
        console2.log("ecrecover:", rec);
        console2.log("maker:", address(uint160(order.maker)));
        assertEq(rec, address(uint160(order.maker)), "signature does not recover to maker against tool orderHash");

        // 3) fund the taker AND the maker from a real sUSDe holder (deal() is unreliable on
        // sUSDe's vault storage). The taker pays the order's takingAmount; the maker's collateral
        // funds the JIT mint (the adapter pulls sUSDe from the maker during preInteraction), so
        // the maker must also approve the adapter. Taker approves the LOP to pull the takerAsset.
        address maker = address(uint160(order.maker));
        address taker = makeAddr("taker");
        vm.startPrank(WHALE);
        IERC20(SUSDE).transfer(taker, 1e17);
        IERC20(SUSDE).transfer(maker, 1e17);
        vm.stopPrank();
        vm.prank(taker);
        IERC20(SUSDE).approve(LOP, type(uint256).max);
        vm.startPrank(maker);
        IERC20(SUSDE).approve(JIT_ADAPTER, type(uint256).max);
        IERC20(SUSDE).approve(PM, type(uint256).max);
        vm.stopPrank();

        // sanity: cST does not exist yet (JIT).
        (, address cstBefore) = IPM(PM).shares(derivedPoolId);
        console2.log("cST before fill:", cstBefore);

        // 4) taker fill. amount is in maker asset (cST) via MAKER_AMOUNT_FLAG.
        uint256 takerTraits = MAKER_AMOUNT_FLAG | (extension.length << ARGS_EXT_LEN_OFFSET);
        bytes memory args = extension;

        vm.prank(taker);
        (uint256 made, uint256 took,) =
            ILOP(LOP).fillOrderArgs(order, r, vs, order.makingAmount, takerTraits, args);
        console2.log("filled making:", made, "taking:", took);

        // 5) the market now exists: cST address is nonzero and has code.
        (, address cstAfter) = IPM(PM).shares(derivedPoolId);
        console2.log("cST after fill:", cstAfter);
        assertTrue(cstAfter != address(0), "cST not created");
        assertEq(IERC20(cstAfter).balanceOf(taker), made, "taker did not receive cST");
    }
}
