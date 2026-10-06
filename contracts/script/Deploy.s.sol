// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
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
        uint256 agentId;
        if (block.chainid == 31337) {
            agentId = vm.envOr("PUBLISHER_AGENT_ID", uint256(0));
        } else {
            require(cfg.readUint(".chainId") == block.chainid, "config chainId mismatch");
            agentId = vm.envUint("PUBLISHER_AGENT_ID"); // must be a registered ERC-8004 id off the dry-run chain
            require(agentId != 0, "PUBLISHER_AGENT_ID is zero");
        }
        vm.startBroadcast();
        address owner = msg.sender;
        // The publisher key lives on the always-on agent host; the owner key must never be that key.
        if (block.chainid != 31337) require(publisher != owner, "PUBLISHER_ADDRESS is the owner");
        uint256 n = _tickerCount(cfg);
        require(n != 0, "no tickers in config");

        SessionCalendar cal = new SessionCalendar();
        SessionOracle oracle = new SessionOracle(
            owner, cal, IPriceSource(cfg.readAddress(".lista.resilientOracle")),
            IOndoSharesOracle(cfg.readAddress(".ondo.sharesOracle")),
            SessionOracle.Params(5400, 10800, 60, 93600, 21600, 100, 300)
        );
        for (uint256 i; i < n; ++i) {
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
        for (uint256 i; i < n; ++i) {
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
        o.serialize("owner", owner);
        o.serialize("calendar", address(cal));
        o.serialize("sessionOracle", address(oracle));
        o.serialize("sessionAwareFeed", address(feed));
        o.serialize("factory", address(factory));
        o.serialize("listaImpl", factory.listaImpl());
        o.serialize("venusImpl", factory.venusImpl());
        o.serialize("cushionVault", address(vault));
        o.serialize("guardian", address(guardian));
        string memory json = o.serialize("block", block.number);
        // Only a real broadcast records addresses; a simulation must not leave a deployments file behind.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            json.write(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        } else {
            console2.log("simulation only: deployments file not written");
        }
        console2.log("sessionOracle", address(oracle));
    }

    function _tickerCount(string memory cfg) internal view returns (uint256 n) {
        while (cfg.keyExists(string.concat(".tickers[", vm.toString(n), "]"))) ++n;
    }
}
