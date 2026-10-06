// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SessionCalendar} from "../../src/SessionCalendar.sol";
import {SessionOracle} from "../../src/SessionOracle.sol";
import {MarketParams, IMoolah, IPriceSource, IOndoSharesOracle, IAggregatorV3} from "../../src/interfaces/External.sol";

abstract contract ForkBase is Test {
    using stdJson for string;

    string internal cfg;
    IMoolah internal moolah;
    address internal stockOracle;
    address internal resilient;
    address internal irm;
    address internal usd1;
    address internal usdt;
    address internal nvdab;
    address internal spyb;
    address internal tslab;
    address internal whale;
    address internal router;
    address internal kernel;
    address internal identity;
    address internal reputation;
    SessionCalendar internal cal;
    SessionOracle internal sOracle;

    function setUp() public virtual {
        string memory rpc = vm.envOr("BSC_RPC_URL", string("https://bsc-rpc.publicnode.com"));
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/bsc-mainnet.json"));
        moolah = IMoolah(cfg.readAddress(".lista.moolah"));
        stockOracle = cfg.readAddress(".lista.stockOracle");
        resilient = cfg.readAddress(".lista.resilientOracle");
        irm = cfg.readAddress(".lista.irm");
        usd1 = cfg.readAddress(".tokens.USD1");
        usdt = cfg.readAddress(".tokens.USDT");
        nvdab = cfg.readAddress(".lista.markets.NVDAB_USD1.collateralToken");
        spyb = cfg.readAddress(".lista.markets.SPYB_USD1.collateralToken");
        tslab = cfg.readAddress(".tickers[3].bStock");
        whale = cfg.readAddress(".forkWhales.binanceHot");
        router = cfg.readAddress(".pancake.v3SwapRouter");
        kernel = cfg.readAddress(".erc8183.kernel");
        identity = cfg.readAddress(".erc8004.identity");
        reputation = cfg.readAddress(".erc8004.reputation");

        cal = new SessionCalendar();
        sOracle = new SessionOracle(
            address(this), cal, IPriceSource(resilient), IOndoSharesOracle(cfg.readAddress(".ondo.sharesOracle")),
            SessionOracle.Params(5400, 10800, 60, 93600, 21600, 100, 300)
        );
        _listAll();
    }

    function _mp(string memory key) internal view returns (MarketParams memory mp) {
        string memory base = string.concat(".lista.markets.", key);
        mp = MarketParams({
            loanToken: usd1,
            collateralToken: cfg.readAddress(string.concat(base, ".collateralToken")),
            oracle: stockOracle,
            irm: irm,
            lltv: vm.parseUint(cfg.readString(string.concat(base, ".lltv")))
        });
        assertEq(keccak256(abi.encode(mp)), cfg.readBytes32(string.concat(base, ".id")), "market id mismatch");
    }

    function _tickerCount() internal view returns (uint256 n) {
        while (cfg.keyExists(string.concat(".tickers[", vm.toString(n), "]"))) ++n;
    }

    function _listAll() internal {
        uint256 n = _tickerCount();
        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".tickers[", vm.toString(i), "]");
            SessionOracle.Ticker memory t = SessionOracle.Ticker({
                bStock: cfg.readAddress(string.concat(p, ".bStock")),
                ondo: cfg.readAddress(string.concat(p, ".ondo")),
                xStock: cfg.readAddress(string.concat(p, ".xStock")),
                chainlink: cfg.readAddress(string.concat(p, ".chainlink")),
                gapOvernightBps: uint16(cfg.readUint(string.concat(p, ".gapBps.overnight"))),
                gapWeekendBps: uint16(cfg.readUint(string.concat(p, ".gapBps.weekend"))),
                gapHolidayBps: uint16(cfg.readUint(string.concat(p, ".gapBps.holiday"))),
                gapEarningsBps: uint16(cfg.readUint(string.concat(p, ".gapBps.earnings"))),
                listed: true
            });
            sOracle.listTicker(bytes32(bytes(cfg.readString(string.concat(p, ".symbol")))), t);
        }
    }

    function _fund(address token, address to, uint256 amt) internal {
        vm.prank(whale);
        IERC20(token).transfer(to, amt);
    }

    /// @dev Pin Lista's price reads for `tokens` at their current values so the clock can move.
    function _freezePrices(address[] memory tokens) internal {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 p = IPriceSource(stockOracle).peek(tokens[i]);
            vm.mockCall(stockOracle, abi.encodeCall(IPriceSource.peek, (tokens[i])), abi.encode(p));
            vm.mockCall(resilient, abi.encodeCall(IPriceSource.peek, (tokens[i])), abi.encode(p));
        }
    }

    function _setPrice(address token, uint256 p) internal {
        vm.mockCall(stockOracle, abi.encodeCall(IPriceSource.peek, (token)), abi.encode(p));
        vm.mockCall(resilient, abi.encodeCall(IPriceSource.peek, (token)), abi.encode(p));
    }

    function _mockCanAddRisk(bytes32 sym, bool ok, SessionOracle.Reason r) internal {
        vm.mockCall(address(sOracle), abi.encodeCall(SessionOracle.canAddRisk, (sym)), abi.encode(ok, r));
    }

    // Time helpers. Fork tests must only ever warp FORWARD from the fork block: Moolah and Venus accrue
    // interest from `lastUpdate`, and a backwards warp underflows. Never hard-code calendar timestamps here.

    /// @dev Noon New York time on the next Saturday after the fork block.
    function _nextSaturdayNoon() internal view returns (uint256) {
        (uint256 day,) = cal.localDay(block.timestamp);
        uint256 d = day + 1;
        while (cal.weekday(d) != 6) ++d;
        return d * 1 days + 12 hours + cal.utcOffset(d * 1 days + 17 hours);
    }

    /// @dev A regular-session moment on a later trading day, >= 105 min after the open and > 3 h before the close.
    function _nextRestoreMoment() internal view returns (uint256) {
        (uint256 day,) = cal.localDay(block.timestamp);
        for (uint256 d = day + 1; d < day + 15; ++d) {
            if (!cal.isTradingDay(d)) continue;
            uint256 t = cal.regularOpenAt(d) + 5400 + 900;
            if (cal.regularCloseAt(d) >= t + 10800 + 60) return t;
        }
        revert("no restore moment");
    }

    /// @dev One hour before the first regular close that is at least two hours away.
    function _hourBeforeNextClose() internal view returns (uint256) {
        return cal.nextClose(block.timestamp + 2 hours) - 1 hours;
    }

    /// @dev The next Friday close that is followed by an ordinary (non-holiday) weekend.
    function _nextWeekendClose() internal view returns (uint256) {
        (uint256 day,) = cal.localDay(block.timestamp);
        for (uint256 d = day + 1; d < day + 30; ++d) {
            if (cal.weekday(d) == 5 && cal.isTradingDay(d) && cal.windowAfter(d) == SessionCalendar.WindowType.WEEKEND) {
                return cal.regularCloseAt(d);
            }
        }
        revert("no weekend close");
    }
}
