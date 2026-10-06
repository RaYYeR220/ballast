// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceSource, IAggregatorV3, IOndoSharesOracle} from "../../src/interfaces/External.sol";

contract MockPriceSource is IPriceSource {
    mapping(address => uint256) public price;
    mapping(address => bool) public broken;

    function set(address asset, uint256 p) external {
        price[asset] = p;
        broken[asset] = false;
    }

    function breakAsset(address asset) external {
        broken[asset] = true;
    }

    function peek(address asset) external view returns (uint256) {
        require(!broken[asset], "stale");
        return price[asset];
    }
}

contract MockAggregator is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockBStock {
    uint256 public uiMultiplier = 1e18;

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}

contract MockBacked {
    uint256 public multiplier = 1e18;

    function setMultiplier(uint256 m) external {
        multiplier = m;
    }
}

contract MockOndoShares is IOndoSharesOracle {
    mapping(address => uint128) public sValue;

    function set(address token, uint128 v) external {
        sValue[token] = v;
    }

    function getSValue(address token) external view returns (uint128, bool) {
        return (sValue[token], false);
    }
}
