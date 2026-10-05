// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {SessionAwareFeed} from "../../src/SessionAwareFeed.sol";
import {MarketParams, IPriceSource, IAggregatorV3} from "../../src/interfaces/External.sol";

/// @notice Two identical SPYB/USD1 LLTV-85% markets, one priced by Lista's StockOracle and one by the
///         SessionAwareFeed. A −5% thin-book print on Saturday liquidates the first and not the second;
///         a move that is still there in Monday's regular session liquidates both.
contract SessionAwareFeedForkTest is ForkBase {
    using stdJson for string;
    uint256 friClose; // next Friday close followed by an ordinary weekend (always in the future)
    SessionAwareFeed feed;
    MarketParams listaMp;
    MarketParams feedMp;
    address borrower = address(0xB0);
    uint256 friPrice;

    function setUp() public override {
        super.setUp();
        feed = new SessionAwareFeed(address(this), sOracle, IPriceSource(resilient));
        feed.mapAsset(spyb, "SPY");
        listaMp = _mp("SPYB_USD1");
        feedMp = MarketParams(usd1, spyb, address(feed), irm, listaMp.lltv);

        friPrice = IPriceSource(resilient).peek(spyb);
        uint256 mult = IEIP8056Like(spyb).uiMultiplier();
        address cl = cfg.readAddress(".tickers[1].chainlink");
        friClose = _nextWeekendClose();
        vm.warp(friClose + 60);
        vm.mockCall(cl, abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(1), int256(friPrice * 1e18 / mult), friClose - 30, friClose - 30, uint80(1)));
        _setPrice(spyb, friPrice);
        _setPrice(usd1, 1e8);

        vm.prank(moolah.getRoleMember(keccak256("OPERATOR"), 0));
        moolah.createMarket(feedMp);
        _fund(usd1, address(this), 200_000e18);
        IERC20(usd1).approve(address(moolah), type(uint256).max);
        moolah.supply(feedMp, 100_000e18, 0, address(this), "");

        _openAtHf(listaMp, 1.043e18);
        _openAtHf(feedMp, 1.043e18);
    }

    function _openAtHf(MarketParams memory mp, uint256 hf) internal {
        uint256 coll = 10e18;
        _fund(spyb, borrower, coll);
        vm.startPrank(borrower);
        IERC20(spyb).approve(address(moolah), coll);
        moolah.supplyCollateral(mp, coll, borrower, "");
        uint256 value = coll * friPrice / 1e8; // USD1 has 18 decimals, price 8 decimals
        uint256 debt = value * mp.lltv / hf;
        moolah.borrow(mp, debt, 0, borrower, borrower);
        vm.stopPrank();
    }

    function _healthy(MarketParams memory mp) internal view returns (bool) {
        return moolah.isHealthy(mp, keccak256(abi.encode(mp)), borrower);
    }

    function test_saturdayWick_liquidatesListaMarketOnly() public {
        vm.warp(friClose + 12 hours);
        _setPrice(spyb, friPrice * 95 / 100);
        assertFalse(_healthy(listaMp), "status quo liquidates on a thin-book -5%");
        assertTrue(_healthy(feedMp), "session-aware feed holds the band");
    }

    function test_persistentMove_liquidatesBothAtTheOpen() public {
        vm.warp(cal.nextOpen(friClose) + 90 minutes);
        _setPrice(spyb, friPrice * 95 / 100);
        address cl = cfg.readAddress(".tickers[1].chainlink");
        uint256 mult = IEIP8056Like(spyb).uiMultiplier();
        vm.mockCall(cl, abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(2), int256(friPrice * 95 / 100 * 1e18 / mult), block.timestamp - 60, block.timestamp - 60, uint80(2)));
        assertFalse(_healthy(listaMp));
        assertFalse(_healthy(feedMp));
    }
}

interface IEIP8056Like {
    function uiMultiplier() external view returns (uint256);
}
