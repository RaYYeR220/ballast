// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {SessionOracle} from "../src/SessionOracle.sol";
import {SessionAwareFeed} from "../src/SessionAwareFeed.sol";
import {BallastFactory} from "../src/accounts/BallastFactory.sol";
import {CushionVault} from "../src/CushionVault.sol";
import {BallastGuardian} from "../src/BallastGuardian.sol";
import {IACP} from "../src/interfaces/IACP.sol";
import {
    IPriceSource, IOndoSharesOracle, IMoolah, IPcsV3SwapRouter, IComptroller, IVenusOracle, IIdentityRegistry, IReputationRegistry
} from "../src/interfaces/External.sol";

contract Deploy is Script {
    using stdJson for string;

    function run() external {
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/bsc-mainnet.json"));
        address publisher = vm.envAddress("PUBLISHER_ADDRESS");
        uint256 agentId = vm.envOr("PUBLISHER_AGENT_ID", uint256(0));
        vm.startBroadcast();
        address owner = msg.sender;

        SessionCalendar cal = new SessionCalendar();
        SessionOracle oracle = new SessionOracle(
            owner, cal, IPriceSource(cfg.readAddress(".lista.resilientOracle")),
            IOndoSharesOracle(cfg.readAddress(".ondo.sharesOracle")),
            SessionOracle.Params(5400, 10800, 60, 93600, 21600, 100, 300)
        );
        for (uint256 i; i < 12; ++i) {
            string memory p = string.concat(".tickers[", vm.toString(i), "]");
            oracle.listTicker(
                bytes32(bytes(cfg.readString(string.concat(p, ".symbol")))),
                SessionOracle.Ticker({
                    bStock: cfg.readAddress(string.concat(p, ".bStock")),
                    ondo: cfg.readAddress(string.concat(p, ".ondo")),
                    xStock: cfg.readAddress(string.concat(p, ".xStock")),
                    chainlink: cfg.readAddress(string.concat(p, ".chainlink")),
                    gapOvernightBps: uint16(cfg.readUint(string.concat(p, ".gapBps.overnight"))),
                    gapWeekendBps: uint16(cfg.readUint(string.concat(p, ".gapBps.weekend"))),
                    gapHolidayBps: uint16(cfg.readUint(string.concat(p, ".gapBps.holiday"))),
                    gapEarningsBps: uint16(cfg.readUint(string.concat(p, ".gapBps.earnings"))),
                    listed: true
                })
            );
        }
        oracle.setPublisher(publisher, agentId);

        SessionAwareFeed feed = new SessionAwareFeed(owner, oracle, IPriceSource(cfg.readAddress(".lista.resilientOracle")));
        for (uint256 i; i < 12; ++i) {
            string memory p = string.concat(".tickers[", vm.toString(i), "]");
            feed.mapAsset(cfg.readAddress(string.concat(p, ".bStock")), bytes32(bytes(cfg.readString(string.concat(p, ".symbol")))));
        }

        BallastFactory factory = new BallastFactory(
            oracle, IMoolah(cfg.readAddress(".lista.moolah")), IPcsV3SwapRouter(cfg.readAddress(".pancake.v3SwapRouter")),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        CushionVault vault = new CushionVault(oracle, IMoolah(cfg.readAddress(".lista.moolah")), 3 hours);
        BallastGuardian guardian = new BallastGuardian(
            IACP(cfg.readAddress(".erc8183.kernel")), factory, IIdentityRegistry(cfg.readAddress(".erc8004.identity")),
            IReputationRegistry(cfg.readAddress(".erc8004.reputation")), 0.01e18, 1 hours
        );
        vm.stopBroadcast();

        string memory o = "deploy";
        o.serialize("calendar", address(cal));
        o.serialize("sessionOracle", address(oracle));
        o.serialize("sessionAwareFeed", address(feed));
        o.serialize("factory", address(factory));
        o.serialize("listaImpl", factory.listaImpl());
        o.serialize("venusImpl", factory.venusImpl());
        o.serialize("cushionVault", address(vault));
        o.serialize("guardian", address(guardian));
        string memory json = o.serialize("block", block.number);
        json.write(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        console2.log("sessionOracle", address(oracle));
    }
}
