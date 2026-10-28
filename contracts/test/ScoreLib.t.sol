// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ScoreLib} from "../src/ScoreLib.sol";

/// @dev A storage holder so the library's storage-mutating functions can be exercised.
contract ReportHolder {
    using ScoreLib for ScoreLib.Report;
    ScoreLib.Report public r;

    function settle(uint128 a, uint64 ts) external { r.addSettlement(a, ts); }
    function slash(uint128 a) external { r.addSlash(a); }
    function dispute(uint128 a) external { r.addDisputeLoss(a); }
    function repay(uint128 p, uint64 d, bool onTime) external { r.addRepayment(p, d, onTime); }
    function advance(uint128 a) external { r.addAdvanceRepayment(a); }
    function dflt(uint128 a, uint64 ts) external { r.addDefault(a, ts); }
    function recover(uint128 a, uint64 ts) external { r.addRecovery(a, ts); }
    function score(uint256 nowTs) external view returns (uint256) { return r.score(nowTs); }
    function get() external view returns (ScoreLib.Report memory) { return r; }
}

contract ScoreLibTest is Test {
    uint256 constant USDG = 1e6;
    uint64 constant T0 = 1_800_000_000;
    ReportHolder h;

    function setUp() public { h = new ReportHolder(); }

    // ---- decay ------------------------------------------------------------------

    function test_decayFactor_exactAtHalfLives() public pure {
        assertEq(ScoreLib.decayFactor(0, 30 days), 1e18);
        assertEq(ScoreLib.decayFactor(30 days, 30 days), 5e17);
        assertEq(ScoreLib.decayFactor(60 days, 30 days), 25e16);
        assertEq(ScoreLib.decayFactor(15 days, 30 days), 75e16, "linear halfway");
        assertEq(ScoreLib.decayFactor(64 * 30 days, 30 days), 0);
    }

    function testFuzz_decayFactor_monotoneAndBounded(uint256 a, uint256 b) public pure {
        a = bound(a, 0, 100 * 365 days);
        b = bound(b, 0, 100 * 365 days);
        if (a > b) (a, b) = (b, a);
        uint256 fa = ScoreLib.decayFactor(a, 30 days);
        uint256 fb = ScoreLib.decayFactor(b, 30 days);
        assertLe(fa, 1e18);
        assertGe(fa, fb, "later is never larger");
    }

    // ---- worked examples --------------------------------------------------------

    function test_freshAgentScoresZero() public view {
        assertEq(h.score(T0), 0);
        assertEq(ScoreLib.tier(0), 0);
        assertEq(ScoreLib.feeBps30d(0), 0);
        assertEq(ScoreLib.creditLine(0, 1_000_000 * USDG, 1000 * USDG), 0, "no line below tier 1");
    }

    function test_workOnlyAgent() public {
        // 50 settlements of $20 = $1,000 recent volume: 50*4 = 200 + 1000/4 = 250 → 450
        for (uint256 i = 0; i < 50; i++) h.settle(uint128(20 * USDG), T0);
        assertEq(h.score(T0), 450);
        // 30 days later the volume term halved: 200 + 125
        assertEq(h.score(T0 + 30 days), 325);
        // far in the future only the count term remains
        assertEq(h.score(T0 + 100 * 365 days), 200);
    }

    function test_repaymentAndAdvanceTerms() public {
        h.repay(uint128(100 * USDG), 10, true);  // 20 + 100*10/10 = 120
        assertEq(h.score(T0), 120);
        h.repay(uint128(50 * USDG), 4, false);   // + 8 + 20 = 148
        assertEq(h.score(T0), 148);
        h.advance(uint128(80 * USDG));           // + 3 + 2 = 153
        assertEq(h.score(T0), 153);
    }

    function test_defaultCratersAndDecays_recoveryHalves() public {
        for (uint256 i = 0; i < 50; i++) h.settle(uint128(20 * USDG), T0);
        h.repay(uint128(200 * USDG), 20, true); // 450 + min(400, 20 + 400) = 850
        assertEq(h.score(T0), 850);
        h.dflt(uint128(100 * USDG), T0);        // -(400 + 20) = 430
        assertEq(h.score(T0), 430);
        // 180 days on: recent volume is 1000/64 = $15.6 → 3 pts, so work = 203, repayment 400, penalty 420/2 = 210
        assertEq(h.score(T0 + 180 days), 603 - 210, "half the penalty gone after 180 days");
        h.recover(uint128(100 * USDG), T0 + 180 days); // 210 - 210 = 0 penalty
        assertEq(h.score(T0 + 180 days), 603);
        assertEq(h.get().recoveries, 1);
    }

    function test_slashAndDisputePenalties() public {
        for (uint256 i = 0; i < 50; i++) h.settle(uint128(20 * USDG), T0);
        h.slash(uint128(10 * USDG));     // 30 + 5
        assertEq(h.score(T0), 450 - 35);
        h.dispute(uint128(10 * USDG));   // 80 + 10
        assertEq(h.score(T0), 450 - 35 - 90);
    }

    function test_pricing() public pure {
        assertEq(ScoreLib.tier(299), 0); assertEq(ScoreLib.tier(300), 1); assertEq(ScoreLib.tier(550), 2); assertEq(ScoreLib.tier(800), 3);
        assertEq(ScoreLib.feeBps30d(300), 300); assertEq(ScoreLib.feeBps30d(600), 200); assertEq(ScoreLib.feeBps30d(900), 100);
        assertEq(ScoreLib.creditLine(300, 0, 1000 * USDG), 25 * USDG);
        assertEq(ScoreLib.creditLine(600, 0, 1000 * USDG), 100 * USDG);
        assertEq(ScoreLib.creditLine(850, 0, 1000 * USDG), 200 * USDG);
        assertEq(ScoreLib.creditLine(850, 600 * USDG, 1000 * USDG), 300 * USDG, "half the recent volume");
        assertEq(ScoreLib.creditLine(850, 5000 * USDG, 1000 * USDG), 1000 * USDG, "capped");
    }

    // ---- invariants over random histories -------------------------------------------

    function _randomHistory(uint256 seed, uint64 ts) internal {
        uint256 n = seed % 12;
        for (uint256 i = 0; i < n; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint128 amt = uint128(r % (2000 * USDG));
            uint256 kind = (r >> 128) % 7;
            if (kind == 0) h.settle(amt, ts);
            else if (kind == 1) h.slash(amt);
            else if (kind == 2) h.dispute(amt);
            else if (kind == 3) h.repay(amt, uint64((r >> 200) % 31), r % 2 == 0);
            else if (kind == 4) h.advance(amt);
            else if (kind == 5) h.dflt(amt, ts);
            else h.recover(amt, ts);
        }
    }

    function testFuzz_scoreBounded(uint256 seed, uint64 dt) public {
        _randomHistory(seed, T0);
        uint256 s = h.score(T0 + bound(dt, 0, 3650 days));
        assertLe(s, 1000);
    }

    function testFuzz_repayingNeverLowers(uint256 seed, uint128 principal, uint64 durationDays, bool onTime) public {
        _randomHistory(seed, T0);
        principal = uint128(bound(principal, 0, 1000 * USDG));
        durationDays = uint64(bound(durationDays, 0, 30));
        uint256 before = h.score(T0 + 1);
        h.repay(principal, durationDays, onTime);
        assertGe(h.score(T0 + 1), before);
    }

    function testFuzz_advanceRepaymentNeverLowers(uint256 seed, uint128 amount) public {
        _randomHistory(seed, T0);
        amount = uint128(bound(amount, 0, 1000 * USDG));
        uint256 before = h.score(T0 + 1);
        h.advance(amount);
        assertGe(h.score(T0 + 1), before);
    }

    function testFuzz_recoveryNeverLowers(uint256 seed, uint128 amount) public {
        _randomHistory(seed, T0);
        amount = uint128(bound(amount, 0, 1000 * USDG));
        uint256 before = h.score(T0 + 1);
        h.recover(amount, T0 + 1);
        assertGe(h.score(T0 + 1), before);
    }

    function testFuzz_defaultingNeverRaises(uint256 seed, uint128 amount, uint64 dt) public {
        _randomHistory(seed, T0);
        amount = uint128(bound(amount, 0, 1000 * USDG));
        uint64 at = T0 + uint64(bound(dt, 0, 365 days));
        uint256 before = h.score(at);
        h.dflt(amount, at);
        assertLe(h.score(at), before);
    }

    function testFuzz_slashOrDisputeNeverRaises(uint256 seed, uint128 amount, bool dispute) public {
        _randomHistory(seed, T0);
        amount = uint128(bound(amount, 0, 1000 * USDG));
        uint256 before = h.score(T0 + 1);
        if (dispute) h.dispute(amount); else h.slash(amount);
        assertLe(h.score(T0 + 1), before);
    }

    function testFuzz_verifiedWorkNeverLowers(uint256 seed, uint128 amount, uint64 dt) public {
        _randomHistory(seed, T0);
        amount = uint128(bound(amount, 0, 1000 * USDG));
        uint64 at = T0 + uint64(bound(dt, 0, 365 days));
        uint256 before = h.score(at);
        h.settle(amount, at);
        assertGe(h.score(at), before);
    }
}
