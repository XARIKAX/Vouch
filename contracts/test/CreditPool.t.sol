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

contract CreditPoolTest is Test {
    uint256 constant USDG = 1e6;
    uint64 constant T0 = 1_800_000_000;
    MockUSDG usdg;
    MockIdentityRegistry identity;
    CreditRegistry reg;
    CreditPool pool;
    address treasury = makeAddr("treasury");
    address lender = makeAddr("lender");
    address lender2 = makeAddr("lender2");
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
    }

    // ---- helpers -----------------------------------------------------------------------

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        shares = pool.deposit(amount);
        vm.stopPrank();
    }

    function _attest(uint128 amount, uint64 inSeconds) internal returns (bytes32 id) {
        id = keccak256(abi.encode("settlement", ++settlementN));
        pool.attestSettlement(agentId, id, amount, uint64(block.timestamp) + inSeconds);
    }

    /// @dev 50 settlements of $20 → score 450, tier 1, line $500 (half the $1,000 recent volume).
    function _earnScore() internal {
        for (uint256 i = 0; i < 50; i++) _attest(uint128(20 * USDG), 1 days);
        assertGe(reg.score(agentId), 450);
    }

    function _solvent() internal view {
        assertEq(usdg.balanceOf(address(pool)), pool.lenderCash() + pool.reserve() + pool.protocolFees(), "solvency");
    }

    // ---- construction ---------------------------------------------------------------------

    function test_constructorChecks() public {
        vm.expectRevert(CreditPool.BadSplit.selector);
        new CreditPool(IERC20(address(usdg)), reg, address(this), treasury, 7000, 2000, 2000, 1, 1, 8000, 0);
        vm.expectRevert(CreditPool.BadAmount.selector);
        new CreditPool(IERC20(address(usdg)), reg, address(this), treasury, 7000, 2000, 1000, 10, 1, 8000, 0);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        new CreditPool(IERC20(address(usdg)), reg, address(0), treasury, 7000, 2000, 1000, 1, 1, 8000, 0);
        assertEq(address(pool.identity()), address(identity));
        assertEq(pool.graceSeconds(), 3 days);
    }

    // ---- lenders ----------------------------------------------------------------------------

    function test_depositWithdrawSharesTrackAssets() public {
        uint256 s1 = _deposit(lender, 1000 * USDG);
        assertEq(s1, 1000 * USDG, "first depositor gets 1:1 shares");
        assertEq(pool.lenderAssets(), 1000 * USDG);
        // fees accrue to lenders: simulate by booking a repaid advance
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 loanId = pool.advance(agentId, sid);
        (, , , , , uint128 fee, , , , , , , , , ) = pool.loans(loanId);
        assertEq(fee, 800_000, "$80 at 300 bps per 30 days for 10 days = $0.80");
        pool.settleProceeds(sid);
        assertEq(pool.lenderAssets(), 1000 * USDG + (fee * 7000) / 10_000);
        uint256 s2 = _deposit(lender2, 1000 * USDG);
        assertLt(s2, s1, "a later depositor pays the higher share price");
        vm.prank(lender);
        uint256 got = pool.withdraw(s1);
        assertGt(got, 1000 * USDG, "the first lender leaves with principal plus its share of fees");
        _solvent();
    }

    function test_withdrawIsLimitedToCashOnHand() public {
        uint256 s = _deposit(lender, 100 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        pool.advance(agentId, sid); // $80 lent out
        vm.prank(lender);
        vm.expectRevert(CreditPool.InsufficientLiquidity.selector);
        pool.withdraw(s);
        vm.prank(lender);
        pool.withdraw(s / 5); // $20 of cash is there
        vm.prank(lender);
        vm.expectRevert(CreditPool.BadAmount.selector);
        pool.withdraw(s); // more than held
        _solvent();
    }

    function test_protocolFeesOnlyToTreasury() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        pool.advance(agentId, sid);
        pool.settleProceeds(sid);
        assertEq(pool.protocolFees(), 80_000); // 10% of $0.80
        vm.expectRevert(CreditPool.NotTreasury.selector);
        pool.withdrawProtocolFees(stranger);
        vm.prank(treasury);
        pool.withdrawProtocolFees(treasury);
        assertEq(usdg.balanceOf(treasury), 80_000);
        assertEq(pool.reserve(), 160_000); // 20%
        _solvent();
    }

    // ---- attestations -------------------------------------------------------------------------

    function test_attestIsAttesterOnly_recordedOnceInBothPlaces() public {
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotAttester.selector);
        pool.attestSettlement(agentId, "s", 1, uint64(block.timestamp + 1));
        bytes32 sid = _attest(uint128(100 * USDG), 1 days);
        assertEq(reg.score(agentId), 4 + 25, "the registry saw the settlement in the same transaction");
        vm.expectRevert(abi.encodeWithSelector(CreditPool.AlreadyAttested.selector, sid));
        pool.attestSettlement(agentId, sid, 1, uint64(block.timestamp + 1));
        vm.expectRevert(abi.encodeWithSelector(CreditRegistry.UnknownAgent.selector, 99));
        pool.attestSettlement(99, "x", 1, uint64(block.timestamp + 1));
    }

    // ---- advances ------------------------------------------------------------------------------

    function test_advanceNeedsCredit_isCappedByShareLineLiquidityAndMax() public {
        _deposit(lender, 1000 * USDG);
        bytes32 s0 = _attest(uint128(100 * USDG), 10 days);
        vm.expectRevert(); // NoCredit: one $100 settlement scores 29, below tier 1
        pool.advance(agentId, s0);
        _earnScore(); // score 450 → line $500
        bytes32 s1 = _attest(uint128(100 * USDG), 10 days);
        (uint128 principal, uint128 fee, uint16 termDays, uint16 feeBps, uint256 score, uint256 line) = pool.quoteAdvance(agentId, s1);
        assertEq(principal, 80 * USDG, "80% of the settlement");
        assertEq(termDays, 10); assertEq(feeBps, 300); assertEq(score, 450, "both work terms are capped"); assertEq(line, (1000 + 100 + 100) * USDG / 2);
        assertEq(fee, 800_000);
        // the line caps a big settlement
        bytes32 s2 = _attest(uint128(2000 * USDG), 10 days);
        (principal, , , , , line) = pool.quoteAdvance(agentId, s2);
        assertEq(principal, _min(line, 1000 * USDG), "min(line, maxLoan)");
        // liquidity caps it too
        uint256 held = pool.shares(lender);
        vm.prank(lender);
        pool.withdraw(held - 50 * USDG);
        (principal, , , , , ) = pool.quoteAdvance(agentId, s2);
        assertEq(principal, 50 * USDG, "only the cash on hand");
        _deposit(lender, 1000 * USDG);
        bytes32 loan = pool.advance(agentId, s2);
        assertEq(pool.exposure(agentId), _min(line, 1000 * USDG));
        // exposure eats the room: the next advance is smaller or refused
        bytes32 s3 = _attest(uint128(2000 * USDG), 10 days);
        vm.expectRevert(); // BelowMinimum: the line is used up
        pool.quoteAdvance(agentId, s3);
        _solvent();
    }

    function test_advanceGoesToTheIdentityOwner_onlyOwnerOrAttesterMayDraw() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        vm.prank(stranger);
        vm.expectRevert(CreditPool.NotBorrower.selector);
        pool.advance(agentId, sid);
        vm.prank(agentWallet);
        bytes32 loanId = pool.advance(agentId, sid);
        assertEq(usdg.balanceOf(agentWallet), 80 * USDG, "the advance lands with the identity owner");
        (, , CreditPool.Status status, , , , , , uint64 dueAt, , , bytes32 settlementId, address borrower, , ) = pool.loans(loanId);
        assertEq(uint8(status), uint8(CreditPool.Status.Active)); assertEq(dueAt, uint64(block.timestamp + 10 days)); assertEq(settlementId, sid); assertEq(borrower, agentWallet);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.SettlementAlreadyAdvanced.selector, sid));
        pool.advance(agentId, sid);
        assertEq(pool.loansOf(agentId).length, 1);
        _solvent();
    }

    function test_termBounds() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 tooLong = _attest(uint128(100 * USDG), 31 days);
        vm.expectRevert();
        pool.quoteAdvance(agentId, tooLong);
        bytes32 past = _attest(uint128(100 * USDG), 0);
        vm.expectRevert();
        pool.quoteAdvance(agentId, past);
        bytes32 short = _attest(uint128(100 * USDG), 1);
        (, uint128 fee, uint16 termDays, , , ) = pool.quoteAdvance(agentId, short);
        assertEq(termDays, 1, "a second rounds up to a day"); assertEq(fee, 80_000);
    }

    // ---- repayment interception ----------------------------------------------------------------------

    function test_proceedsRepayBeforeTheAgentSeesThem() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 loanId = pool.advance(agentId, sid);
        uint256 before = usdg.balanceOf(agentWallet);
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 80 * USDG + 800_000); assertEq(forwarded, 100 * USDG - repaid);
        assertEq(usdg.balanceOf(agentWallet) - before, forwarded, "the agent gets only the remainder");
        (, , CreditPool.Status status, , uint128 remaining, , uint128 feePaid, , , , , , , , ) = pool.loans(loanId);
        assertEq(uint8(status), uint8(CreditPool.Status.Repaid)); assertEq(remaining, 0); assertEq(feePaid, 800_000);
        assertEq(pool.exposure(agentId), 0); assertEq(pool.outstanding(), 0);
        (ScoreLib.Report memory r, , , , , ) = reg.creditReport(agentId);
        assertEq(r.advancesRepaid, 1); assertEq(r.advancesRepaidVolume, 80 * USDG);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.SettlementClosed.selector, sid));
        pool.settleProceeds(sid);
        _solvent();
    }

    function test_proceedsWithoutAnAdvanceGoWholeToTheAgent() public {
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 0); assertEq(forwarded, 100 * USDG); assertEq(usdg.balanceOf(agentWallet), 100 * USDG);
    }

    function test_manualRepayPrincipalFirst_anyPayer() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 loanId = pool.advance(agentId, sid);
        usdg.mint(stranger, 100 * USDG);
        vm.startPrank(stranger);
        usdg.approve(address(pool), type(uint256).max);
        uint128 applied = pool.repay(loanId, uint128(30 * USDG));
        assertEq(applied, 30 * USDG);
        (, , , , uint128 remaining, , uint128 feePaid, , , , , , , , ) = pool.loans(loanId);
        assertEq(remaining, 50 * USDG); assertEq(feePaid, 0, "principal first");
        assertEq(pool.exposure(agentId), 50 * USDG);
        applied = pool.repay(loanId, uint128(1000 * USDG)); // overpayment is clipped to what is owed
        assertEq(applied, 50 * USDG + 800_000);
        vm.stopPrank();
        (, , CreditPool.Status status, , , , , , , , , , , , ) = pool.loans(loanId);
        assertEq(uint8(status), uint8(CreditPool.Status.Repaid));
        assertEq(usdg.balanceOf(stranger), 100 * USDG - 80 * USDG - 800_000);
        // the settlement still pays out in full afterwards
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 0); assertEq(forwarded, 100 * USDG);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.LoanNotActive.selector, loanId));
        pool.repay(loanId, 1);
        _solvent();
    }

    // ---- defaults: the multi-default suite ---------------------------------------------------------------

    function test_defaultNeedsDuePlusGrace_onceOnly() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 loanId = pool.advance(agentId, sid);
        vm.expectRevert();
        pool.markDefault(loanId);
        vm.warp(block.timestamp + 10 days + 3 days);
        vm.expectRevert();
        pool.markDefault(loanId); // exactly at the edge: not yet
        vm.warp(block.timestamp + 1);
        assertTrue(pool.isOverdue(loanId));
        vm.prank(stranger);
        pool.markDefault(loanId);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.LoanNotActive.selector, loanId));
        pool.markDefault(loanId);
    }

    /// @dev The test Priors failed: several loans per agent, several defaults. Each default
    /// releases its own loan's exposure only, the reserve absorbs losses before lender
    /// principal, the surviving loan stays owed and repayable, and recoveries refill the
    /// reserve and the lenders in that order.
    function test_multiDefault_reserveFirst_exposurePerLoan_recovery() public {
        _deposit(lender, 1000 * USDG);
        pool.fundReserve(100 * USDG);
        _earnScore();
        bytes32[3] memory sids;
        bytes32[3] memory loanIds;
        for (uint256 i = 0; i < 3; i++) {
            sids[i] = _attest(uint128(100 * USDG), 10 days);
            loanIds[i] = pool.advance(agentId, sids[i]);
        }
        assertEq(pool.exposure(agentId), 240 * USDG); assertEq(pool.outstanding(), 240 * USDG);
        uint256 lenderAssets0 = pool.lenderAssets();
        assertEq(lenderAssets0, 1000 * USDG);
        pool.voidSettlement(sids[0]);
        pool.voidSettlement(sids[1]);
        vm.warp(block.timestamp + 13 days + 1);

        // default 1: fully absorbed by the reserve
        pool.markDefault(loanIds[0]);
        assertEq(pool.reserve(), 20 * USDG);
        assertEq(pool.lenderAssets(), lenderAssets0, "lender principal untouched while the reserve covers");
        assertEq(pool.exposure(agentId), 160 * USDG, "only the defaulted loan's exposure is released");
        assertEq(pool.outstanding(), 160 * USDG);

        // default 2: the reserve runs out; lenders absorb only the uncovered part
        pool.markDefault(loanIds[1]);
        assertEq(pool.reserve(), 0);
        assertEq(pool.lenderAssets(), lenderAssets0 - 60 * USDG, "lenders lose exactly what the reserve could not cover");
        assertEq(pool.exposure(agentId), 80 * USDG, "the third loan is still owed");
        (, , CreditPool.Status st1, , , , , , , , , , , uint128 cov1, uint128 loss1) = pool.loans(loanIds[1]);
        assertEq(uint8(st1), uint8(CreditPool.Status.Defaulted)); assertEq(cov1, 20 * USDG); assertEq(loss1, 60 * USDG);

        // the score priced both defaults; the identity is not dead
        (ScoreLib.Report memory r, uint256 score, , , , ) = reg.creditReport(agentId);
        assertEq(r.defaults, 2); assertEq(score, 0);

        // the third loan repays through its settlement as if nothing happened
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sids[2]);
        assertEq(repaid, 80 * USDG + 800_000); assertEq(forwarded, 100 * USDG - repaid);
        assertEq(pool.exposure(agentId), 0); assertEq(pool.outstanding(), 0);

        // recovery of loan 2: the reserve is refilled first, then the lenders
        uint128 owed = pool.owedOn(loanIds[1]);
        assertEq(owed, 80 * USDG + 800_000);
        pool.repay(loanIds[1], uint128(20 * USDG));
        assertEq(pool.reserve(), 20 * USDG + 160_000, "the fee share from loan 3 and the refill");
        assertEq(pool.lenderAssets(), lenderAssets0 - 60 * USDG + 560_000, "still short the lender loss, plus loan 3's fee share");
        pool.repay(loanIds[1], owed - uint128(20 * USDG));
        assertEq(pool.lenderAssets(), lenderAssets0 + 2 * 560_000, "lenders are made whole, with two fees' worth of yield");
        (, , CreditPool.Status st1b, , , , , , , , , , , , ) = pool.loans(loanIds[1]);
        assertEq(uint8(st1b), uint8(CreditPool.Status.Recovered));
        (r, , , , , ) = reg.creditReport(agentId);
        assertEq(r.recoveries, 1); assertEq(r.advancesRepaid, 1);
        // recovery of loan 1 via its settlement would be void; pay it by hand
        pool.repay(loanIds[0], pool.owedOn(loanIds[0]));
        assertEq(pool.reserve(), 100 * USDG + 3 * 160_000, "the reserve is back to its seed plus three fee shares");
        (, , CreditPool.Status st0, , , , , , , , , , , , ) = pool.loans(loanIds[0]);
        assertEq(uint8(st0), uint8(CreditPool.Status.Recovered));
        _solvent();
    }

    function test_lateProceedsOnADefaultedLoanAreARecovery() public {
        _deposit(lender, 1000 * USDG);
        _earnScore();
        bytes32 sid = _attest(uint128(100 * USDG), 10 days);
        bytes32 loanId = pool.advance(agentId, sid);
        vm.warp(block.timestamp + 13 days + 1);
        pool.markDefault(loanId);
        assertEq(pool.lenderAssets(), 1000 * USDG - 80 * USDG);
        (uint128 repaid, uint128 forwarded) = pool.settleProceeds(sid);
        assertEq(repaid, 80 * USDG + 800_000); assertEq(forwarded, 100 * USDG - repaid);
        assertEq(pool.lenderAssets(), 1000 * USDG + 560_000);
        (, , CreditPool.Status st, , , , , , , , , , , , ) = pool.loans(loanId);
        assertEq(uint8(st), uint8(CreditPool.Status.Recovered));
        _solvent();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
}
