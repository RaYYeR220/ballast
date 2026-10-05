// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IACP} from "./interfaces/IACP.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";
import {BallastFactory} from "./accounts/BallastFactory.sol";
import {SessionCalendar} from "./SessionCalendar.sol";
import {BallastAccountBase} from "./accounts/BallastAccountBase.sol";
import {IIdentityRegistry, IReputationRegistry} from "./interfaces/External.sol";

/// @title BallastGuardian
/// @notice ERC-8183 hook and evaluator for "guard this loan through this window" jobs on BNB Chain's
///         AgenticCommerce kernel. The client funds the job with the terms (account, window, guardian's
///         ERC-8004 id). After the window, anyone can settle: the guardian is paid only if the account was
///         not liquidated and is healthy; otherwise the client is refunded. The outcome is written to the
///         guardian's ERC-8004 reputation.
contract BallastGuardian is IACPHook {
    struct Terms {
        address account;
        uint64 start;
        uint64 end;
        uint256 agentId;
        bool bound;
        bool settled;
    }

    IACP public immutable kernel;
    BallastFactory public immutable factory;
    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    uint256 public immutable minBudget;
    uint256 public immutable minGrace;

    mapping(uint256 => Terms) public terms;

    event JobBound(uint256 indexed jobId, address indexed account, uint64 start, uint64 end, uint256 agentId);
    event Settled(uint256 indexed jobId, address indexed account, bool survived, bool paid);
    event FeedbackFailed(uint256 indexed jobId, uint256 agentId);

    error OnlyKernel();
    error BadTerms();
    error NotAccountOwner();
    error ProviderNotAgent();
    error BudgetTooLow();
    error WindowNotOver();
    error CannotEvaluateNow();
    error NotSettleable();
    error InsufficientGasForFeedback();

    constructor(
        IACP kernel_,
        BallastFactory factory_,
        IIdentityRegistry identity_,
        IReputationRegistry reputation_,
        uint256 minBudget_,
        uint256 minGrace_
    ) {
        kernel = kernel_;
        factory = factory_;
        identity = identity_;
        reputation = reputation_;
        minBudget = minBudget_;
        minGrace = minGrace_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function encodeTerms(address account, uint64 start, uint64 end, uint256 agentId) external pure returns (bytes memory) {
        return abi.encode(account, start, end, agentId);
    }

    // ------------------------------------------------------------------- hook

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        if (msg.sender != address(kernel)) revert OnlyKernel();
        if (selector == _FUND) {
            _bind(jobId, data);
        } else if (selector == _SUBMIT) {
            Terms storage t = terms[jobId];
            if (!t.bound || block.timestamp < t.end) revert WindowNotOver();
        }
    }

    function afterAction(uint256, bytes4, bytes calldata) external view {
        if (msg.sender != address(kernel)) revert OnlyKernel();
    }

    // ------------------------------------------------------------- evaluator

    /// @notice Settles a Submitted job once the window is over. Jobs that were never submitted are not
    ///         settled here: the client recovers them through the kernel's claimRefund at expiry.
    function settle(uint256 jobId) external {
        Terms storage t = terms[jobId];
        if (!t.bound || t.settled) revert NotSettleable();
        if (block.timestamp < t.end) revert WindowNotOver();
        IACP.Job memory job = kernel.getJob(jobId);
        if (job.status != IACP.JobStatus.Submitted) revert NotSettleable();

        BallastAccountBase account = BallastAccountBase(t.account);
        bool wasLiquidated = account.liquidated();
        bool survived;
        if (!wasLiquidated) {
            (bool known, bool healthy) = account.healthStatus();
            if (!known) revert CannotEvaluateNow();
            survived = healthy;
        }
        t.settled = true;
        bytes32 reason = keccak256(abi.encode(jobId, t.account, survived, wasLiquidated, block.number));
        if (survived) {
            kernel.complete(jobId, reason, "");
        } else {
            kernel.reject(jobId, reason, "");
        }
        _feedback(jobId, t.agentId, survived, reason);
        emit Settled(jobId, t.account, survived, survived);
    }

    // --------------------------------------------------------------- internal

    uint256 internal constant MIN_WINDOW = 1 hours;
    uint256 internal constant START_SLACK = 5 minutes;
    uint256 internal constant FEEDBACK_GAS_FLOOR = 260_000;

    bytes4 internal constant _FUND = bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 internal constant _SUBMIT = bytes4(keccak256("submit(uint256,bytes32,bytes)"));

    function _bind(uint256 jobId, bytes calldata data) internal {
        if (terms[jobId].bound) revert BadTerms();
        (address account, uint64 start, uint64 end, uint256 agentId) = abi.decode(data, (address, uint64, uint64, uint256));
        IACP.Job memory job = kernel.getJob(jobId);
        if (job.evaluator != address(this) || job.hook != address(this)) revert BadTerms();
        if (!factory.isAccount(account)) revert BadTerms();
        BallastAccountBase acct = BallastAccountBase(account);
        if (acct.owner() != job.client) revert NotAccountOwner();
        if (end <= block.timestamp || uint256(end) < uint256(start) + MIN_WINDOW || uint256(start) + START_SLACK < block.timestamp) {
            revert BadTerms();
        }
        uint256 reopen = factory.sessionOracle().calendar().nextOpen(end);
        if (reopen == 0 || job.expiredAt < reopen + minGrace) revert BadTerms();
        if (acct.liquidated()) revert BadTerms();
        (, uint256 debt) = acct.position();
        if (debt == 0) revert BadTerms();
        if (job.budget < minBudget) revert BudgetTooLow();
        _checkProvider(job, agentId);
        terms[jobId] = Terms({account: account, start: start, end: end, agentId: agentId, bound: true, settled: false});
        emit JobBound(jobId, account, start, end, agentId);
    }

    function _checkProvider(IACP.Job memory job, uint256 agentId) internal view {
        if (job.provider == address(0)) revert ProviderNotAgent();
        address agentOwner = identity.ownerOf(agentId);
        address wallet;
        try identity.getAgentWallet(agentId) returns (address w) {
            wallet = w;
        } catch {}
        if (job.provider != agentOwner && job.provider != wallet) revert ProviderNotAgent();
        if (job.client == job.provider || job.client == agentOwner || (wallet != address(0) && job.client == wallet)) {
            revert BadTerms();
        }
    }

    function _feedback(uint256 jobId, uint256 agentId, bool success, bytes32 reason) internal {
        if (gasleft() < FEEDBACK_GAS_FLOOR) revert InsufficientGasForFeedback();
        try reputation.giveFeedback(agentId, success ? int128(100) : int128(0), 0, "ballast-guard", "window", "", "", reason) {}
        catch {
            emit FeedbackFailed(jobId, agentId);
        }
    }
}
