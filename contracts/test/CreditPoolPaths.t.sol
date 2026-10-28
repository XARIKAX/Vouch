// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {CreditRegistry} from "../src/CreditRegistry.sol";
import {ScoreLib} from "../src/ScoreLib.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/// @dev Phase 3 paths: task-escrow and stake loans, whose principal never leaves the pool.
contract CreditPoolPathsTest is Test {
    uint256 constant USDG = 1e6;
    uint64 constant T0 = 1_800_000_000;
    MockUSDG usdg;
    MockIdentityRegistry identity;
    CreditRegistry reg;
    CreditPool pool;
    address treasury = makeAddr("treasury");
    address lender = makeAddr("lender");
    address agentWallet = makeAddr("agent");
    address stranger = makeAddr("stranger");
    uint256 agentId;
    uint256 settlementN;

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        identity = new MockIdentityRegistry();
        reg = new CreditRegistry(IIdentityRegistry(address(identity)), address(this), 1000 * USDG);
        pool = new CreditPool(IERC20(address(usdg)), reg, address(this), treasury, 7000, 2000, 1000, uint128(5 * USDG), uint128(1000 * USDG), 8000, 3 days);
        reg.bindPool(address(pool));
        vm.prank(agentWallet);
        agentId = identity.register("ipfs://agent");
        usdg.mint(address(this), 1_000_000 * USDG);
        usdg.approve(address(pool), type(uint256).max);
        usdg.mint(lender, 1000 * USDG);
        vm.startPrank(lender);
        usdg.approve(address(pool), 1000 * USDG);
        pool.deposit(1000 * USDG);
        vm.stopPrank();
        for (uint256 i = 0; i < 50; i++) _attest(uint128(20 * USDG), 10 days); // score 450 → line $500
    }

    function _attest(uint128 amount, uint64 inSeconds) internal returns (bytes32 id) {
        id = keccak256(abi.encode("settlement", ++settlementN));
        pool.attestSettlement(agentId, id, amount, uint64(block.timestamp) + inSeconds);
    }

    function _solvent() internal view {
        assertEq(usdg.balanceOf(address(pool)), pool.lenderCash() + pool.reserve() + pool.protocolFees() + pool.escrowHeld() + pool.stakeHeld(), "solvency");
    }

    function _status(bytes32 loanId) internal view returns (CreditPool.Status st) {
        (, , st, , , , , , , , , , , , ) = pool.loans(loanId);
    }

    function _remaining(bytes32 loanId) internal view returns (uint128 r) {
        (, , , , r, , , , , , , , , , ) = pool.loans(loanId);
    }

    // ---- sizing -------------------------------------------------------------------------------

    function test_quoteLoanSizesByLineExposureMaxAndCash() public {
        (uint128 fee, uint16 feeBps, uint256 score, uint256 line, uint256 room) = pool.quoteLoan(agentId, uint128(100 * USDG), 30);
        assertEq(score, 450); assertEq(line, 500 * USDG); assertEq(room, 500 * USDG); assertEq(feeBps, 300);
        assertEq(fee, 3 * USDG, "$100 for 30 days at 300 bps");
        vm.expectRevert(); pool.quoteLoan(agentId, uint128(4 * USDG), 10);     // below the minimum
        vm.expectRevert(); pool.quoteLoan(agentId, uint128(600 * USDG), 10);   // above the room
        vm.expectRevert(); pool.quoteLoan(agentId, uint128(100 * USDG), 31);   // term too long
        vm.expectRevert(); pool.quoteLoan(agentId, uint128(100 * USDG), 0);
        pool.fundStake(agentId, uint128(300 * USDG), 10);
        (, , , , room) = pool.quoteLoan(agentId, uint128(100 * USDG), 10);
        assertEq(room, 200 * USDG, "exposure eats the room");
        vm.prank(agentWallet);
        uint256 other = identity.register("ipfs://other");
        vm.expectRevert(); pool.quoteLoan(other, uint128(10 * USDG), 10); // no credit
    }

    // ---- task escrow ----------------------------------------------------------------------------

    function test_escrowLoan_principalStays_settlesToTreasury_repaidFromProceeds() public {
        uint256 before = usdg.balanceOf(address(pool));
        vm.prank(agentWallet);
        bytes32 loanId = pool.fundTaskEscrow(agentId, "task-1", uint128(100 * USDG), 10);
        assertEq(usdg.balanceOf(address(pool)), before, "nothing left the contract");
        assertEq(usdg.balanceOf(agentWallet), 0);
        assertEq(pool.escrowHeld(), 100 * USDG); assertEq(pool.held(loanId), 100 * USDG);
        assertEq(pool.lenderCash(), 900 * USDG); assertEq(pool.outstanding(), 100 * USDG); assertEq(pool.exposure(agentId), 100 * USDG);
        assertEq(pool.escrowLoan("task-1"), loanId);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.EscrowTaken.selector, bytes32("task-1")));
        pool.fundTaskEscrow(agentId, "task-1", uint128(10 * USDG), 10);
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotBorrower.selector);
        pool.fundTaskEscrow(agentId, "task-2", uint128(10 * USDG), 10);
        _solvent();

        // the task settles: the ledger paid the provider, the held budget goes to the treasury (the attester)
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotAttester.selector);
        pool.settleTaskEscrow("task-1");
        uint256 attesterBefore = usdg.balanceOf(address(this));
        uint128 moved = pool.settleTaskEscrow("task-1");
        assertEq(moved, 100 * USDG); assertEq(usdg.balanceOf(address(this)) - attesterBefore, 100 * USDG);
        assertEq(pool.escrowHeld(), 0); assertEq(pool.held(loanId), 0);
        assertEq(_remaining(loanId), 100 * USDG, "the loan is still owed");
        vm.expectRevert(abi.encodeWithSelector(CreditPool.NothingHeld.selector, loanId));
        pool.settleTaskEscrow("task-1");
        _solvent();

        // the agent's next settlement repays it before the agent is paid: 100 + fee 1.00
        bytes32 sid = _attest(uint128(150 * USDG), 1 days);
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 101 * USDG); assertEq(forwarded, 49 * USDG);
        assertEq(usdg.balanceOf(agentWallet), 49 * USDG);
        assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Repaid));
        (ScoreLib.Report memory r, , , , , ) = reg.creditReport(agentId);
        assertEq(r.loansRepaid, 1); assertEq(r.loansRepaidOnTime, 1); assertEq(r.repaidPrincipalDays, 100 * USDG * 10);
        _solvent();
    }

    function test_escrowLoan_refundReturnsPrincipalToLenders_feeStillOwed() public {
        bytes32 loanId = pool.fundTaskEscrow(agentId, "task-1", uint128(100 * USDG), 10);
        uint128 back = pool.refundTaskEscrow("task-1");
        assertEq(back, 100 * USDG);
        assertEq(pool.lenderCash(), 1000 * USDG); assertEq(pool.outstanding(), 0); assertEq(pool.exposure(agentId), 0);
        assertEq(_remaining(loanId), 0); assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Active), "the fee is still owed");
        assertEq(pool.owedOn(loanId), 1 * USDG);
        pool.repay(loanId, uint128(1 * USDG));
        assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Repaid));
        assertEq(pool.reserve(), 200_000); // 20% of $1
        _solvent();
    }

    function test_escrowLoan_defaultWithHeldPrincipalLosesNothing() public {
        bytes32 loanId = pool.fundTaskEscrow(agentId, "task-1", uint128(100 * USDG), 10);
        uint256 assets = pool.lenderAssets();
        vm.warp(block.timestamp + 13 days + 1);
        pool.markDefault(loanId);
        assertEq(pool.lenderAssets(), assets, "held principal came back; only the fee was unpaid");
        assertEq(pool.escrowHeld(), 0); assertEq(pool.outstanding(), 0);
        assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Defaulted));
        (ScoreLib.Report memory r, , , , , ) = reg.creditReport(agentId);
        assertEq(r.defaults, 1); assertEq(r.defaultedVolume, 0, "a default on the fee alone");
        _solvent();
    }

    function test_escrowLoan_settledThenDefaulted_reserveFirst() public {
        pool.fundReserve(50 * USDG);
        bytes32 loanId = pool.fundTaskEscrow(agentId, "task-1", uint128(100 * USDG), 10);
        pool.settleTaskEscrow("task-1"); // the money is gone to the provider
        uint256 assets = pool.lenderAssets();
        vm.warp(block.timestamp + 13 days + 1);
        pool.markDefault(loanId);
        assertEq(pool.reserve(), 0);
        assertEq(pool.lenderAssets(), assets - 50 * USDG, "lenders lose only what the reserve could not cover");
        _solvent();
    }

    // ---- stake -----------------------------------------------------------------------------------------

    function test_stakeLoan_heldAsCollateral_slashedToTreasury_releasedRepays() public {
        vm.prank(agentWallet);
        bytes32 loanId = pool.fundStake(agentId, uint128(200 * USDG), 20);
        assertEq(pool.stakeHeld(), 200 * USDG); assertEq(usdg.balanceOf(agentWallet), 0, "nothing reaches the wallet");
        assertEq(pool.lenderCash(), 800 * USDG); assertEq(pool.exposure(agentId), 200 * USDG);
        _solvent();

        // a slash seizes from the held stake to the treasury; the agent still owes it
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotAttester.selector);
        pool.slashHeldStake(loanId, uint128(30 * USDG));
        uint256 attesterBefore = usdg.balanceOf(address(this));
        pool.slashHeldStake(loanId, uint128(30 * USDG));
        assertEq(usdg.balanceOf(address(this)) - attesterBefore, 30 * USDG);
        assertEq(pool.held(loanId), 170 * USDG); assertEq(pool.stakeHeld(), 170 * USDG);
        assertEq(_remaining(loanId), 200 * USDG, "the loan is still owed in full");
        vm.expectRevert(CreditPool.BadAmount.selector);
        pool.slashHeldStake(loanId, uint128(171 * USDG));
        _solvent();

        // releasing the stake repays principal; the fee is still owed
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotBorrower.selector);
        pool.releaseStake(loanId, uint128(170 * USDG));
        vm.prank(agentWallet);
        uint128 released = pool.releaseStake(loanId, uint128(1000 * USDG));
        assertEq(released, 170 * USDG);
        assertEq(pool.stakeHeld(), 0); assertEq(_remaining(loanId), 30 * USDG);
        assertEq(pool.lenderCash(), 970 * USDG);
        assertEq(pool.owedOn(loanId), 30 * USDG + 4 * USDG, "$30 of slashed principal plus the $4 fee (200 at 300 bps for 20 days)");
        _solvent();

        // the rest comes out of the agent's proceeds
        bytes32 sid = _attest(uint128(100 * USDG), 1 days);
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 34 * USDG); assertEq(forwarded, 66 * USDG);
        assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Repaid));
        _solvent();
    }

    function test_stakeLoan_defaultRecoversHeldFirst() public {
        bytes32 loanId = pool.fundStake(agentId, uint128(200 * USDG), 10);
        pool.slashHeldStake(loanId, uint128(50 * USDG)); // $150 still held, $200 owed
        uint256 assets = pool.lenderAssets();
        vm.warp(block.timestamp + 13 days + 1);
        pool.markDefault(loanId);
        assertEq(pool.stakeHeld(), 0);
        assertEq(pool.lenderAssets(), assets - 50 * USDG, "only the slashed part is a loss (no reserve)");
        (, , , , , , , , , , , , , uint128 cov, uint128 loss) = pool.loans(loanId);
        assertEq(cov, 0); assertEq(loss, 50 * USDG);
        // recovery: the agent repays the $50 and the fee
        pool.repay(loanId, pool.owedOn(loanId));
        assertEq(uint8(_status(loanId)), uint8(CreditPool.Status.Recovered));
        assertEq(pool.lenderAssets(), assets + 1_400_000, "made whole, plus 70% of the $2 fee");
        _solvent();
    }

    // ---- interception across paths -------------------------------------------------------------------------

    function test_proceedsRepayEveryOpenLoan_oldestFirst() public {
        bytes32 stake = pool.fundStake(agentId, uint128(100 * USDG), 10);        // owes 100 + 1
        bytes32 escrow = pool.fundTaskEscrow(agentId, "t", uint128(100 * USDG), 10); // owes 100 + 1
        pool.settleTaskEscrow("t");
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 adv = pool.advance(agentId, sid);                                     // 80 + 0.80, tied to sid
        // proceeds of $100: the tied advance first (80.80), then the stake loan's fee ($1, its principal
        // is still held here and is never paid twice), then $18.20 off the escrow loan; nothing is left
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 100 * USDG); assertEq(forwarded, 0);
        assertEq(uint8(_status(adv)), uint8(CreditPool.Status.Repaid));
        assertEq(_remaining(stake), 100 * USDG); assertEq(pool.owedOn(stake), 0, "held stake, fee paid: nothing owed in cash");
        assertEq(_remaining(escrow), 100 * USDG - 18_200_000);
        // a second settlement finishes the escrow loan; the stake loan is untouched
        bytes32 sid2 = _attest(uint128(100 * USDG), 10 days);
        (repaid, forwarded) = pool.settleProceeds(sid2);
        assertEq(repaid, 82_800_000); assertEq(forwarded, 17_200_000);
        assertEq(uint8(_status(escrow)), uint8(CreditPool.Status.Repaid));
        assertEq(uint8(_status(stake)), uint8(CreditPool.Status.Active));
        assertEq(pool.stakeHeld(), 100 * USDG);
        _solvent();
    }
}
