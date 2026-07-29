// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {CorkLopFillForSelfBase} from "./base/CorkLopFillForSelfBase.sol";
import {ForSelfCommon} from "./base/ForSelfCommon.sol";

/// @title CorkLopFillForSelfAdapter
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Standalone deployment of the 1inch LOP fill ForSelf surface (Fix 2). The pool
///         manager is required here too: it is the trusted source for which token pair
///         belongs to which Cork market, which is what binds a fill to a real market.
///         EXAMPLE CODE — the integrator must audit, vet, and deploy it themselves.
contract CorkLopFillForSelfAdapter is CorkLopFillForSelfBase {
    constructor(address cork, address lop) ForSelfCommon(cork) CorkLopFillForSelfBase(lop) {}
}
