// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {BallastGuardian} from "../../src/BallastGuardian.sol";
import {BallastAccountBase} from "../../src/accounts/BallastAccountBase.sol";
import {ListaAccount} from "../../src/accounts/ListaAccount.sol";
import {BallastFactory} from "../../src/accounts/BallastFactory.sol";
import {IACP} from "../../src/interfaces/IACP.sol";
import {
    MarketParams, IPcsV3SwapRouter, IComptroller, IVenusOracle, IIdentityRegistry, IReputationRegistry, IPriceSource
} from "../../src/interfaces/External.sol";

interface IKernel {
    function createJobWithToken(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook, address token)
        external
        returns (uint256);
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
}

contract BallastGuardianForkTest is ForkBase {
    using stdJson for string;
    BallastFactory factory;
    BallastGuardian guardian;
    ListaAccount acct;
    MarketParams mp;
    address user = address(0xA11CE);
    address agent = address(0xA6E47);
    uint256 agentId;
    uint64 start;
    uint64 end;

    function setUp() public override {
        super.setUp();
        factory = new BallastFactory(
            sOracle, moolah, IPcsV3SwapRouter(router),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        guardian = new BallastGuardian(IACP(kernel), factory, IIdentityRegistry(identity), IReputationRegistry(reputation), 0.01e18, 1 hours);
        mp = _mp("NVDAB_USD1");
        vm.prank(user);
        acct = ListaAccount(factory.createListaAccount(mp, "NVDA", agent, BallastAccountBase.Mandate(6000, 5000, 150, true)));
        _fund(nvdab, user, 10e18);
        _fund(usd1, user, 1100e18);
        vm.startPrank(user);
        IERC20(nvdab).approve(address(acct), type(uint256).max);
        acct.depositCollateral(10e18);
        acct.borrow(1000e18, user);
        vm.stopPrank();
        vm.prank(agent);
        agentId = IIdentityRegistry(identity).register("data:application/json,{}");
        start = uint64(block.timestamp);
        end = uint64(block.timestamp + 2 days);
        address[] memory t = new address[](2);
        t[0] = nvdab;
        t[1] = usd1;
        _freezePrices(t);
    }

    function _openJob() internal returns (uint256 jobId) {
        vm.startPrank(user);
        jobId = IKernel(kernel).createJobWithToken(agent, address(guardian), end + 1 days, "guard", address(guardian), usd1);
        IKernel(kernel).setBudget(jobId, 1e18, "");
        IERC20(usd1).approve(kernel, 1e18);
        IKernel(kernel).fund(jobId, 1e18, guardian.encodeTerms(address(acct), start, end, agentId));
        vm.stopPrank();
    }

    function test_survivedWindow_paysGuardian() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        vm.prank(agent);
        IKernel(kernel).submit(jobId, keccak256("shield log"), "");
        uint256 b0 = IERC20(usd1).balanceOf(agent);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(agent), b0 + 1e18);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Completed));
    }

    function test_liquidatedAccount_refundsClient() public {
        uint256 jobId = _openJob();
        uint256 p = IPriceSource(stockOracle).peek(nvdab);
        _setPrice(nvdab, p * 55 / 100);
        address liq = cfg.readAddress(".lista.liquidatorEoa");
        _fund(usd1, liq, 10_000e18);
        vm.startPrank(liq);
        IERC20(usd1).approve(address(moolah), type(uint256).max);
        moolah.liquidate(mp, address(acct), 2e18, 0, "");
        vm.stopPrank();
        vm.warp(end + 1);
        vm.prank(agent);
        IKernel(kernel).submit(jobId, keccak256("shield log"), "");
        uint256 u0 = IERC20(usd1).balanceOf(user);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(user), u0 + 1e18);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Rejected));
    }

    function test_neverSubmitted_refundsAfterWindow() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        uint256 u0 = IERC20(usd1).balanceOf(user);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(user), u0 + 1e18);
    }

    function test_submitBeforeWindowEnd_reverts() public {
        uint256 jobId = _openJob();
        vm.prank(agent);
        vm.expectRevert();
        IKernel(kernel).submit(jobId, keccak256("early"), "");
    }

    function test_settleBeforeWindowEnd_reverts() public {
        uint256 jobId = _openJob();
        vm.expectRevert(BallastGuardian.WindowNotOver.selector);
        guardian.settle(jobId);
    }

    function test_unreadablePrice_blocksSettlement() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        vm.prank(agent);
        IKernel(kernel).submit(jobId, keccak256("shield log"), "");
        vm.mockCallRevert(stockOracle, abi.encodeCall(IPriceSource.peek, (nvdab)), abi.encodeWithSignature("StockMarketClosed()"));
        vm.expectRevert(BallastGuardian.CannotEvaluateNow.selector);
        guardian.settle(jobId);
    }

    function test_fund_rejectsForeignAccount() public {
        _fund(usd1, address(0xE71), 1e18);
        vm.startPrank(address(0xE71));
        uint256 jobId = IKernel(kernel).createJobWithToken(agent, address(guardian), end + 1 days, "guard", address(guardian), usd1);
        IKernel(kernel).setBudget(jobId, 1e18, "");
        IERC20(usd1).approve(kernel, 1e18);
        bytes memory terms = guardian.encodeTerms(address(acct), start, end, agentId);
        vm.expectRevert();
        IKernel(kernel).fund(jobId, 1e18, terms);
        vm.stopPrank();
    }
}
