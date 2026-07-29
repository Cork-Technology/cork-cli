// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {CorkLopFillForSelfBase} from "./base/CorkLopFillForSelfBase.sol";
import {CorkPoolForSelfBase} from "./base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "./base/ForSelfCommon.sol";

/// @title CorkForSelfAdapter
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Combined deployment: the full pool-manager ForSelf surface (Fix 1) and the
///         1inch LOP fill ForSelf surface (Fix 2) behind ONE address — one contract for
///         the integrator to audit, one address to whitelist, one spender for the Safe's
///         allowances. Both underlying protocols are pinned as immutables at deployment.
///         EXAMPLE CODE — the integrator must audit, vet, and deploy it themselves.
contract CorkForSelfAdapter is CorkPoolForSelfBase, CorkLopFillForSelfBase {
    constructor(address cork, address lop) ForSelfCommon(cork) CorkLopFillForSelfBase(lop) {}
}
