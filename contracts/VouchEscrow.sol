// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VouchEscrow
/// @notice Holds an agent's USDC escrow and a provider's reserved stake for the
///         lifetime of a task, and releases, refunds, or slashes it only on a
///         verdict signed by the Vouch verifier oracle. The engine decides
///         pass/fail off-chain (verification can't run on-chain); this contract
///         is the custody + settlement layer. Mirrors src/settlement.js and the
///         engine's own lifecycle. See ONCHAIN.md.
///
/// Trust model is staged (ONCHAIN.md): v1 a single verifier key; v2 an M-of-N
/// attestation set; v3 optimistic settlement with a challenge window. This is v1.

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract VouchEscrow {
    enum State { None, Locked, Settled, Refunded }

    struct Task {
        address agent;      // who funded the escrow
        address provider;   // who is bonded to deliver
        uint256 amount;     // USDC escrowed (the committed budget)
        uint256 stake;      // provider stake reserved against this task
        State   state;
    }

    IERC20  public immutable usdc;
    address public verifier;      // the oracle key that signs verdicts
    address public owner;
    uint256 public insurancePool; // slashed stake accrues here

    mapping(bytes32 => Task) public tasks;

    event Escrowed(bytes32 indexed taskId, address indexed agent, address indexed provider, uint256 amount, uint256 stake);
    event Settled(bytes32 indexed taskId, address indexed provider, uint256 paid, uint256 surplus);
    event RefundedAndSlashed(bytes32 indexed taskId, address indexed agent, uint256 refunded, uint256 slashed);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _usdc, address _verifier) {
        usdc = IERC20(_usdc);
        verifier = _verifier;
        owner = msg.sender;
    }

    function setVerifier(address v) external onlyOwner { verifier = v; }

    /// @notice Agent locks the committed budget; provider's stake is recorded.
    ///         (Stake custody/transfer is elided here for brevity; v1 records it
    ///         and slashes against a provider stake vault.)
    function depositEscrow(bytes32 taskId, address provider, uint256 amount, uint256 stake) external {
        require(tasks[taskId].state == State.None, "exists");
        require(usdc.transferFrom(msg.sender, address(this), amount), "usdc transfer failed");
        tasks[taskId] = Task(msg.sender, provider, amount, stake, State.Locked);
        emit Escrowed(taskId, msg.sender, provider, amount, stake);
    }

    /// @notice Pay the provider `price` and refund any surplus to the agent — on
    ///         a verifier-signed "settled" verdict.
    function settle(bytes32 taskId, uint256 price, bytes calldata sig) external {
        Task storage t = tasks[taskId];
        require(t.state == State.Locked, "not locked");
        require(price <= t.amount, "price over escrow");
        bytes32 digest = _digest(taskId, "settled", price, 0);
        require(_recover(digest, sig) == verifier, "bad verdict sig");

        t.state = State.Settled;
        uint256 surplus = t.amount - price;
        require(usdc.transfer(t.provider, price), "pay failed");
        if (surplus > 0) require(usdc.transfer(t.agent, surplus), "refund failed");
        emit Settled(taskId, t.provider, price, surplus);
    }

    /// @notice Refund the agent in full and slash the provider's stake — on a
    ///         verifier-signed "refunded" verdict. slashBps is basis points of
    ///         stake (e.g. 10000 = 100%, 15000 = 1.5x for abandonment).
    function refundAndSlash(bytes32 taskId, uint256 slashBps, bytes calldata sig) external {
        Task storage t = tasks[taskId];
        require(t.state == State.Locked, "not locked");
        bytes32 digest = _digest(taskId, "refunded", t.amount, slashBps);
        require(_recover(digest, sig) == verifier, "bad verdict sig");

        t.state = State.Refunded;
        uint256 slashed = (t.stake * slashBps) / 10000;
        insurancePool += slashed; // capitalizes the outcome-insurance pool
        require(usdc.transfer(t.agent, t.amount), "refund failed");
        emit RefundedAndSlashed(taskId, t.agent, t.amount, slashed);
    }

    function _digest(bytes32 taskId, string memory outcome, uint256 amount, uint256 slashBps) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("vouch.verdict", taskId, outcome, amount, slashBps));
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
