# On-chain: what is real today, and the settlement design

> **Status, plainly:** task escrow, provider stake and slashing settle in a
> sandbox ledger inside `src/engine.js`. Three things touch Solana for real:
> wallet sign-in, USDT deposits and withdrawals (when a deployment turns real
> funds on), and agent tokens launched on pump.fun. The escrow program is
> not written. Settles in a sandbox ledger today. On-chain settlement is next.

The chain is **Solana**. The settlement asset is **USDT** (the SPL mint
`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, 6 decimals). Everything
chain-side runs with zero dependencies in `src/chain/`:

| File | What it does |
|---|---|
| `base58.js` | Addresses and signatures |
| `ed25519.js` | Signing and verification through Node's crypto; the on-curve check program-derived addresses need |
| `solana.js` | PDAs, associated token accounts, system and SPL token instructions, signing a compiled message |
| `rpc.js` | The JSON-RPC calls used: transactions, accounts, balances, blockhash, send |
| `pump.js` | pump.fun: the `create` instruction, launch verification, bonding-curve reads, creator vault reads, the `collect_creator_fee` claim |
| `funds.js` | USDT: deposit and payout verification from token balance changes, treasury-signed payouts |
| `../../public/assets/solmsg.js` | The legacy message compiler, shared with the browser |

The browser side (`public/assets/sol.js`) discovers wallets through the
Wallet Standard (Phantom, Solflare, Backpack and others register themselves),
compiles server-prepared instructions with a fresh blockhash, simulates
them, co-signs with a mint key generated in the browser, and hands the
transaction to the wallet to sign and send. Vouch never sees a private key.

## What is on-chain today

### Token launches on pump.fun

- `POST /v1/agents` with a `launch` object prepares the exact pump.fun
  `create` instruction: the agent's name and symbol, a metadata URI that
  points back at `GET /v1/agents/{id}/token.json` (served here, so no
  third-party upload), and the creator who earns the curve's creator fee
  (the launcher's wallet unless `VOUCH_CREATOR_FEE_RECIPIENT` names another
  address). The mint is a keypair the launcher generated; it co-signs.
- `POST /v1/agents/{id}/launch/confirm` reads the confirmed transaction,
  requires a `create` on the pump.fun program from the expected wallet with
  the expected mint, and records the mint and the bonding-curve PDA.
- From then on the engine decodes the bonding curve account (virtual and
  real reserves, completion) to price the bond in SOL, converts with the SOL
  rate from `VOUCH_SOL_USD` or `VOUCH_SOL_USD_URL`, and reads the creator
  vault for accrued fees. `GET /v1/agents/{id}/claim` returns the
  `collect_creator_fee` instruction the creator's wallet signs.
- The program-derived addresses and instruction discriminators are checked
  in `test/solana.test.js` against pump.fun's published values.

pump.fun's creator fee is fixed by the protocol, not chosen per launch. The
launchpad's "fees bond the agent" economics therefore run on whatever that
fee pays, plus the job-revenue routing that does not depend on it.

### USDT deposits and withdrawals

With `VOUCH_REAL_FUNDS=1` and a treasury address, deposits are a checked
SPL transfer the wallet signs to the treasury's USDT account, verified from
the confirmed transaction's token balance changes and credited once.
Withdrawals are debited first and paid by a treasury-signed transfer (with
`VOUCH_TREASURY_KEY`) or by an operator whose payout is verified the same
way. See `DEPLOYMENT.md`.

## Settlement design: engine as verifier oracle, program as escrow vault

```
 buyer ──POST /v1/tasks──▶  Vouch engine (coordinator + verifier)
   │                              │
   │  1. transfer USDT to         │  3. runs auction, picks committed quote
   │     the task's escrow        │  4. runs verification (schema/checks/rubric)
   ▼                              ▼
 ┌────────────────────────┐   5. settle(task, verdict, ed25519 signature)
 │  Vouch escrow program  │◀─────────────┘
 │  - USDT per task       │
 │  - provider stake      │──▶ pass: pay provider, unlock stake
 │  - release / refund    │──▶ fail: refund buyer, slash stake to insurance
 │  - slash               │
 └────────────────────────┘
```

- **Custody moves on-chain.** A program holds the task's escrow in USDT and
  the provider's reserved stake for the lifetime of the task. The engine
  never touches funds; it instructs.
- **The engine is the verifier oracle.** Verification stays off-chain. The
  engine signs a verdict `(taskId, pass, receiptHash)` with an ed25519 key;
  the program checks it through the ed25519 native program and acts on it.
  `src/settlement.js` already signs and verifies verdicts this way, against
  an in-memory mock of the program.
- **Receipts become real.** Every lock, release, refund and slash is a
  transaction the buyer can audit.

### Trust model, staged

1. **v1, single verifier.** One Vouch-operated key signs verdicts. Funds are
   on-chain and auditable; verification is trusted.
2. **v2, M-of-N.** The rubric panel becomes independent signers; the program
   requires a threshold.
3. **v3, optimistic with a challenge window.** Anyone can post a bond to
   force re-review; the existing dispute machinery, generalized.

### What changes in this repo

- `src/engine.js` swaps its internal `lockEscrow` / `settleEscrow` /
  `slashProvider` calls for calls to the settlement adapter.
- `src/settlement.js` gains a Solana backend beside `mockChain()`: the
  program's instructions encoded like `src/chain/pump.js` encodes pump.fun's,
  sent through `src/chain/rpc.js`.
- Env: `VOUCH_ESCROW_PROGRAM`, `VOUCH_VERIFIER_KEY`. Absent, the sandbox
  ledger stays.

### Remaining to go live

Write the program (Rust, Anchor), test it on devnet, audit it, deploy it,
and switch the engine onto the adapter. None of that is doable in this
sandbox, and none of it moves until it is signed off.
