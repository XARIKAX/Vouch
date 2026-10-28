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
/// Three lending paths, none of which lands in a free wallet:
///   advance        against a verified settlement whose payout is pending; the cash goes
///                  to the identity owner and the payout repays it first (phase 2)
///   task escrow    the principal stays in this contract, earmarked for a task the agent is
///                  posting; the Vouch engine mirrors it as that task's locked budget. On
///                  settlement it goes to the treasury (which paid the provider), on refund
///                  it returns to the lenders as repayment (phase 3)
///   stake          the principal stays in this contract as the agent's borrowed stake; the
///                  engine mirrors it as bond. Slashes seize from it to the treasury; releasing
///                  it repays the principal (phase 3)
/// Every path is repaid out of the agent's settlement proceeds before the agent sees them.
///
/// On the advance path, The Vouch attester records the settlement here (and
/// in the registry, in the same transaction), the agent draws up to a fixed share
/// of it, and when the payout arrives it is routed through this contract: the loan
/// is repaid first and only the remainder is forwarded to the agent. A loan that
/// is not repaid by its due date plus the grace period can be marked defaulted by
/// anyone; repaying it afterwards is a recovery.
///
/// Accounting (all USDG base units):
///   balanceOf(this) == lenderCash + reserve + protocolFees + escrowHeld + stakeHeld   (solvency)
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
    // principal that never left: held per loan, by kind
    mapping(bytes32 => uint128) public held;          // loanId -> principal still inside this contract
    mapping(bytes32 => bytes32) public escrowLoan;    // task ref -> its escrow loan
    uint256 public escrowHeld;
    uint256 public stakeHeld;

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event SettlementAttested(uint256 indexed agentId, bytes32 indexed settlementId, uint128 amount, uint64 payoutAt);
    event SettlementVoided(bytes32 indexed settlementId);
    event Advanced(uint256 indexed agentId, bytes32 indexed loanId, bytes32 indexed settlementId, uint128 principal, uint128 fee, uint64 dueAt, address borrower);
    event Repaid(bytes32 indexed loanId, uint128 principalPaid, uint128 feePaid, Status status);
    event Defaulted(bytes32 indexed loanId, uint256 indexed agentId, uint128 loss, uint128 reserveCovered, uint128 lenderLoss);
    event ProceedsSettled(bytes32 indexed settlementId, uint128 proceeds, uint128 repaid, uint128 forwarded, address to);
    event ProtocolFeesWithdrawn(address to, uint256 amount);
    event EscrowFunded(uint256 indexed agentId, bytes32 indexed loanId, bytes32 indexed taskRef, uint128 principal, uint128 fee, uint64 dueAt);
    event EscrowSettled(bytes32 indexed taskRef, bytes32 indexed loanId, uint128 amount, address to);
    event EscrowRefunded(bytes32 indexed taskRef, bytes32 indexed loanId, uint128 amount);
    event StakeFunded(uint256 indexed agentId, bytes32 indexed loanId, uint128 principal, uint128 fee, uint64 dueAt);
    event StakeSlashed(bytes32 indexed loanId, uint128 amount, address to);
    event StakeReleased(bytes32 indexed loanId, uint128 amount);

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
    error EscrowTaken(bytes32 taskRef);
    error WrongKind(bytes32 loanId);
    error NothingHeld(bytes32 loanId);

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

    // ---- borrowing: escrow and stake loans (the principal never leaves) ---------------------------

    /// @notice The most the agent can borrow right now on a sized path, and the fee for `amount` over `termDays`.
    function quoteLoan(uint256 agentId, uint128 amount, uint16 termDays) public view returns (uint128 fee, uint16 feeBps, uint256 score, uint256 line, uint256 room) {
        if (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS) revert TermOutOfRange(uint256(termDays) * 1 days);
        uint256 feeBps_;
        (, score,, feeBps_, line,) = registry.creditReport(agentId);
        if (line == 0) revert NoCredit(agentId, score);
        feeBps = uint16(feeBps_);
        uint256 free = line > exposure[agentId] ? line - exposure[agentId] : 0;
        room = _min(_min(free, maxLoan), lenderCash);
        if (amount < minLoan) revert BelowMinimum(amount, minLoan);
        if (amount > room) revert BelowMinimum(room, amount);
        fee = uint128((uint256(amount) * feeBps * termDays) / (30 * BPS));
    }

    function _openSizedLoan(uint256 agentId, Kind kind, uint128 amount, uint16 termDays, bytes32 ref) private returns (bytes32 loanId, uint128 fee) {
        address owner = _ownerOf(agentId);
        if (msg.sender != owner && msg.sender != attester) revert NotBorrower();
        uint16 feeBps;
        (fee, feeBps,,,) = quoteLoan(agentId, amount, termDays);
        loanId = keccak256(abi.encode(address(this), ++loanCount, agentId, ref));
        loans[loanId] = Loan({
            agentId: agentId, kind: kind, status: Status.Active,
            principal: amount, remainingPrincipal: amount, fee: fee, feePaid: 0,
            borrowedAt: uint64(block.timestamp), dueAt: uint64(block.timestamp + uint256(termDays) * 1 days), termDays: termDays, feeBps: feeBps,
            settlementId: ref, borrower: owner, reserveCovered: 0, lenderLoss: 0
        });
        agentLoans[agentId].push(loanId);
        held[loanId] = amount;
        lenderCash -= amount;
        outstanding += amount;
        exposure[agentId] += amount;
    }

    /// @notice Borrow a task's budget. The principal stays here, earmarked for `taskRef`; the
    /// engine locks the same amount as that task's escrow. Nothing is transferred.
    function fundTaskEscrow(uint256 agentId, bytes32 taskRef, uint128 amount, uint16 termDays) external returns (bytes32 loanId) {
        if (taskRef == bytes32(0)) revert BadAmount();
        if (escrowLoan[taskRef] != bytes32(0)) revert EscrowTaken(taskRef);
        uint128 fee;
        (loanId, fee) = _openSizedLoan(agentId, Kind.TaskEscrow, amount, termDays, taskRef);
        escrowLoan[taskRef] = loanId;
        escrowHeld += amount;
        emit EscrowFunded(agentId, loanId, taskRef, amount, fee, loans[loanId].dueAt);
    }

    /// @notice The task settled: the engine's ledger paid the provider, so the held budget goes
    /// to the treasury. The loan stays owed and is repaid out of the agent's proceeds.
    function settleTaskEscrow(bytes32 taskRef) external onlyAttester returns (uint128 amount) {
        bytes32 loanId = escrowLoan[taskRef];
        if (loanId == bytes32(0)) revert UnknownLoan(taskRef);
        amount = held[loanId];
        if (amount == 0) revert NothingHeld(loanId);
        held[loanId] = 0;
        escrowHeld -= amount;
        _push(attester, amount);
        emit EscrowSettled(taskRef, loanId, amount, attester);
    }

    /// @notice The task was refunded: the held budget never left, so it goes straight back to the
    /// lenders as principal repaid. The fee stays owed.
    function refundTaskEscrow(bytes32 taskRef) external onlyAttester returns (uint128 amount) {
        bytes32 loanId = escrowLoan[taskRef];
        if (loanId == bytes32(0)) revert UnknownLoan(taskRef);
        amount = held[loanId];
        if (amount == 0) revert NothingHeld(loanId);
        held[loanId] = 0;
        escrowHeld -= amount;
        _applyRepayment(loanId, loans[loanId], amount); // books the bucket move; no transfer
        emit EscrowRefunded(taskRef, loanId, amount);
    }

    /// @notice Borrow stake. The principal stays here as the agent's borrowed collateral; the
    /// engine mirrors it as bond. It is released back to the lenders when the agent returns it,
    /// seized to the treasury when the agent is slashed.
    function fundStake(uint256 agentId, uint128 amount, uint16 termDays) external returns (bytes32 loanId) {
        uint128 fee;
        (loanId, fee) = _openSizedLoan(agentId, Kind.Stake, amount, termDays, bytes32(0));
        stakeHeld += amount;
        emit StakeFunded(agentId, loanId, amount, fee, loans[loanId].dueAt);
    }

    /// @notice A verifier-attested slash of borrowed stake: seized to the treasury (the
    /// insurance pool). The agent still owes the principal it lost.
    function slashHeldStake(bytes32 loanId, uint128 amount) external onlyAttester {
        Loan storage l = loans[loanId];
        if (l.status == Status.None) revert UnknownLoan(loanId);
        if (l.kind != Kind.Stake) revert WrongKind(loanId);
        if (amount == 0 || amount > held[loanId]) revert BadAmount();
        held[loanId] -= amount;
        stakeHeld -= amount;
        _push(attester, amount);
        emit StakeSlashed(loanId, amount, attester);
    }

    /// @notice Return borrowed stake: the held principal goes back to the lenders as repayment.
    /// The identity owner or the attester (the engine, on an unstake) may call it.
    function releaseStake(bytes32 loanId, uint128 amount) external returns (uint128 released) {
        Loan storage l = loans[loanId];
        if (l.status == Status.None) revert UnknownLoan(loanId);
        if (l.kind != Kind.Stake) revert WrongKind(loanId);
        if (msg.sender != l.borrower && msg.sender != attester && msg.sender != _ownerOf(l.agentId)) revert NotBorrower();
        if (l.status != Status.Active && l.status != Status.Defaulted) revert LoanNotActive(loanId);
        released = amount < held[loanId] ? amount : held[loanId];
        if (released == 0) revert NothingHeld(loanId);
        held[loanId] -= released;
        stakeHeld -= released;
        _applyRepayment(loanId, l, released);
        emit StakeReleased(loanId, released);
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
        // then the agent's other open loans, oldest first: every path is repaid out of proceeds
        bytes32[] storage all = agentLoans[s.agentId];
        for (uint256 i = 0; i < all.length && repaid < proceeds; i++) {
            if (all[i] == s.loanId) continue;
            Loan storage o = loans[all[i]];
            if (o.status != Status.Active && o.status != Status.Defaulted) continue;
            repaid += _applyRepayment(all[i], o, proceeds - repaid);
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

    /// @notice What is owed in cash: principal not still held here, plus the unpaid fee. Held
    /// principal is never paid for twice; it comes back through settle, refund, release or default.
    function owedOn(bytes32 loanId) public view returns (uint128) {
        Loan storage l = loans[loanId];
        return (l.remainingPrincipal - held[loanId]) + (l.fee - l.feePaid);
    }

    /// @dev Applies up to `amount` to the loan (unheld principal, then fee) and books it. Returns what was applied.
    function _applyRepayment(bytes32 loanId, Loan storage l, uint128 amount) private returns (uint128 applied) {
        uint128 unheld = l.remainingPrincipal - held[loanId];
        uint128 p = amount < unheld ? amount : unheld;
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
        // principal still held here is not lost: it returns to the lenders first
        uint128 kept = held[loanId];
        if (kept > 0) {
            held[loanId] = 0;
            if (l.kind == Kind.Stake) stakeHeld -= kept; else escrowHeld -= kept;
            uint128 back = kept < l.remainingPrincipal ? kept : l.remainingPrincipal;
            l.remainingPrincipal -= back;
            outstanding -= back;
            exposure[l.agentId] -= back;
            lenderCash += kept; // the whole bucket returns; anything beyond principal is dust
            if (l.remainingPrincipal == 0 && l.feePaid == l.fee) {
                l.status = Status.Repaid;
                if (l.kind == Kind.Advance) registry.recordAdvanceRepayment(l.agentId, loanId, l.principal);
                else registry.recordRepayment(l.agentId, loanId, l.principal, l.termDays, false);
                emit Repaid(loanId, back, 0, l.status);
                return;
            }
        }
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
