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
    function claimRefund(uint256 jobId) external;
}

interface IRepRead {
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
    function readFeedback(uint256 agentId, address client, uint64 idx)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
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
    uint256 expiry; // first open after the window, plus a day

    event FeedbackFailed(uint256 indexed jobId, uint256 agentId);
    event Settled(uint256 indexed jobId, address indexed account, bool survived, bool paid);

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
        expiry = cal.nextOpen(end) + 1 days;
        address[] memory t = new address[](2);
        t[0] = nvdab;
        t[1] = usd1;
        _freezePrices(t);
    }

    // ---------------------------------------------------------------- helpers

    function _create(address client, address provider, address evaluator, uint256 exp) internal returns (uint256 jobId) {
        _fund(usd1, client, 1e18);
        vm.startPrank(client);
        jobId = IKernel(kernel).createJobWithToken(provider, evaluator, exp, "guard", address(guardian), usd1);
        IKernel(kernel).setBudget(jobId, 1e18, "");
        IERC20(usd1).approve(kernel, 1e18);
        vm.stopPrank();
    }

    function _fundJob(address client, uint256 jobId, bytes memory terms_) internal {
        vm.prank(client);
        IKernel(kernel).fund(jobId, 1e18, terms_);
    }

    function _terms() internal view returns (bytes memory) {
        return guardian.encodeTerms(address(acct), start, end, agentId);
    }

    function _openJob() internal returns (uint256 jobId) {
        jobId = _create(user, agent, address(guardian), expiry);
        _fundJob(user, jobId, _terms());
    }

    function _submit(uint256 jobId) internal {
        vm.prank(agent);
        IKernel(kernel).submit(jobId, keccak256("shield log"), "");
    }

    function _lastFeedback() internal view returns (uint64 idx, int128 value, string memory tag1) {
        idx = IRepRead(reputation).getLastIndex(agentId, address(guardian));
        if (idx == 0) return (0, 0, "");
        (value,, tag1,,) = IRepRead(reputation).readFeedback(agentId, address(guardian), idx);
    }

    function _liquidate() internal {
        uint256 p = IPriceSource(stockOracle).peek(nvdab);
        _setPrice(nvdab, p * 55 / 100);
        address liq = cfg.readAddress(".lista.liquidatorEoa");
        _fund(usd1, liq, 10_000e18);
        vm.startPrank(liq);
        IERC20(usd1).approve(address(moolah), type(uint256).max);
        moolah.liquidate(mp, address(acct), 2e18, 0, "");
        vm.stopPrank();
        _setPrice(nvdab, p); // restore: only liquidated() can now flag the account
    }

    function _expectFundRevert(address client, uint256 jobId, bytes memory t, bytes4 sel) internal {
        vm.prank(client);
        vm.expectRevert(sel);
        IKernel(kernel).fund(jobId, 1e18, t);
    }

    // ------------------------------------------------------------- settlement

    function test_survivedWindow_paysGuardianAndWritesReputation() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        _submit(jobId);
        uint256 b0 = IERC20(usd1).balanceOf(agent);
        (uint64 idx0,,) = _lastFeedback();
        vm.expectEmit(true, true, false, true, address(guardian));
        emit Settled(jobId, address(acct), true, true);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(agent), b0 + 1e18);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Completed));
        (uint64 idx, int128 value, string memory tag1) = _lastFeedback();
        assertEq(idx, idx0 + 1, "one feedback entry written");
        assertEq(value, 100);
        assertEq(tag1, "ballast-guard");
    }

    function test_liquidatedAccount_refundsClientAndWritesZero() public {
        uint256 jobId = _openJob();
        _liquidate();
        (bool known, bool healthy) = acct.healthStatus();
        assertTrue(known && healthy, "price restored: healthy again");
        assertTrue(acct.liquidated(), "but the history says it was liquidated");
        vm.warp(end + 1);
        _submit(jobId);
        uint256 u0 = IERC20(usd1).balanceOf(user);
        vm.expectEmit(true, true, false, true, address(guardian));
        emit Settled(jobId, address(acct), false, false);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(user), u0 + 1e18);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Rejected));
        (uint64 idx, int128 value,) = _lastFeedback();
        assertGt(idx, 0);
        assertEq(value, 0);
    }

    function test_fundedNeverSubmitted_settleReverts_thenClientClaimsRefundAtExpiry() public {
        uint256 jobId = _openJob();
        vm.warp(end);
        vm.expectRevert(BallastGuardian.NotSettleable.selector);
        guardian.settle(jobId);
        vm.warp(expiry + 1);
        vm.expectRevert(BallastGuardian.NotSettleable.selector);
        guardian.settle(jobId);
        uint256 u0 = IERC20(usd1).balanceOf(user);
        vm.prank(user);
        IKernel(kernel).claimRefund(jobId);
        assertEq(IERC20(usd1).balanceOf(user), u0 + 1e18);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Expired));
    }

    function test_fundedJob_atEnd_thenSubmit_thenSettlePays() public {
        uint256 jobId = _openJob();
        vm.warp(end);
        vm.expectRevert(BallastGuardian.NotSettleable.selector);
        guardian.settle(jobId);
        _submit(jobId);
        uint256 b0 = IERC20(usd1).balanceOf(agent);
        guardian.settle(jobId);
        assertEq(IERC20(usd1).balanceOf(agent), b0 + 1e18);
    }

    function test_doubleSettle_reverts() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        _submit(jobId);
        guardian.settle(jobId);
        vm.expectRevert(BallastGuardian.NotSettleable.selector);
        guardian.settle(jobId);
    }

    function test_settleUnbound_reverts() public {
        vm.expectRevert(BallastGuardian.NotSettleable.selector);
        guardian.settle(type(uint256).max);
    }

    function test_submitBeforeWindowEnd_reverts() public {
        uint256 jobId = _openJob();
        vm.prank(agent);
        vm.expectRevert(BallastGuardian.WindowNotOver.selector);
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
        _submit(jobId);
        vm.mockCallRevert(stockOracle, abi.encodeCall(IPriceSource.peek, (nvdab)), abi.encodeWithSignature("StockMarketClosed()"));
        vm.expectRevert(BallastGuardian.CannotEvaluateNow.selector);
        guardian.settle(jobId);
    }

    function test_feedbackFailure_emitsAndSettleStillCompletes() public {
        uint256 jobId = _openJob();
        vm.warp(end + 1);
        _submit(jobId);
        vm.mockCallRevert(reputation, abi.encodeWithSelector(IReputationRegistry.giveFeedback.selector), "nope");
        vm.expectEmit(true, false, false, true, address(guardian));
        emit FeedbackFailed(jobId, agentId);
        guardian.settle(jobId);
        assertEq(uint8(IACP(kernel).getJob(jobId).status), uint8(IACP.JobStatus.Completed));
    }

    // ---------------------------------------------------------------- binding

    function test_hook_onlyKernel() public {
        bytes4 sel = bytes4(keccak256("fund(uint256,uint256,bytes)"));
        vm.expectRevert(BallastGuardian.OnlyKernel.selector);
        guardian.beforeAction(1, sel, "");
        vm.expectRevert(BallastGuardian.OnlyKernel.selector);
        guardian.afterAction(1, sel, "");
    }

    function test_supportsInterface() public view {
        assertTrue(guardian.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(guardian.supportsInterface(guardian.beforeAction.selector ^ guardian.afterAction.selector));
        assertFalse(guardian.supportsInterface(0xffffffff));
    }

    function test_doubleBind_reverts() public {
        uint256 jobId = _openJob();
        bytes memory t = _terms();
        vm.prank(kernel);
        vm.expectRevert(BallastGuardian.BadTerms.selector);
        guardian.beforeAction(jobId, bytes4(keccak256("fund(uint256,uint256,bytes)")), t);
    }

    function test_fund_rejectsForeignAccount() public {
        address other = address(0xE71);
        uint256 jobId = _create(other, agent, address(guardian), expiry);
        _expectFundRevert(other, jobId, _terms(), BallastGuardian.NotAccountOwner.selector);
    }

    function test_fund_rejectsNonFactoryAccount() public {
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        _expectFundRevert(user, jobId, guardian.encodeTerms(address(0xBEEF), start, end, agentId), BallastGuardian.BadTerms.selector);
    }

    function test_fund_rejectsWrongEvaluator() public {
        uint256 jobId = _create(user, agent, address(0xE7A1), expiry);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.BadTerms.selector);
    }

    function test_fund_rejectsBudgetTooLow() public {
        vm.startPrank(user);
        uint256 jobId = IKernel(kernel).createJobWithToken(agent, address(guardian), expiry, "guard", address(guardian), usd1);
        IKernel(kernel).setBudget(jobId, 0.001e18, "");
        IERC20(usd1).approve(kernel, 0.001e18);
        bytes memory t = _terms();
        vm.expectRevert(BallastGuardian.BudgetTooLow.selector);
        IKernel(kernel).fund(jobId, 0.001e18, t);
        vm.stopPrank();
    }

    function test_fund_rejectsPastEnd() public {
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        _expectFundRevert(
            user, jobId, guardian.encodeTerms(address(acct), start, uint64(block.timestamp), agentId), BallastGuardian.BadTerms.selector
        );
    }

    function test_fund_rejectsShortWindow() public {
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        _expectFundRevert(
            user,
            jobId,
            guardian.encodeTerms(address(acct), start, uint64(block.timestamp + 30 minutes), agentId),
            BallastGuardian.BadTerms.selector
        );
    }

    function test_fund_rejectsStaleStart() public {
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        vm.warp(block.timestamp + 10 minutes);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.BadTerms.selector);
    }

    function test_fund_rejectsExpiryBeforeReopenPlusGrace() public {
        uint256 reopen = cal.nextOpen(end);
        uint256 jobId = _create(user, agent, address(guardian), reopen + 1 hours - 1);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.BadTerms.selector);
        // exactly reopen + grace is accepted
        uint256 ok = _create(user, agent, address(guardian), reopen + 1 hours);
        _fundJob(user, ok, _terms());
        (,,,, bool bound,) = guardian.terms(ok);
        assertTrue(bound);
    }

    function test_fund_rejectsLiquidatedAccount() public {
        _liquidate();
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.BadTerms.selector);
    }

    function test_fund_rejectsDebtFreeAccount() public {
        address user2 = address(0xB0B2);
        vm.prank(user2);
        address a2 = factory.createListaAccount(mp, "NVDA", agent, BallastAccountBase.Mandate(6000, 5000, 150, true));
        uint256 jobId = _create(user2, agent, address(guardian), expiry);
        _expectFundRevert(user2, jobId, guardian.encodeTerms(a2, start, end, agentId), BallastGuardian.BadTerms.selector);
    }

    function test_fund_rejectsProviderNotAgent() public {
        uint256 jobId = _create(user, address(0x5718), address(guardian), expiry);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.ProviderNotAgent.selector);
    }

    function test_provider_canBeAgentWalletDistinctFromOwner() public {
        address wallet = address(0x3A11E7);
        vm.mockCall(identity, abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)), abi.encode(wallet));
        uint256 jobId = _create(user, wallet, address(guardian), expiry);
        _fundJob(user, jobId, _terms());
        (,,,, bool bound,) = guardian.terms(jobId);
        assertTrue(bound);
        // a stranger is still rejected while the wallet is set
        uint256 j2 = _create(user, address(0x5718), address(guardian), expiry);
        _expectFundRevert(user, j2, _terms(), BallastGuardian.ProviderNotAgent.selector);
    }

    function test_agentWalletLookupRevert_isTreatedAsZero() public {
        vm.mockCallRevert(identity, abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)), "boom");
        uint256 jobId = _openJob();
        (,,,, bool bound,) = guardian.terms(jobId);
        assertTrue(bound, "owner-as-provider still binds");
        uint256 j2 = _create(user, address(0x5718), address(guardian), expiry);
        _expectFundRevert(user, j2, _terms(), BallastGuardian.ProviderNotAgent.selector);
    }

    function test_selfDealing_clientIsProvider() public {
        vm.prank(user);
        uint256 myAgent = IIdentityRegistry(identity).register("data:application/json,{}");
        uint256 jobId = _create(user, user, address(guardian), expiry);
        _expectFundRevert(user, jobId, guardian.encodeTerms(address(acct), start, end, myAgent), BallastGuardian.BadTerms.selector);
    }

    function test_selfDealing_clientOwnsAgent() public {
        vm.prank(user);
        uint256 myAgent = IIdentityRegistry(identity).register("data:application/json,{}");
        address wallet = address(0x3A11E7);
        vm.mockCall(identity, abi.encodeCall(IIdentityRegistry.getAgentWallet, (myAgent)), abi.encode(wallet));
        uint256 jobId = _create(user, wallet, address(guardian), expiry);
        _expectFundRevert(user, jobId, guardian.encodeTerms(address(acct), start, end, myAgent), BallastGuardian.BadTerms.selector);
    }

    function test_selfDealing_clientIsAgentWallet() public {
        vm.mockCall(identity, abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)), abi.encode(user));
        uint256 jobId = _create(user, agent, address(guardian), expiry);
        _expectFundRevert(user, jobId, _terms(), BallastGuardian.BadTerms.selector);
    }
}
