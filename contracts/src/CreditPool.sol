// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ScoreLib} from "./ScoreLib.sol";
import {CreditRegistry} from "./CreditRegistry.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title CreditPool: an open USDG pool that lends working capital to agents.
/// @notice The protocol is rails, not the counterparty. Lenders deposit USDG for
/// pro-rata shares; every loan fee is split between lenders, a first-loss reserve
/// and the protocol at rates fixed at deploy. A default is absorbed by the reserve
/// before lender principal is touched, and it is priced into the borrower's score,
/// never executed against its identity.
///
/// Phase 2 lends on one path: an advance against a verified settlement whose
/// payout is still pending. The Vouch attester records the settlement here (and
/// in the registry, in the same transaction), the agent draws up to a fixed share
/// of it, and when the payout arrives it is routed through this contract: the loan
/// is repaid first and only the remainder is forwarded to the agent. A loan that
/// is not repaid by its due date plus the grace period can be marked defaulted by
/// anyone; repaying it afterwards is a recovery.
///
/// Accounting (all USDG base units):
///   balanceOf(this) == lenderCash + reserve + protocolFees           (solvency)
///   lenderAssets()  == lenderCash + outstanding                        (what shares are worth)
///   exposure[agent] == sum of remaining principal of that agent's active loans
/// Nothing is upgradeable; every parameter is immutable.
contract CreditPool {
    using ScoreLib for ScoreLib.Report;

    enum Kind { Advance, TaskEscrow, Stake }
    enum Status { None, Active, Repaid, Defaulted, Recovered }

    struct Loan {
        uint256 agentId;
        Kind kind;
        Status status;
        uint128 principal;
        uint128 remainingPrincipal;
        uint128 fee;
        uint128 feePaid;
        uint64 borrowedAt;
        uint64 dueAt;
        uint16 termDays;
        uint16 feeBps;
        bytes32 settlementId;
        address borrower;      // where the advance went: the identity owner at the time
        uint128 reserveCovered; // what the reserve absorbed on default
        uint128 lenderLoss;     // what lenders absorbed on default
    }

    struct Settlement {
        uint256 agentId;
        uint128 amount;
        uint64 payoutAt;
        uint64 attestedAt;
        bytes32 loanId;   // the advance drawn against it, if any
        bool paid;
        bool voided;
    }

    IERC20 public immutable usdg;
    CreditRegistry public immutable registry;
    IIdentityRegistry public immutable identity;
    address public immutable attester;
    address public immutable protocolTreasury;
    uint16 public immutable lenderBps;
    uint16 public immutable reserveBps;
    uint16 public immutable protocolBps;
    uint128 public immutable minLoan;
    uint128 public immutable maxLoan;
    uint16 public immutable advanceBps;      // share of a pending settlement that may be advanced
    uint64 public immutable graceSeconds;
    uint16 public constant MIN_TERM_DAYS = 1;
    uint16 public constant MAX_TERM_DAYS = 30;
    uint256 public constant BPS = 10_000;

    // lender side
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public lenderCash;     // USDG held for lenders, not lent out
    uint256 public outstanding;    // principal lent out, still owed
    uint256 public reserve;        // first-loss reserve
    uint256 public protocolFees;   // accrued, withdrawable by the protocol treasury

    // borrower side
    mapping(bytes32 => Loan) public loans;
    mapping(bytes32 => Settlement) public settlements;
    mapping(uint256 => uint256) public exposure;          // agentId -> remaining active principal
    mapping(uint256 => bytes32[]) private agentLoans;
    uint256 public loanCount;

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event SettlementAttested(uint256 indexed agentId, bytes32 indexed settlementId, uint128 amount, uint64 payoutAt);
    event SettlementVoided(bytes32 indexed settlementId);
    event Advanced(uint256 indexed agentId, bytes32 indexed loanId, bytes32 indexed settlementId, uint128 principal, uint128 fee, uint64 dueAt, address borrower);
    event Repaid(bytes32 indexed loanId, uint128 principalPaid, uint128 feePaid, Status status);
    event Defaulted(bytes32 indexed loanId, uint256 indexed agentId, uint128 loss, uint128 reserveCovered, uint128 lenderLoss);
    event ProceedsSettled(bytes32 indexed settlementId, uint128 proceeds, uint128 repaid, uint128 forwarded, address to);
    event ProtocolFeesWithdrawn(address to, uint256 amount);

    error NotAttester();
    error NotTreasury();
    error NotBorrower();
    error ZeroAddress();
    error BadSplit();
    error BadAmount();
    error TransferFailed();
    error InsufficientLiquidity();
    error UnknownAgent(uint256 agentId);
    error UnknownSettlement(bytes32 settlementId);
    error SettlementClosed(bytes32 settlementId);
    error SettlementAlreadyAdvanced(bytes32 settlementId);
    error AlreadyAttested(bytes32 settlementId);
    error TermOutOfRange(uint256 seconds_);
    error NoCredit(uint256 agentId, uint256 score);
    error BelowMinimum(uint256 amount, uint256 minimum);
    error UnknownLoan(bytes32 loanId);
    error LoanNotActive(bytes32 loanId);
    error NotDue(bytes32 loanId, uint64 dueAt, uint64 graceSeconds);

    constructor(
        IERC20 usdg_,
        CreditRegistry registry_,
        address attester_,
        address protocolTreasury_,
        uint16 lenderBps_,
        uint16 reserveBps_,
        uint16 protocolBps_,
        uint128 minLoan_,
        uint128 maxLoan_,
        uint16 advanceBps_,
        uint64 graceSeconds_
    ) {
        if (address(usdg_) == address(0) || address(registry_) == address(0) || attester_ == address(0) || protocolTreasury_ == address(0)) revert ZeroAddress();
        if (uint256(lenderBps_) + reserveBps_ + protocolBps_ != BPS) revert BadSplit();
        if (minLoan_ == 0 || maxLoan_ < minLoan_ || advanceBps_ == 0 || advanceBps_ > BPS) revert BadAmount();
        usdg = usdg_;
        registry = registry_;
        identity = registry_.identity();
        attester = attester_;
        protocolTreasury = protocolTreasury_;
        lenderBps = lenderBps_;
        reserveBps = reserveBps_;
        protocolBps = protocolBps_;
        minLoan = minLoan_;
        maxLoan = maxLoan_;
        advanceBps = advanceBps_;
        graceSeconds = graceSeconds_;
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    // ---- lenders -------------------------------------------------------------------

    /// @notice What one share is worth is lenderAssets / totalShares: cash on hand plus principal owed.
    function lenderAssets() public view returns (uint256) {
        return lenderCash + outstanding;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 total = lenderAssets();
        return (totalShares == 0 || total == 0) ? assets : (assets * totalShares) / total;
    }

    function convertToAssets(uint256 shares_) public view returns (uint256) {
        return totalShares == 0 ? 0 : (shares_ * lenderAssets()) / totalShares;
    }

    function deposit(uint256 assets) external returns (uint256 minted) {
        if (assets == 0) revert BadAmount();
        minted = convertToShares(assets);
        if (minted == 0) revert BadAmount();
        _pull(msg.sender, assets);
        lenderCash += assets;
        totalShares += minted;
        shares[msg.sender] += minted;
        emit Deposited(msg.sender, assets, minted);
    }

    /// @notice Redeem shares for USDG. Only cash on hand can leave: principal that is
    /// lent out comes back as borrowers repay.
    function withdraw(uint256 shares_) external returns (uint256 assets) {
        if (shares_ == 0 || shares_ > shares[msg.sender]) revert BadAmount();
        assets = convertToAssets(shares_);
        if (assets > lenderCash) revert InsufficientLiquidity();
        shares[msg.sender] -= shares_;
        totalShares -= shares_;
        lenderCash -= assets;
        _push(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares_);
    }

    /// @notice Anyone may capitalize the first-loss reserve (the protocol seeds it at launch
    /// so lenders are protected before fees have accrued). Donations are not shares.
    function fundReserve(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        _pull(msg.sender, amount);
        reserve += amount;
    }

    function withdrawProtocolFees(address to) external returns (uint256 amount) {
        if (msg.sender != protocolTreasury) revert NotTreasury();
        if (to == address(0)) revert ZeroAddress();
        amount = protocolFees;
        protocolFees = 0;
        _push(to, amount);
        emit ProtocolFeesWithdrawn(to, amount);
    }

    // ---- attestations (the Vouch engine) -----------------------------------------------

    /// @notice A verified settlement whose payout is pending until `payoutAt`. Recorded in
    /// the registry in the same transaction, so the score and the borrowable settlement
    /// are one fact.
    function attestSettlement(uint256 agentId, bytes32 settlementId, uint128 amount, uint64 payoutAt) external onlyAttester {
        if (settlements[settlementId].attestedAt != 0) revert AlreadyAttested(settlementId);
        if (amount == 0) revert BadAmount();
        settlements[settlementId] = Settlement({ agentId: agentId, amount: amount, payoutAt: payoutAt, attestedAt: uint64(block.timestamp), loanId: bytes32(0), paid: false, voided: false });
        registry.recordSettlement(agentId, settlementId, amount); // reverts for an unknown agent or a repeat
        emit SettlementAttested(agentId, settlementId, amount, payoutAt);
    }

    /// @notice The payout will never arrive (a clawback, a reversal). Any advance against it
    /// stays owed and defaults on schedule.
    function voidSettlement(bytes32 settlementId) external onlyAttester {
        Settlement storage s = settlements[settlementId];
        if (s.attestedAt == 0) revert UnknownSettlement(settlementId);
        if (s.paid || s.voided) revert SettlementClosed(settlementId);
        s.voided = true;
        emit SettlementVoided(settlementId);
    }

    // ---- borrowing: advances --------------------------------------------------------------

    /// @notice How much the agent could draw against this settlement right now, and at what fee.
    function quoteAdvance(uint256 agentId, bytes32 settlementId) public view returns (uint128 principal, uint128 fee, uint16 termDays, uint16 feeBps, uint256 score, uint256 line) {
        Settlement storage s = settlements[settlementId];
        if (s.attestedAt == 0 || s.agentId != agentId) revert UnknownSettlement(settlementId);
        if (s.paid || s.voided) revert SettlementClosed(settlementId);
        if (s.loanId != bytes32(0)) revert SettlementAlreadyAdvanced(settlementId);
        if (s.payoutAt <= block.timestamp) revert TermOutOfRange(0);
        uint256 term = s.payoutAt - block.timestamp;
        termDays = uint16((term + 1 days - 1) / 1 days);
        if (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS) revert TermOutOfRange(term);
        uint256 feeBps_;
        (, score,, feeBps_, line,) = registry.creditReport(agentId);
        if (line == 0) revert NoCredit(agentId, score);
        feeBps = uint16(feeBps_);
        uint256 room = line > exposure[agentId] ? line - exposure[agentId] : 0;
        uint256 cap = (uint256(s.amount) * advanceBps) / BPS;
        uint256 amount = _min(_min(cap, room), _min(maxLoan, lenderCash));
        if (amount < minLoan) revert BelowMinimum(amount, minLoan);
        principal = uint128(amount);
        fee = uint128((amount * feeBps * termDays) / (30 * BPS));
    }

    /// @notice Draw an advance against a pending settlement. The identity owner may call it,
    /// and so may the attester on the agent's behalf (the engine acting on the agent's
    /// authorization). The cash goes to the identity owner, the only path on which a loan
    /// reaches a wallet, and it is secured by the settlement already verified.
    function advance(uint256 agentId, bytes32 settlementId) external returns (bytes32 loanId) {
        address owner = _ownerOf(agentId);
        if (msg.sender != owner && msg.sender != attester) revert NotBorrower();
        (uint128 principal, uint128 fee, uint16 termDays, uint16 feeBps,,) = quoteAdvance(agentId, settlementId);
        Settlement storage s = settlements[settlementId];
        loanId = keccak256(abi.encode(address(this), ++loanCount, agentId, settlementId));
        loans[loanId] = Loan({
            agentId: agentId, kind: Kind.Advance, status: Status.Active,
            principal: principal, remainingPrincipal: principal, fee: fee, feePaid: 0,
            borrowedAt: uint64(block.timestamp), dueAt: s.payoutAt, termDays: termDays, feeBps: feeBps,
            settlementId: settlementId, borrower: owner, reserveCovered: 0, lenderLoss: 0
        });
        agentLoans[agentId].push(loanId);
        s.loanId = loanId;
        lenderCash -= principal;
        outstanding += principal;
        exposure[agentId] += principal;
        _push(owner, principal);
        emit Advanced(agentId, loanId, settlementId, principal, fee, s.payoutAt, owner);
    }

    // ---- repayment --------------------------------------------------------------------------

    /// @notice The settlement's payout arrives, pulled from the attester (the Vouch treasury
    /// paying the agent). The loan drawn against it is repaid first, principal before fee,
    /// and only the remainder reaches the agent. Repayment interception, atomically.
    function settleProceeds(bytes32 settlementId) external onlyAttester returns (uint128 repaid, uint128 forwarded) {
        Settlement storage s = settlements[settlementId];
        if (s.attestedAt == 0) revert UnknownSettlement(settlementId);
        if (s.paid || s.voided) revert SettlementClosed(settlementId);
        s.paid = true;
        _pull(msg.sender, s.amount);
        uint128 proceeds = s.amount;
        if (s.loanId != bytes32(0)) {
            Loan storage l = loans[s.loanId];
            if (l.status == Status.Active || l.status == Status.Defaulted) {
                repaid = _applyRepayment(s.loanId, l, proceeds);
            }
        }
        forwarded = proceeds - repaid;
        address to = _ownerOf(s.agentId);
        if (forwarded > 0) _push(to, forwarded);
        emit ProceedsSettled(settlementId, proceeds, repaid, forwarded, to);
    }

    /// @notice Repay by hand, in whole or in part; anyone may pay for any loan. Principal is
    /// settled before fee. Repaying a defaulted loan is a recovery: it refills the reserve
    /// and lenders first.
    function repay(bytes32 loanId, uint128 amount) external returns (uint128 applied) {
        Loan storage l = loans[loanId];
        if (l.status == Status.None) revert UnknownLoan(loanId);
        if (l.status != Status.Active && l.status != Status.Defaulted) revert LoanNotActive(loanId);
        uint128 owed = owedOn(loanId);
        if (amount == 0) revert BadAmount();
        applied = amount < owed ? amount : owed;
        _pull(msg.sender, applied);
        _applyRepayment(loanId, l, applied);
    }

    function owedOn(bytes32 loanId) public view returns (uint128) {
        Loan storage l = loans[loanId];
        return l.remainingPrincipal + (l.fee - l.feePaid);
    }

    /// @dev Applies up to `amount` to the loan (principal, then fee) and books it. Returns what was applied.
    function _applyRepayment(bytes32 loanId, Loan storage l, uint128 amount) private returns (uint128 applied) {
        uint128 p = amount < l.remainingPrincipal ? amount : l.remainingPrincipal;
        uint128 f = (amount - p) < (l.fee - l.feePaid) ? (amount - p) : (l.fee - l.feePaid);
        applied = p + f;
        if (p > 0) {
            l.remainingPrincipal -= p;
            if (l.status == Status.Active) {
                outstanding -= p;
                exposure[l.agentId] -= p;
                lenderCash += p;
            } else {
                // recovery: the reserve gets back what it absorbed, then lenders what they lost
                uint128 toReserve = p < l.reserveCovered ? p : l.reserveCovered;
                l.reserveCovered -= toReserve;
                reserve += toReserve;
                uint128 toLenders = p - toReserve;
                uint128 restore = toLenders < l.lenderLoss ? toLenders : l.lenderLoss;
                l.lenderLoss -= restore;
                lenderCash += toLenders; // includes the dust beyond the recorded loss, if any
            }
        }
        if (f > 0) {
            l.feePaid += f;
            uint256 toLenders = (uint256(f) * lenderBps) / BPS;
            uint256 toReserve = (uint256(f) * reserveBps) / BPS;
            lenderCash += toLenders;
            reserve += toReserve;
            protocolFees += f - toLenders - toReserve;
        }
        if (l.remainingPrincipal == 0 && l.feePaid == l.fee) {
            bool wasDefaulted = l.status == Status.Defaulted;
            l.status = wasDefaulted ? Status.Recovered : Status.Repaid;
            if (wasDefaulted) registry.recordRecovery(l.agentId, loanId, l.principal);
            else if (l.kind == Kind.Advance) registry.recordAdvanceRepayment(l.agentId, loanId, l.principal);
            else registry.recordRepayment(l.agentId, loanId, l.principal, l.termDays, block.timestamp <= l.dueAt);
        }
        emit Repaid(loanId, p, f, l.status);
    }

    // ---- defaults ------------------------------------------------------------------------------

    /// @notice Past due plus grace and still owed: anyone can mark it. The reserve absorbs the
    /// lost principal first; only what the reserve cannot cover reaches lender principal.
    /// Exposure is released for this loan alone; the agent's other loans stay owed.
    function markDefault(bytes32 loanId) external {
        Loan storage l = loans[loanId];
        if (l.status == Status.None) revert UnknownLoan(loanId);
        if (l.status != Status.Active) revert LoanNotActive(loanId);
        if (block.timestamp <= uint256(l.dueAt) + graceSeconds) revert NotDue(loanId, l.dueAt, graceSeconds);
        uint128 loss = l.remainingPrincipal;
        uint128 covered = uint128(_min(reserve, loss));
        reserve -= covered;
        lenderCash += covered;
        outstanding -= loss;
        exposure[l.agentId] -= loss;
        l.status = Status.Defaulted;
        l.reserveCovered = covered;
        l.lenderLoss = loss - covered;
        registry.recordDefault(l.agentId, loanId, loss);
        emit Defaulted(loanId, l.agentId, loss, covered, loss - covered);
    }

    // ---- views ----------------------------------------------------------------------------------

    function loansOf(uint256 agentId) external view returns (bytes32[] memory) {
        return agentLoans[agentId];
    }

    function isOverdue(bytes32 loanId) external view returns (bool) {
        Loan storage l = loans[loanId];
        return l.status == Status.Active && block.timestamp > uint256(l.dueAt) + graceSeconds;
    }

    // ---- internals ----------------------------------------------------------------------------

    function _ownerOf(uint256 agentId) private view returns (address owner) {
        (bool ok, bytes memory data) = address(identity).staticcall(abi.encodeWithSelector(IIdentityRegistry.ownerOf.selector, agentId));
        if (!ok || data.length != 32) revert UnknownAgent(agentId);
        owner = abi.decode(data, (address));
        if (owner == address(0)) revert UnknownAgent(agentId);
    }

    function _pull(address from, uint256 amount) private {
        if (amount == 0) return;
        if (!usdg.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!usdg.transfer(to, amount)) revert TransferFailed();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }
}
