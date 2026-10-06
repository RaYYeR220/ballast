// SPDX-License-Identifier: MIT
// Interface from bnb-chain/apex-contracts (MIT).
pragma solidity ^0.8.20;

/// @title IACP
/// @notice Implementation-level interface between the Router / Policy layer and
///         the {AgenticCommerceUpgradeable} kernel.
/// @dev    This is NOT a strict subset of ERC-8183. It mirrors the kernel's
///         concrete storage layout and admin surface so the Router/Policy can
///         call the kernel directly. Integrating a third-party ERC-8183 kernel
///         requires an adapter contract that maps onto this interface.
interface IACP {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        uint256 submittedAt; // Timestamp when provider submitted; 0 before submission
        bytes32 deliverable; // Provider's deliverable hash; zero before submission (audit I05)
    }

    /// @notice Returns the full {Job} struct for `jobId`.
    function getJob(uint256 jobId) external view returns (Job memory);

    /// @notice Mark a submitted job as completed and release payment.
    /// @dev    MUST be callable only by `job.evaluator`.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Reject a job.
    /// @dev    Open-state rejection is client-only; Funded/Submitted rejection
    ///         is evaluator-only per ERC-8183.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Default escrow / settlement token and compatibility fallback
    ///         for jobs created before the multi-token upgrade.
    function paymentToken() external view returns (address);

    function jobPaymentToken(uint256 jobId) external view returns (address);
}
