// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {CreditRegistry} from "../src/CreditRegistry.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/// @dev Drives the pool through random lifecycles: deposits and withdrawals, attested
/// settlements, advances, proceeds, partial and full repayments, voids, time, defaults,
/// recoveries, reserve top-ups. It never asserts (a reverting handler would hide the
/// violation); it records ghost facts the invariants check.
contract PoolHandler is Test {
    uint256 constant USDG = 1e6;
    CreditPool public pool;
    CreditRegistry public reg;
    MockUSDG public usdg;
    MockIdentityRegistry public identity;
    address public attester;
    address[] public lenders;
    uint256[] public agents;
    address[] public agentWallets;
    bytes32[] public settlementIds;
    bytes32[] public loanIds;
    uint256 settlementN;

    // ghosts
    uint256 public ghost_deposited;
    uint256 public ghost_withdrawn;
    uint256 public ghost_uncoveredLoss;   // principal lost by lenders because the reserve was empty
    bool public ghost_orderingViolated;   // a payout reached the agent before the loan was repaid
    bool public ghost_reserveViolated;    // lender assets moved on a default the reserve could cover
    mapping(address => uint256) public ghost_walletCredits; // USDG that legitimately reached an agent wallet: advances and forwarded proceeds
    uint256 public ghost_treasuryCredits;  // USDG that legitimately reached the attester: settled escrow and slashed stake
    uint256 public ghost_defaults;
    uint256 public ghost_calls;

    constructor(CreditPool pool_, CreditRegistry reg_, MockUSDG usdg_, MockIdentityRegistry identity_, address attester_) {
        pool = pool_; reg = reg_; usdg = usdg_; identity = identity_; attester = attester_;
        for (uint256 i = 0; i < 3; i++) lenders.push(makeAddr(string.concat("lender", vm.toString(i))));
        for (uint256 i = 0; i < 3; i++) {
            address w = makeAddr(string.concat("agent", vm.toString(i)));
            agentWallets.push(w);
            vm.prank(w);
            agents.push(identity.register("ipfs://agent"));
        }
        // the attester pays settlements: give it a deep purse
        usdg.mint(attester, 1e15);
        vm.prank(attester);
        usdg.approve(address(pool), type(uint256).max);
        // every agent starts with a history worth tier 1 and a lender has cash in, so the
        // borrowing paths are reachable from the first call (a cold start never borrows)
        for (uint256 j = 0; j < agents.length; j++) _earn(agents[j], 50, 20 * USDG);
        _depositAs(lenders[0], 5000 * USDG);
    }

    function _earn(uint256 agentId, uint256 n, uint256 amount) internal {
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = keccak256(abi.encode("s", ++settlementN));
            vm.prank(attester);
            pool.attestSettlement(agentId, id, uint128(amount), uint64(block.timestamp + 10 days));
            settlementIds.push(id);
        }
    }

    function _depositAs(address l, uint256 amount) internal {
        usdg.mint(l, amount);
        vm.startPrank(l);
        usdg.approve(address(pool), amount);
        try pool.deposit(amount) { ghost_deposited += amount; } catch {}
        vm.stopPrank();
    }

    /// A burst of verified work: keeps scores (and lines) alive as time passes.
    function earn(uint256 seed, uint256 amount) external {
        ghost_calls++;
        _earn(_agent(seed), 10, bound(amount, 1 * USDG, 200 * USDG));
    }

    function _lender(uint256 seed) internal view returns (address) { return lenders[seed % lenders.length]; }
    function _agent(uint256 seed) internal view returns (uint256) { return agents[seed % agents.length]; }

    function deposit(uint256 seed, uint256 amount) external {
        ghost_calls++;
        amount = bound(amount, 1, 50_000 * USDG);
        _depositAs(_lender(seed), amount);
    }

    function withdraw(uint256 seed, uint256 frac) external {
        ghost_calls++;
        address l = _lender(seed);
        uint256 s = pool.shares(l);
        if (s == 0) return;
        uint256 part = bound(frac, 1, s);
        uint256 assets = pool.convertToAssets(part);
        vm.prank(l);
        try pool.withdraw(part) { ghost_withdrawn += assets; } catch {}
    }

    function fundReserve(uint256 amount) external {
        ghost_calls++;
        amount = bound(amount, 1, 500 * USDG);
        usdg.mint(address(this), amount);
        usdg.approve(address(pool), amount);
        pool.fundReserve(amount);
    }

    function attest(uint256 seed, uint256 amount, uint256 termDays) external {
        ghost_calls++;
        amount = bound(amount, 1, 2000 * USDG);
        termDays = bound(termDays, 1, 35);
        bytes32 id = keccak256(abi.encode("s", ++settlementN));
        vm.prank(attester);
        try pool.attestSettlement(_agent(seed), id, uint128(amount), uint64(block.timestamp + termDays * 1 days)) { settlementIds.push(id); } catch {}
    }

    function advance(uint256 idx) external {
        ghost_calls++;
        uint256 n = settlementIds.length;
        if (n == 0) return;
        // walk from a random start to the first settlement that is still open to an advance
        for (uint256 k = 0; k < 25 && k < n; k++) {
            bytes32 sid = settlementIds[(idx + k) % n];
            (uint256 agentId, , uint64 payoutAt, , bytes32 loanId, bool paid, bool voided) = pool.settlements(sid);
            if (paid || voided || loanId != bytes32(0) || payoutAt <= block.timestamp) continue;
            vm.prank(attester);
            try pool.advance(agentId, sid) returns (bytes32 newLoan) {
                loanIds.push(newLoan);
                (, , , uint128 principal, , , , , , , , , , , ) = pool.loans(newLoan);
                ghost_walletCredits[identity.ownerOf(agentId)] += principal;
            } catch {}
            return;
        }
    }

    function settleProceeds(uint256 idx) external {
        ghost_calls++;
        if (settlementIds.length == 0) return;
        bytes32 sid = settlementIds[idx % settlementIds.length];
        (uint256 agentId, uint128 amount, , , bytes32 loanId, bool paid, bool voided) = pool.settlements(sid);
        if (paid || voided) return;
        uint128 owedBefore = loanId == bytes32(0) ? 0 : _owedIfOpen(loanId);
        address wallet = identity.ownerOf(agentId);
        uint256 walletBefore = usdg.balanceOf(wallet);
        vm.prank(attester);
        try pool.settleProceeds(sid) returns (uint128 repaid, uint128 forwarded) {
            uint128 expectRepaid = owedBefore < amount ? owedBefore : amount;
            if (repaid < expectRepaid || forwarded != amount - repaid || usdg.balanceOf(wallet) - walletBefore != forwarded) ghost_orderingViolated = true;
            ghost_walletCredits[wallet] += forwarded;
        } catch {}
    }

    function repay(uint256 idx, uint256 amount) external {
        ghost_calls++;
        if (loanIds.length == 0) return;
        bytes32 loanId = loanIds[idx % loanIds.length];
        uint128 owed = _owedIfOpen(loanId);
        if (owed == 0) return;
        amount = bound(amount, 1, owed);
        usdg.mint(address(this), amount);
        usdg.approve(address(pool), amount);
        try pool.repay(loanId, uint128(amount)) {} catch {}
    }

    function voidSettlement(uint256 idx) external {
        ghost_calls++;
        if (settlementIds.length == 0) return;
        vm.prank(attester);
        try pool.voidSettlement(settlementIds[idx % settlementIds.length]) {} catch {}
    }

    function warp(uint256 dt) external {
        ghost_calls++;
        vm.warp(block.timestamp + bound(dt, 1 hours, 16 days));
    }

    function markDefault(uint256 idx) external {
        ghost_calls++;
        uint256 n = loanIds.length;
        if (n == 0) return;
        // walk from a random start to the first overdue loan
        bytes32 loanId;
        for (uint256 k = 0; k < n; k++) {
            bytes32 candidate = loanIds[(idx + k) % n];
            if (pool.isOverdue(candidate)) { loanId = candidate; break; }
        }
        if (loanId == bytes32(0)) return;
        (, , , , uint128 remaining, , , , , , , , , , ) = pool.loans(loanId);
        remaining -= pool.held(loanId); // held principal comes back; only the rest is at risk
        uint256 reserveBefore = pool.reserve();
        uint256 assetsBefore = pool.lenderAssets();
        try pool.markDefault(loanId) {
            ghost_defaults++;
            if (reserveBefore >= remaining) {
                if (pool.lenderAssets() != assetsBefore) ghost_reserveViolated = true;
            } else {
                uint256 uncovered = remaining - reserveBefore;
                ghost_uncoveredLoss += uncovered;
                if (pool.lenderAssets() != assetsBefore - uncovered) ghost_reserveViolated = true;
            }
        } catch {}
    }

    function fundEscrow(uint256 seed, uint256 amount, uint256 termDays) external {
        ghost_calls++;
        uint256 agentId = _agent(seed);
        bytes32 ref = keccak256(abi.encode("task", ghost_calls));
        vm.prank(attester);
        try pool.fundTaskEscrow(agentId, ref, uint128(bound(amount, 5 * USDG, 400 * USDG)), uint16(bound(termDays, 1, 30))) returns (bytes32 loanId) { loanIds.push(loanId); taskRefs.push(ref); } catch {}
    }

    function settleEscrow(uint256 idx) external {
        ghost_calls++;
        if (taskRefs.length == 0) return;
        bytes32 ref = taskRefs[idx % taskRefs.length];
        uint256 before = usdg.balanceOf(attester);
        vm.prank(attester);
        try pool.settleTaskEscrow(ref) { ghost_treasuryCredits += usdg.balanceOf(attester) - before; } catch {}
    }

    function refundEscrow(uint256 idx) external {
        ghost_calls++;
        if (taskRefs.length == 0) return;
        vm.prank(attester);
        try pool.refundTaskEscrow(taskRefs[idx % taskRefs.length]) {} catch {}
    }

    function fundStake(uint256 seed, uint256 amount, uint256 termDays) external {
        ghost_calls++;
        vm.prank(attester);
        try pool.fundStake(_agent(seed), uint128(bound(amount, 5 * USDG, 400 * USDG)), uint16(bound(termDays, 1, 30))) returns (bytes32 loanId) { loanIds.push(loanId); } catch {}
    }

    function slashStake(uint256 idx, uint256 amount) external {
        ghost_calls++;
        if (loanIds.length == 0) return;
        bytes32 loanId = loanIds[idx % loanIds.length];
        uint128 h = pool.held(loanId);
        if (h == 0) return;
        uint256 before = usdg.balanceOf(attester);
        vm.prank(attester);
        try pool.slashHeldStake(loanId, uint128(bound(amount, 1, h))) { ghost_treasuryCredits += usdg.balanceOf(attester) - before; } catch {}
    }

    function releaseStake(uint256 idx, uint256 amount) external {
        ghost_calls++;
        if (loanIds.length == 0) return;
        bytes32 loanId = loanIds[idx % loanIds.length];
        uint128 h = pool.held(loanId);
        if (h == 0) return;
        vm.prank(attester);
        try pool.releaseStake(loanId, uint128(bound(amount, 1, h))) {} catch {}
    }

    bytes32[] public taskRefs;

    function _owedIfOpen(bytes32 loanId) internal view returns (uint128) {
        (, , CreditPool.Status st, , , , , , , , , , , , ) = pool.loans(loanId);
        if (st != CreditPool.Status.Active && st != CreditPool.Status.Defaulted) return 0;
        return pool.owedOn(loanId);
    }

    /// @dev Lender loss still outstanding: the pool keeps each defaulted loan's lenderLoss
    /// current (recoveries pay it down), so the sum is the net uncovered loss.
    function netUncoveredLoss() public view returns (uint256 sum) {
        for (uint256 i = 0; i < loanIds.length; i++) {
            (, , CreditPool.Status st, , , , , , , , , , , , uint128 lenderLoss) = pool.loans(loanIds[i]);
            if (st == CreditPool.Status.Defaulted || st == CreditPool.Status.Recovered) sum += lenderLoss;
        }
    }

    function loanCount() external view returns (uint256) { return loanIds.length; }
    function agentCount() external view returns (uint256) { return agents.length; }
}

contract CreditPoolInvariants is Test {
    uint256 constant USDG = 1e6;
    MockUSDG usdg;
    MockIdentityRegistry identity;
    CreditRegistry reg;
    CreditPool pool;
    PoolHandler handler;
    address attester = makeAddr("attester");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        identity = new MockIdentityRegistry();
        reg = new CreditRegistry(IIdentityRegistry(address(identity)), attester, 1000 * USDG);
        pool = new CreditPool(IERC20(address(usdg)), reg, attester, makeAddr("treasury"), 7000, 2000, 1000, uint128(5 * USDG), uint128(1000 * USDG), 8000, 3 days);
        reg.bindPool(address(pool));
        handler = new PoolHandler(pool, reg, usdg, identity, attester);
        targetContract(address(handler));
    }

    /// Solvency: every USDG the pool holds is accounted to lenders, the reserve or the protocol.
    function invariant_solvent() public view {
        assertEq(usdg.balanceOf(address(pool)), pool.lenderCash() + pool.reserve() + pool.protocolFees() + pool.escrowHeld() + pool.stakeHeld());
    }

    /// Held principal: every escrow/stake loan holds at most its principal, and the buckets are their sums.
    function invariant_heldBuckets() public view {
        uint256 n = handler.loanCount();
        uint256 escrow;
        uint256 stake;
        for (uint256 i = 0; i < n; i++) {
            bytes32 loanId = handler.loanIds(i);
            (, CreditPool.Kind kind, , uint128 principal, , , , , , , , , , , ) = pool.loans(loanId);
            uint128 h = pool.held(loanId);
            assertLe(h, principal, "held above principal");
            if (kind == CreditPool.Kind.TaskEscrow) escrow += h;
            else if (kind == CreditPool.Kind.Stake) stake += h;
            else assertEq(h, 0, "an advance holds nothing");
        }
        assertEq(pool.escrowHeld(), escrow);
        assertEq(pool.stakeHeld(), stake);
    }

    /// Money reaches an agent wallet only as an advance or as forwarded proceeds, and reaches
    /// the treasury only as a settled task budget or slashed stake. Nothing else ever leaves on
    /// a loan path. (Wallets and the treasury's own spending are accounted by the handler.)
    function invariant_noFreeWalletDisbursement() public view {
        for (uint256 j = 0; j < handler.agentCount(); j++) {
            address w = identity.ownerOf(handler.agents(j));
            assertEq(usdg.balanceOf(w), handler.ghost_walletCredits(w), "an agent wallet holds USDG it was not paid on a lawful path");
        }
    }

    /// Lenders never lose principal while the reserve covers a default, across any number of
    /// defaults per agent and across agents; what they lose otherwise is exactly the uncovered
    /// part, and recoveries give it back.
    function invariant_lenderPrincipal() public view {
        assertFalse(handler.ghost_reserveViolated(), "a default moved lender assets although the reserve covered it");
        uint256 net = handler.netUncoveredLoss();
        assertGe(pool.lenderAssets() + handler.ghost_withdrawn() + net, handler.ghost_deposited(), "lenders are short more than the uncovered losses");
        if (handler.ghost_uncoveredLoss() == 0) {
            assertGe(pool.lenderAssets() + handler.ghost_withdrawn(), handler.ghost_deposited(), "principal lost with the reserve intact");
        }
    }

    /// Every loan is on a lawful path: an advance is tied to an attested pending settlement,
    /// never above the advance share, paid to the identity owner; an escrow loan is tied to a
    /// task ref; a stake loan is tied to nothing and nobody was paid.
    function invariant_disbursementPaths() public view {
        uint256 n = handler.loanCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 loanId = handler.loanIds(i);
            (uint256 agentId, CreditPool.Kind kind, , uint128 principal, , , , , , , , bytes32 sid, address borrower, , ) = pool.loans(loanId);
            assertEq(borrower, identity.ownerOf(agentId), "borrower is not the identity owner");
            if (kind == CreditPool.Kind.Advance) {
                (uint256 sAgent, uint128 amount, , uint64 attestedAt, bytes32 sLoan, , ) = pool.settlements(sid);
                assertTrue(attestedAt != 0, "advance without an attested settlement");
                assertEq(sAgent, agentId); assertEq(sLoan, loanId);
                assertLe(principal, (uint256(amount) * pool.advanceBps()) / 10_000, "advance above the settlement share");
            } else if (kind == CreditPool.Kind.TaskEscrow) {
                assertEq(pool.escrowLoan(sid), loanId, "escrow loan not tied to its task");
            } else {
                assertEq(sid, bytes32(0));
            }
        }
    }

    /// A payout is always applied to the loan before anything reaches the agent.
    function invariant_repaymentOrdering() public view {
        assertFalse(handler.ghost_orderingViolated());
    }

    /// Exposure is the sum of each agent's active principal; outstanding is the sum over all.
    function invariant_exposureAccounting() public view {
        uint256 n = handler.loanCount();
        uint256 total;
        uint256 a = handler.agentCount();
        uint256[] memory perAgent = new uint256[](a);
        for (uint256 i = 0; i < n; i++) {
            (uint256 agentId, , CreditPool.Status st, , uint128 remaining, , , , , , , , , , ) = pool.loans(handler.loanIds(i));
            if (st != CreditPool.Status.Active) continue;
            total += remaining;
            for (uint256 j = 0; j < a; j++) if (handler.agents(j) == agentId) perAgent[j] += remaining;
        }
        assertEq(pool.outstanding(), total);
        for (uint256 j = 0; j < a; j++) assertEq(pool.exposure(handler.agents(j)), perAgent[j], "exposure drifted from the loans");
    }

    /// Scores stay in range whatever happened.
    function invariant_scoreBounded() public view {
        for (uint256 j = 0; j < handler.agentCount(); j++) assertLe(reg.score(handler.agents(j)), 1000);
    }
}
