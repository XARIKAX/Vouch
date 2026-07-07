# On-chain settlement — design sketch

Today Vouch's escrow and provider stake are a **simulated ledger** inside
`src/engine.js` (balances in `state.accounts`, stake in `state.providers`;
`money()` accounting, `txHash()` cosmetic hashes). That's enough to prove the
mechanism end-to-end, but the value moved is fake. This document sketches the
path to **real USDC settlement and real slashable stake on-chain**, which is
the one axis where routing-layer competitors (settling USDC on Base today)
currently have something we don't.

The goal is not to rewrite Vouch. The engine already models the exact state
machine a contract needs — escrow lock → verified pass → release, or fail →
refund + slash. We keep that engine as the **off-chain coordinator/oracle**
and move only the *custody and settlement of funds* on-chain.

## Architecture: engine as verifier oracle, chain as escrow vault

```
 agent ──POST /v1/tasks──▶  Vouch engine (coordinator + verifier)
   │                              │
   │  1. approve USDC             │  3. runs auction, picks committed quote
   │  2. depositEscrow(task)      │  4. runs verification (schema/checks/rubric)
   ▼                              ▼
 ┌────────────────────────┐   5. submitVerdict(taskId, pass|fail, receiptHash)
 │  VouchEscrow (Base)     │◀─────────────┘   (signed by the verifier key /
 │  - holds USDC per task  │                   attestation set)
 │  - holds provider stake │
 │  - release() / refund() │──▶ pass: pay provider, unlock stake
 │  - slash()              │──▶ fail: refund agent, slash stake to insurance
 └────────────────────────┘
```

- **Custody moves on-chain.** A `VouchEscrow` contract on Base (USDC-native,
  cheap) holds the task's escrow and the provider's reserved stake for the
  lifetime of the task. The engine never touches funds — it only *instructs*.
- **The engine becomes the verifier oracle.** Verification stays off-chain
  (schema, deterministic checks, the Claude rubric panel — none of that can or
  should run on-chain). The engine signs a verdict `(taskId, pass, receiptHash)`
  with a verifier key; the contract acts on the signed verdict.
- **Receipts become real.** `txHash()` stops being cosmetic — every lock,
  release, refund, and slash is an actual Base transaction the agent can audit.

## Contract surface (minimal)

```solidity
interface IVouchEscrow {
  // agent locks the quoted price in USDC for a task
  function depositEscrow(bytes32 taskId, uint256 amount) external;
  // provider bonds/reserves stake against the same task
  function reserveStake(bytes32 taskId, address provider, uint256 amount) external;

  // verifier oracle submits the signed outcome
  function settle(bytes32 taskId, bytes calldata verifierSig) external; // pass → pay provider
  function refundAndSlash(bytes32 taskId, uint256 slashBps, bytes calldata verifierSig) external;

  // 24h dispute window: re-verdict can claw back a settled task
  function dispute(bytes32 taskId) external;
  function resolveDispute(bytes32 taskId, bool upheld, bytes calldata verifierSig) external;
}
```

The slash multiples already in the engine map straight to `slashBps`
(`refundTask` uses 1×/1.5×/2× for `deadline_missed` / `provider_abandoned` /
`dispute_upheld`). Slashed stake flows to an **insurance pool** that backstops
agents when a provider's stake can't cover the loss.

## Trust model, staged

The honest weak point is the verifier: a single oracle key deciding pass/fail
is a single point of trust. Harden it in stages, shipping value at each:

1. **v1 — single verifier (custodial-ish).** One Vouch-operated verifier key
   signs verdicts. Funds are on-chain and auditable; verification is trusted.
   This already beats "settles on delivery": payment is still gated on a
   verdict, and the money is real. Fastest path to parity + the USP on-chain.
2. **v2 — attestation set / M-of-N.** The three-judge rubric panel becomes
   three independent signers; the contract requires a threshold. Verdicts are
   now multi-party, not one key.
3. **v3 — optimistic + challenge.** Verdicts settle optimistically after a
   challenge window; anyone can post a bond to force re-review (the existing
   dispute machinery, generalized). Stake and disputes make dishonest verdicts
   economically irrational.

## What changes in this repo

Small, contained — the state machine is already correct:

- `src/store.js` gains a chain-backed implementation alongside the file/Redis
  stores: reads mirror on-chain balances, writes become transaction intents.
- `src/engine.js` swaps the internal `lockEscrow` / `settleEscrow` /
  `slashProvider` calls for calls to a `settlement` adapter. The adapter is
  in-memory today (current behavior) or on-chain (new). The lifecycle,
  verification, and slash logic are untouched.
- A new `src/settlement-base.js` holds the viem/ethers client, the verifier
  signer, and the `IVouchEscrow` calls. Still no npm deps in core if we use a
  thin JSON-RPC fetch client; the signer is the only real dependency.
- Env: `VOUCH_CHAIN_RPC`, `VOUCH_ESCROW_ADDRESS`, `VOUCH_VERIFIER_KEY`,
  `VOUCH_USDC_ADDRESS`. Absent → current simulated mode (unchanged).

## Why this wins the comparison

A routing layer settles USDC **on delivery** — the chain records that a call
happened. Vouch would settle USDC **on verified correctness**, with the
provider's stake slashed on-chain when it fails. Same rail (USDC on Base),
strictly stronger guarantee: the block explorer becomes proof that *the buyer
never paid for a wrong answer*. That turns the marketing claim into something
a third party can verify on-chain — which is exactly the credibility a
competitor's "settled on Base" badge is trading on.

## Status

- **`contracts/VouchEscrow.sol`** — the v1 escrow contract: holds USDC escrow +
  provider stake, and `settle` / `refundAndSlash` act only on a verifier-signed
  verdict (ECDSA `ecrecover`). Slashed stake accrues to an on-chain insurance
  pool.
- **`src/settlement.js`** — the settlement adapter: a secp256k1 verifier
  (Ethereum's curve) that signs verdicts, plus a `mockChain()` backend that
  verifies those signatures and moves the ledger exactly as the contract's
  `ecrecover` would. Fully tested (`test/settlement.test.js`): valid verdicts
  settle and refund, and a forged signature is rejected with escrow untouched.
- **Remaining to go live** (needs a chain + funded key — not doable in this
  sandbox): deploy `VouchEscrow` to Base Sepolia, swap `mockChain()` for a
  JSON-RPC backend (viem/ethers), point the engine's escrow calls at the
  adapter, and switch the verdict hash from sha256 to keccak256/EIP-712 to
  match the contract. The signing + recovery flow is already the real one.

> The site does not claim on-chain settlement is live — escrow/stake remain a
> simulated bond until `VouchEscrow` is deployed and the engine is switched onto
> the adapter.
