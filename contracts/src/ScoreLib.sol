// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ScoreLib: the Vouch credit score, a pure function of recorded events.
/// @notice Every input is an aggregate that the registry updates deterministically
/// from on-chain events, so anyone can replay the events and recompute the score.
/// There are no admin inputs. Amounts are USDG base units (6 decimals), times are
/// unix seconds. The same arithmetic is mirrored in src/credit/score.js and the
/// two are held equal by the vector test, so the engine and the chain agree.
///
/// Score (0..1000) = work + repayment + advances - slashes - dispute losses - defaults
///   work        <= 450  settled count (4 pts each, cap 200) + recency-weighted volume (1 pt per $4, cap 250)
///   repayment   <= 400  on-time loans 20 pts, late loans 8 pts, plus principal-days (1 pt per $10-day)
///   advances    <= 150  auto-deducted advances count less: 3 pts each + 1 pt per $40
///   slashes     <= 300  30 pts each + 1 pt per $2 slashed
///   disputes    <= 400  80 pts each + 1 pt per $1 lost
///   defaults    decays  each default adds 400 + 1 pt per $5 (cap 200), halving every 180 days;
///                       a recovery (late repayment of a defaulted loan) removes half of what it added
/// Recency-weighted volume halves every 30 days. Repaying never lowers the score and
/// defaulting never raises it: every repayment term is non-decreasing in its inputs
/// and every default term is non-increasing.
library ScoreLib {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant USDG = 1e6;
    uint256 internal constant MAX_SCORE = 1000;
    uint256 internal constant WORK_HALF_LIFE = 30 days;
    uint256 internal constant DEFAULT_HALF_LIFE = 180 days;

    struct Report {
        // verified work
        uint64 settledCount;
        uint128 settledVolume;
        uint128 recentVolume; // decayed, WORK_HALF_LIFE
        uint64 workUpdatedAt;
        // verification failures
        uint64 slashCount;
        uint128 slashedVolume;
        uint64 disputeLossCount;
        uint128 disputeLossVolume;
        // credit history
        uint64 loansRepaid;
        uint64 loansRepaidOnTime;
        uint128 repaidPrincipalDays; // sum of principal * whole days outstanding
        uint64 advancesRepaid;
        uint128 advancesRepaidVolume;
        uint64 defaults;
        uint128 defaultedVolume;
        uint128 defaultPenalty; // points * ONE, decayed, DEFAULT_HALF_LIFE
        uint64 defaultUpdatedAt;
        uint64 recoveries;
    }

    // ---- decay ---------------------------------------------------------------

    /// @dev 2^-(dt / halfLife) in ONE units: exact at whole half-lives, linear in between.
    function decayFactor(uint256 dt, uint256 halfLife) internal pure returns (uint256) {
        uint256 whole = dt / halfLife;
        if (whole >= 64) return 0;
        uint256 f = ONE >> whole;
        uint256 frac = ((dt % halfLife) * ONE) / halfLife; // 0..ONE
        return f - (f * frac) / (2 * ONE);
    }

    function decayed(uint256 value, uint256 updatedAt, uint256 nowTs, uint256 halfLife) internal pure returns (uint256) {
        if (nowTs <= updatedAt || value == 0) return value;
        return (value * decayFactor(nowTs - updatedAt, halfLife)) / ONE;
    }

    function defaultPoints(uint256 amount) internal pure returns (uint256) {
        return 400 + min(200, amount / (5 * USDG));
    }

    // ---- event application (deterministic, order-dependent only through timestamps) ----

    function addSettlement(Report storage r, uint128 amount, uint64 ts) internal {
        r.recentVolume = uint128(decayed(r.recentVolume, r.workUpdatedAt, ts, WORK_HALF_LIFE) + amount);
        r.workUpdatedAt = ts;
        r.settledCount += 1;
        r.settledVolume += amount;
    }

    function addSlash(Report storage r, uint128 amount) internal {
        r.slashCount += 1;
        r.slashedVolume += amount;
    }

    function addDisputeLoss(Report storage r, uint128 amount) internal {
        r.disputeLossCount += 1;
        r.disputeLossVolume += amount;
    }

    function addRepayment(Report storage r, uint128 principal, uint64 durationDays, bool onTime) internal {
        r.loansRepaid += 1;
        if (onTime) r.loansRepaidOnTime += 1;
        r.repaidPrincipalDays += uint128(uint256(principal) * durationDays);
    }

    function addAdvanceRepayment(Report storage r, uint128 amount) internal {
        r.advancesRepaid += 1;
        r.advancesRepaidVolume += amount;
    }

    function addDefault(Report storage r, uint128 amount, uint64 ts) internal {
        r.defaultPenalty = uint128(decayed(r.defaultPenalty, r.defaultUpdatedAt, ts, DEFAULT_HALF_LIFE) + defaultPoints(amount) * ONE);
        r.defaultUpdatedAt = ts;
        r.defaults += 1;
        r.defaultedVolume += amount;
    }

    /// @dev A defaulted loan repaid after the fact: half of that default's points come off, never below zero.
    function addRecovery(Report storage r, uint128 amount, uint64 ts) internal {
        uint256 current = decayed(r.defaultPenalty, r.defaultUpdatedAt, ts, DEFAULT_HALF_LIFE);
        uint256 relief = (defaultPoints(amount) * ONE) / 2;
        r.defaultPenalty = uint128(current > relief ? current - relief : 0);
        r.defaultUpdatedAt = ts;
        r.recoveries += 1;
    }

    // ---- the score -------------------------------------------------------------

    function workPoints(Report memory r, uint256 nowTs) internal pure returns (uint256) {
        uint256 recent = decayed(r.recentVolume, r.workUpdatedAt, nowTs, WORK_HALF_LIFE);
        return min(200, uint256(r.settledCount) * 4) + min(250, recent / (4 * USDG));
    }

    function repaymentPoints(Report memory r) internal pure returns (uint256) {
        uint256 late = r.loansRepaid - r.loansRepaidOnTime;
        return min(400, uint256(r.loansRepaidOnTime) * 20 + late * 8 + uint256(r.repaidPrincipalDays) / (10 * USDG));
    }

    function advancePoints(Report memory r) internal pure returns (uint256) {
        return min(150, uint256(r.advancesRepaid) * 3 + uint256(r.advancesRepaidVolume) / (40 * USDG));
    }

    function slashPenalty(Report memory r) internal pure returns (uint256) {
        return min(300, uint256(r.slashCount) * 30 + uint256(r.slashedVolume) / (2 * USDG));
    }

    function disputePenalty(Report memory r) internal pure returns (uint256) {
        return min(400, uint256(r.disputeLossCount) * 80 + uint256(r.disputeLossVolume) / USDG);
    }

    function defaultPenaltyNow(Report memory r, uint256 nowTs) internal pure returns (uint256) {
        return decayed(r.defaultPenalty, r.defaultUpdatedAt, nowTs, DEFAULT_HALF_LIFE) / ONE;
    }

    function score(Report memory r, uint256 nowTs) internal pure returns (uint256) {
        uint256 positive = workPoints(r, nowTs) + repaymentPoints(r) + advancePoints(r);
        uint256 negative = slashPenalty(r) + disputePenalty(r) + defaultPenaltyNow(r, nowTs);
        if (negative >= positive) return 0;
        return min(MAX_SCORE, positive - negative);
    }

    // ---- pricing from the score (used by the pool; pure, so anyone can check a quote) ----

    /// @dev Risk tier 0..3: 0 = no credit, 1 = thin, 2 = established, 3 = prime.
    function tier(uint256 s) internal pure returns (uint8) {
        if (s < 300) return 0;
        if (s < 550) return 1;
        if (s < 800) return 2;
        return 3;
    }

    /// @dev Fee per 30 days in basis points of principal, by tier. Tier 0 cannot borrow.
    function feeBps30d(uint256 s) internal pure returns (uint256) {
        uint8 t = tier(s);
        if (t == 0) return 0;
        if (t == 1) return 300;
        if (t == 2) return 200;
        return 100;
    }

    /// @dev Credit line in USDG base units: a base line by tier, grown by half the
    /// recency-weighted settlement volume, capped. Zero below tier 1.
    function creditLine(uint256 s, uint256 recentVolume, uint256 cap) internal pure returns (uint256) {
        uint8 t = tier(s);
        if (t == 0) return 0;
        uint256 base = t == 1 ? 25 * USDG : (t == 2 ? 100 * USDG : 200 * USDG);
        uint256 line = max(base, recentVolume / 2);
        return min(cap, line);
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
    function max(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a : b; }
}
