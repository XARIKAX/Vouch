// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentBondVault
/// @notice The launchpad's on-chain risk layer. Holds a launched agent's bond —
///         denominated in its platform token — and governs how that bond backs
///         quotes and absorbs slashes. The engine (src/engine.js) runs the
///         sandbox version of this immediately and in-memory; this contract is
///         the custody + risk home for a real deployment, where slashes carry
///         value and therefore must be capped, delayed, and pausable.
///
/// It mirrors the pure math in src/launchpad.js exactly (bond valuation after
/// haircut, capacity = haircut / reservationMultiple, per-verdict and rolling
/// slash caps) and the parameters in src/launchpad-config.js. Verification still
/// happens off-chain; a verdict only moves value here when signed by the Vouch
/// verifier oracle, exactly like VouchEscrow.
///
/// Trust model is staged like VouchEscrow: v1 a single verifier key + a guardian
/// that can pause; later an M-of-N attestation set. This is v1.
///
/// Deploy-time wiring (the "AgentLauncher" flow, done off this contract):
///   1. mint the agent token, pair it with the platform token in a locked pool,
///   2. point this vault at that pool's PriceOracle,
///   3. route the pool's swap fee into harvest() (bond/operating/creator/treasury).

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice TWAP price of one agent token in USDG, plus the pool's current USDG
///         liquidity. Below the liquidity floor the bond is worth nothing for
///         capacity (a thin pool can't be sold into without crashing it).
interface IPriceOracle {
    function twapUsdg(address token) external view returns (uint256);        // 1e6-scaled USDG
    function poolLiquidityUsdg(address token) external view returns (uint256); // 1e6-scaled USDG
}

contract AgentBondVault {
    // ---- immutable risk parameters (snapshot of LAUNCHPAD_DEFAULTS) ----------
    // Shares and fractions are expressed in basis points (1e4 = 100%).
    uint256 public constant BPS = 10_000;
    uint256 public immutable bondHaircutBps;        // 5000 = count token bond at 50%
    uint256 public immutable reservationMultipleBps; // 20000 = reserve 200% of price
    uint256 public immutable liquidityFloorUsdg;    // below this, capacity = 0
    uint256 public immutable unbondingCooldown;     // seconds
    uint256 public immutable maxSlashMultipleBps;   // 20000 = a verdict never exceeds 200% of price
    uint256 public immutable rollingSlashCapBps;    // 2000 = max 20% of bond value per window
    uint256 public immutable rollingSlashWindow;    // seconds
    uint256 public immutable pendingSlashDelay;     // seconds a slash waits before funds move

    IERC20       public immutable platformToken;    // the bond asset
    IPriceOracle public immutable oracle;
    address      public verifier;                   // signs slash verdicts
    address      public owner;
    address      public guardian;                   // can pause execution in an emergency
    bool         public paused;
    uint256      public insurancePool;              // executed slashes accrue here (in token units)

    struct Agent {
        address wallet;        // the agent owner
        address token;         // this agent's platform token (for the oracle)
        uint256 bond;          // bonded token quantity
        uint256 reserved;      // haircut-USDG reserved by open quotes
        uint256 unbondingQty;  // tokens requested for withdrawal (still slashable)
        uint256 unbondReady;   // timestamp unbonding can be withdrawn
        uint256 windowStart;   // start of the current rolling slash window
        uint256 slashedInWindow; // USDG slashed so far this window
        bool    exists;
    }

    struct PendingSlash {
        bytes32 agentId;
        uint256 amountUsdg;    // USDG value to slash
        uint256 tokenQty;      // tokens to burn at execution-time valuation snapshot
        uint256 executeAfter;  // timestamp funds may move
        bool    settled;
    }

    mapping(bytes32 => Agent) public agents;
    mapping(bytes32 => PendingSlash) public pending; // slashId -> queued slash

    event Launched(bytes32 indexed agentId, address indexed wallet, address token);
    event Bonded(bytes32 indexed agentId, uint256 tokenQty, uint256 newBond);
    event Reserved(bytes32 indexed agentId, uint256 price, uint256 reservedHaircut);
    event Released(bytes32 indexed agentId, uint256 reservedHaircut);
    event SlashQueued(bytes32 indexed slashId, bytes32 indexed agentId, uint256 amountUsdg, uint256 executeAfter, bool capped);
    event SlashExecuted(bytes32 indexed slashId, bytes32 indexed agentId, uint256 tokenQty);
    event UnbondRequested(bytes32 indexed agentId, uint256 tokenQty, uint256 ready);
    event UnbondWithdrawn(bytes32 indexed agentId, uint256 tokenQty);
    event Paused(bool paused);

    modifier onlyOwner()    { require(msg.sender == owner, "not owner"); _; }
    modifier onlyGuardian() { require(msg.sender == guardian || msg.sender == owner, "not guardian"); _; }

    constructor(
        address _platformToken,
        address _oracle,
        address _verifier,
        address _guardian,
        uint256[8] memory p // [haircutBps, reservationBps, liqFloor, unbondCooldown, maxSlashBps, rollingCapBps, rollingWindow, pendingDelay]
    ) {
        platformToken = IERC20(_platformToken);
        oracle = IPriceOracle(_oracle);
        verifier = _verifier;
        guardian = _guardian;
        owner = msg.sender;
        bondHaircutBps = p[0];
        reservationMultipleBps = p[1];
        liquidityFloorUsdg = p[2];
        unbondingCooldown = p[3];
        maxSlashMultipleBps = p[4];
        rollingSlashCapBps = p[5];
        rollingSlashWindow = p[6];
        pendingSlashDelay = p[7];
    }

    function setVerifier(address v) external onlyOwner { verifier = v; }
    function setGuardian(address g) external onlyOwner { guardian = g; }
    function setPaused(bool v) external onlyGuardian { paused = v; emit Paused(v); }

    // ---- launch & bond -------------------------------------------------------

    function launch(bytes32 agentId, address token) external {
        require(!agents[agentId].exists, "exists");
        agents[agentId] = Agent(msg.sender, token, 0, 0, 0, 0, block.timestamp, 0, true);
        emit Launched(agentId, msg.sender, token);
    }

    /// @notice Stake `tokenQty` of the platform token as bond. In production the
    ///         fee harvest (bond share) calls this with the pool's accrued fees.
    function bond(bytes32 agentId, uint256 tokenQty) external {
        Agent storage a = _must(agentId);
        require(platformToken.transferFrom(msg.sender, address(this), tokenQty), "transfer failed");
        a.bond += tokenQty;
        emit Bonded(agentId, tokenQty, a.bond);
    }

    // ---- valuation (mirrors src/launchpad.js) --------------------------------

    /// @notice Haircut-adjusted USDG value of the live bond (excludes unbonding),
    ///         zero below the pool liquidity floor.
    function bondHaircutValue(bytes32 agentId) public view returns (uint256) {
        Agent storage a = agents[agentId];
        if (!a.exists) return 0;
        if (oracle.poolLiquidityUsdg(a.token) < liquidityFloorUsdg) return 0;
        uint256 live = a.bond > a.unbondingQty ? a.bond - a.unbondingQty : 0;
        uint256 rawUsdg = (live * oracle.twapUsdg(a.token)) / 1e6;
        return (rawUsdg * bondHaircutBps) / BPS;
    }

    /// @notice Open-quote capacity: haircut value / reservationMultiple.
    function capacityUsdg(bytes32 agentId) public view returns (uint256) {
        return (bondHaircutValue(agentId) * BPS) / reservationMultipleBps;
    }

    // ---- reservation against quotes ------------------------------------------

    /// @notice Reserve collateral for a new quote at `price`. Reverts if the
    ///         200%-of-price reservation would exceed remaining haircut capacity
    ///         (no quote can be backed beyond the bond's haircut value).
    function reserve(bytes32 agentId, uint256 price) external onlyOwner {
        Agent storage a = _must(agentId);
        uint256 need = (price * reservationMultipleBps) / BPS;
        require(a.reserved + need <= bondHaircutValue(agentId), "over capacity");
        a.reserved += need;
        emit Reserved(agentId, price, need);
    }

    function release(bytes32 agentId, uint256 price) external onlyOwner {
        Agent storage a = _must(agentId);
        uint256 amt = (price * reservationMultipleBps) / BPS;
        a.reserved = a.reserved > amt ? a.reserved - amt : 0;
        emit Released(agentId, amt);
    }

    // ---- capped, delayed slashing --------------------------------------------

    /// @notice Queue a slash on a verifier-signed verdict. The amount is sized in
    ///         USDG = price * multiple, clamped to maxSlashMultiple, then clamped
    ///         to what the rolling-window cap still allows. Funds do not move yet:
    ///         the slash enters a pending queue and can only be executed after
    ///         pendingSlashDelay, and never while paused. This is the window a
    ///         guardian uses to halt a faulty verifier before value is destroyed.
    function queueSlash(bytes32 slashId, bytes32 agentId, uint256 price, uint256 multipleBps, bytes calldata sig)
        external returns (uint256 amountUsdg, bool capped)
    {
        Agent storage a = _must(agentId);
        require(pending[slashId].executeAfter == 0, "slash exists");
        bytes32 digest = _digest(slashId, agentId, price, multipleBps);
        require(_recover(digest, sig) == verifier, "bad verdict sig");

        // roll the window forward if it has elapsed
        if (block.timestamp - a.windowStart >= rollingSlashWindow) {
            a.windowStart = block.timestamp;
            a.slashedInWindow = 0;
        }
        uint256 mult = multipleBps > maxSlashMultipleBps ? maxSlashMultipleBps : multipleBps;
        amountUsdg = (price * mult) / BPS;

        uint256 rawUsdg = (a.bond * oracle.twapUsdg(a.token)) / 1e6;
        uint256 windowBudget = (rawUsdg * rollingSlashCapBps) / BPS;
        uint256 remaining = windowBudget > a.slashedInWindow ? windowBudget - a.slashedInWindow : 0;
        if (amountUsdg > remaining) { amountUsdg = remaining; capped = true; }

        a.slashedInWindow += amountUsdg;
        uint256 twap = oracle.twapUsdg(a.token);
        uint256 tokenQty = twap > 0 ? (amountUsdg * 1e6) / twap : 0;
        pending[slashId] = PendingSlash(agentId, amountUsdg, tokenQty, block.timestamp + pendingSlashDelay, false);
        emit SlashQueued(slashId, agentId, amountUsdg, block.timestamp + pendingSlashDelay, capped);
    }

    /// @notice Execute a queued slash after its delay. Burns the token from the
    ///         bond into the insurance pool. Blocked while paused.
    function executeSlash(bytes32 slashId) external {
        require(!paused, "paused");
        PendingSlash storage s = pending[slashId];
        require(s.executeAfter != 0 && !s.settled, "no pending slash");
        require(block.timestamp >= s.executeAfter, "too early");
        Agent storage a = _must(s.agentId);
        uint256 qty = s.tokenQty > a.bond ? a.bond : s.tokenQty;
        a.bond -= qty;
        insurancePool += qty;
        s.settled = true;
        emit SlashExecuted(slashId, s.agentId, qty);
    }

    // ---- unbonding (cooldown; still slashable while pending) -----------------

    function requestUnbond(bytes32 agentId, uint256 tokenQty) external {
        Agent storage a = _must(agentId);
        require(msg.sender == a.wallet, "not owner wallet");
        require(tokenQty <= a.bond, "over bond");
        a.unbondingQty = tokenQty;
        a.unbondReady = block.timestamp + unbondingCooldown;
        emit UnbondRequested(agentId, tokenQty, a.unbondReady);
    }

    function withdrawUnbonded(bytes32 agentId) external {
        Agent storage a = _must(agentId);
        require(msg.sender == a.wallet, "not owner wallet");
        require(a.unbondingQty > 0 && block.timestamp >= a.unbondReady, "not ready");
        uint256 qty = a.unbondingQty > a.bond ? a.bond : a.unbondingQty;
        a.bond -= qty;
        a.unbondingQty = 0;
        a.unbondReady = 0;
        require(platformToken.transfer(a.wallet, qty), "transfer failed");
        emit UnbondWithdrawn(agentId, qty);
    }

    // ---- internals -----------------------------------------------------------

    function _must(bytes32 agentId) internal view returns (Agent storage a) {
        a = agents[agentId];
        require(a.exists, "no agent");
    }

    function _digest(bytes32 slashId, bytes32 agentId, uint256 price, uint256 multipleBps) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("vouch.slash", slashId, agentId, price, multipleBps));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig len");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(ethSigned, v, r, s);
    }
}
