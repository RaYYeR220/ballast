// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {MarketParams} from "../../src/interfaces/External.sol";

contract HarnessForkTest is ForkBase {
    function test_configMatchesChain() public view {
        MarketParams memory mp = _mp("NVDAB_USD1");
        (address loan,,,,) = moolah.idToMarketParams(keccak256(abi.encode(mp)));
        assertEq(loan, usd1);
        assertEq(sOracle.symbolCount(), 12);
        (uint256 ps, bool ok) = sOracle.perSharePrice("NVDA");
        assertTrue(ok);
        assertGt(ps, 50e8);
    }
}
