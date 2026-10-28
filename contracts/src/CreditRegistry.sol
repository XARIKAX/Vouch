// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ScoreLib} from "./ScoreLib.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title CreditRegistry: one credit record per ERC-8004 agentId.
/// @notice Work events (verified settlements, slashes, dispute losses) are recorded
/// by the Vouch attester, the engine's verifier key, because verification runs
/// off-chain (v1 trust model, see ONCHAIN.md). Loan events are recorded by the
/// credit pool. The score is a pure function of what is recorded here: every
/// record emits an event, each reference is recorded at most once, and
/// `score`/`creditReport` are views over the aggregates ScoreLib maintains.
/// Nothing here is upgradeable and nothing has an admin override: the attester
/// and the pool are fixed at deploy time, and the pool can be bound exactly once
/// (it needs this address first, so it cannot be a constructor argument).
contract CreditRegistry {
    using ScoreLib for ScoreLib.Report;

    IIdentityRegistry public immutable identity;
    address public immutable attester;
    address public immutable deployer;
    uint256 public immutable creditLineCap; // USDG base units
    address public pool;

    mapping(uint256 => ScoreLib.Report) private reports;
    mapping(bytes32 => bool) public recorded;

    event Settled(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at);
    event Slashed(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at);
    event DisputeLost(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at);
    event LoanRepaid(uint256 indexed agentId, bytes32 indexed loanId, uint128 principal, uint64 durationDays, bool onTime, uint64 at);
    event AdvanceRepaid(uint256 indexed agentId, bytes32 indexed loanId, uint128 amount, uint64 at);
    event Defaulted(uint256 indexed agentId, bytes32 indexed loanId, uint128 amount, uint64 at);
    event Recovered(uint256 indexed agentId, bytes32 indexed loanId, uint128 amount, uint64 at);
    event PoolBound(address pool);

    error NotAttester();
    error NotPool();
    error NotDeployer();
    error PoolAlreadyBound();
    error UnknownAgent(uint256 agentId);
    error AlreadyRecorded(bytes32 key);
    error ZeroAddress();

    constructor(IIdentityRegistry identity_, address attester_, uint256 creditLineCap_) {
        if (address(identity_) == address(0) || attester_ == address(0)) revert ZeroAddress();
        identity = identity_;
        attester = attester_;
        deployer = msg.sender;
        creditLineCap = creditLineCap_;
    }

    /// @notice One-time wiring of the pool that may record loan events.
    function bindPool(address pool_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (pool != address(0)) revert PoolAlreadyBound();
        if (pool_ == address(0)) revert ZeroAddress();
        pool = pool_;
        emit PoolBound(pool_);
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != pool || pool == address(0)) revert NotPool();
        _;
    }

    /// @dev An agentId exists when the identity registry knows an owner for it.
    function exists(uint256 agentId) public view returns (bool) {
        (bool ok, bytes memory data) = address(identity).staticcall(abi.encodeWithSelector(IIdentityRegistry.ownerOf.selector, agentId));
        return ok && data.length == 32 && abi.decode(data, (address)) != address(0);
    }

    function _once(bytes32 kind, uint256 agentId, bytes32 ref) private {
        if (!exists(agentId)) revert UnknownAgent(agentId);
        bytes32 key = keccak256(abi.encode(kind, agentId, ref));
        if (recorded[key]) revert AlreadyRecorded(key);
        recorded[key] = true;
    }

    // ---- work events (attester) -------------------------------------------------

    function recordSettlement(uint256 agentId, bytes32 ref, uint128 amount) external onlyAttester {
        _once("settlement", agentId, ref);
        reports[agentId].addSettlement(amount, uint64(block.timestamp));
        emit Settled(agentId, ref, amount, uint64(block.timestamp));
    }

    function recordSlash(uint256 agentId, bytes32 ref, uint128 amount) external onlyAttester {
        _once("slash", agentId, ref);
        reports[agentId].addSlash(amount);
        emit Slashed(agentId, ref, amount, uint64(block.timestamp));
    }

    function recordDisputeLoss(uint256 agentId, bytes32 ref, uint128 amount) external onlyAttester {
        _once("dispute", agentId, ref);
        reports[agentId].addDisputeLoss(amount);
        emit DisputeLost(agentId, ref, amount, uint64(block.timestamp));
    }

    // ---- loan events (pool) ----------------------------------------------------------

    function recordRepayment(uint256 agentId, bytes32 loanId, uint128 principal, uint64 durationDays, bool onTime) external onlyPool {
        _once("repaid", agentId, loanId);
        reports[agentId].addRepayment(principal, durationDays, onTime);
        emit LoanRepaid(agentId, loanId, principal, durationDays, onTime, uint64(block.timestamp));
    }

    function recordAdvanceRepayment(uint256 agentId, bytes32 loanId, uint128 amount) external onlyPool {
        _once("advance", agentId, loanId);
        reports[agentId].addAdvanceRepayment(amount);
        emit AdvanceRepaid(agentId, loanId, amount, uint64(block.timestamp));
    }

    function recordDefault(uint256 agentId, bytes32 loanId, uint128 amount) external onlyPool {
        _once("default", agentId, loanId);
        reports[agentId].addDefault(amount, uint64(block.timestamp));
        emit Defaulted(agentId, loanId, amount, uint64(block.timestamp));
    }

    function recordRecovery(uint256 agentId, bytes32 loanId, uint128 amount) external onlyPool {
        _once("recovery", agentId, loanId);
        reports[agentId].addRecovery(amount, uint64(block.timestamp));
        emit Recovered(agentId, loanId, amount, uint64(block.timestamp));
    }

    // ---- views -------------------------------------------------------------------------

    function score(uint256 agentId) public view returns (uint256) {
        return reports[agentId].score(block.timestamp);
    }

    function report(uint256 agentId) external view returns (ScoreLib.Report memory) {
        return reports[agentId];
    }

    /// @notice Every input to the score plus what it prices to, in one call.
    function creditReport(uint256 agentId)
        external
        view
        returns (
            ScoreLib.Report memory r,
            uint256 score_,
            uint8 tier,
            uint256 feeBps30d,
            uint256 creditLine,
            uint256 recentVolumeNow
        )
    {
        r = reports[agentId];
        score_ = r.score(block.timestamp);
        tier = ScoreLib.tier(score_);
        feeBps30d = ScoreLib.feeBps30d(score_);
        recentVolumeNow = ScoreLib.decayed(r.recentVolume, r.workUpdatedAt, block.timestamp, ScoreLib.WORK_HALF_LIFE);
        creditLine = ScoreLib.creditLine(score_, recentVolumeNow, creditLineCap);
    }
}
