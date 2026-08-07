// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {CorkPoolForSelfBase} from "./base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "./base/ForSelfCommon.sol";

/// @title CorkPoolForSelfAdapter
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Standalone deployment of the pool-manager ForSelf surface (Fix 1).
///         EXAMPLE CODE — the integrator must audit, vet, and deploy it themselves.
contract CorkPoolForSelfAdapter is CorkPoolForSelfBase {
    constructor(address cork, address whitelistManager) ForSelfCommon(cork, whitelistManager) {}
}
