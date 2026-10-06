// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice Lista Lending (Moolah) - Morpho Blue compatible core.
interface IMoolah {
    function supplyCollateral(MarketParams memory mp, uint256 assets, address onBehalf, bytes calldata data) external;
    function withdrawCollateral(MarketParams memory mp, uint256 assets, address onBehalf, address receiver) external;
    function borrow(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function repay(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)
        external
        returns (uint256, uint256);
    function supply(MarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)
        external
        returns (uint256, uint256);
    function liquidate(MarketParams memory mp, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes calldata data)
        external
        returns (uint256, uint256);
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function accrueInterest(MarketParams memory mp) external;
    function createMarket(MarketParams memory mp) external;
    function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 id)
        external
        view
        returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee);
    function idToMarketParams(bytes32 id) external view returns (address, address, address, address, uint256);
    function isHealthy(MarketParams memory mp, bytes32 id, address borrower) external view returns (bool);
    function getPrice(MarketParams memory mp) external view returns (uint256);
    function minLoan(MarketParams memory mp) external view returns (uint256);
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

interface IMoolahFlashLoanCallback {
    function onMoolahFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @notice Lista-style price source: USD price of `asset` with 8 decimals (raw token units for bStocks).
interface IPriceSource {
    function peek(address asset) external view returns (uint256);
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice EIP-8056 scaled UI amount (bStocks).
interface IEIP8056 {
    function uiMultiplier() external view returns (uint256);
}

/// @notice xStocks (Backed) rebasing multiplier.
interface IBackedToken {
    function multiplier() external view returns (uint256);
}

/// @notice Ondo Global Markets SyntheticSharesOracle.
interface IOndoSharesOracle {
    function getSValue(address token) external view returns (uint128 sValue, bool paused);
}

/// @notice PancakeSwap v3 SwapRouter (deadline inside the params struct).
interface IPcsV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IVToken {
    function mint(uint256 amount) external returns (uint256);
    function borrow(uint256 amount) external returns (uint256);
    function repayBorrow(uint256 amount) external returns (uint256);
    function repayBorrowBehalf(address borrower, uint256 amount) external returns (uint256);
    function redeemUnderlying(uint256 amount) external returns (uint256);
    function borrowBalanceCurrent(address account) external returns (uint256);
    function borrowBalanceStored(address account) external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function underlying() external view returns (address);
}

interface IComptroller {
    function enterMarkets(address[] calldata vTokens) external returns (uint256[] memory);
    function getAccountLiquidity(address account) external view returns (uint256 err, uint256 liquidity, uint256 shortfall);
    /// @dev Venus diamond returns more fields after these four; extra return data is ignored.
    function markets(address vToken) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa);
}

interface IVenusOracle {
    function getUnderlyingPrice(address vToken) external view returns (uint256);
}

/// @notice ERC-8004 identity registry (v2.0.0 on BSC).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// @notice ERC-8004 reputation registry (v2.0.0 on BSC).
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
