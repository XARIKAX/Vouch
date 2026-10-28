# Deploying Vouch Credit

Every deploy resolves its external addresses from `deployments/<chainId>.json`
and writes the result back into the same file. A chain with no record is
refused. The local devnet (31337) is the exception: it gets mocks and a fresh
record.

> **Sign-off gate.** A mainnet deploy (Robinhood Chain 4663, Base 8453) moves
> real USDG the moment a lender deposits. Nothing in this repository runs it
> automatically, and nothing should until the owner has signed off on the
> parameters below, the attester key's custody, and the audit status of the
> contracts. The quickstart and the test suites only ever touch a devnet.

## What gets deployed

| Contract | Purpose |
|---|---|
| `CreditRegistry` | One credit record per ERC-8004 agentId; the attester records work events, the bound pool records loan events; `score` / `creditReport` views |
| `CreditPool` | The open USDG pool: lender shares, the first-loss reserve, advances, task-escrow and stake loans, repayment interception, defaults and recoveries |
| `MockIdentityRegistry`, `MockUSDG` | Devnet only. Never deployed where the record already names the real contracts |

Both contracts are non-upgradeable. Every parameter is immutable after deploy;
a change is a new deployment and a new record.

## Prerequisites

- Foundry (`forge`, `cast`): `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- `forge-std` checked out: `git submodule update --init contracts/lib/forge-std`
- A funded deployer key on the target chain (gas only).
- The **attester** address: the EVM address the Vouch engine will sign with
  (`VOUCH_CREDIT_ATTESTER_KEY`). It records every settlement, slash and dispute
  loss, pays settlement proceeds and repayments into the pool as the treasury,
  and acts for agents on borrow calls. Keep its key in the host's secret store;
  rotating it means a new deployment.
- The **protocol treasury** address: receives the protocol's share of fees via
  `withdrawProtocolFees`.

## Records

`deployments/4663.json` carries Robinhood Chain's external contracts only:

| Field | Value |
|---|---|
| `identityRegistry` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (ERC-8004 Identity Registry) |
| `usdg` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (USDG, 6 decimals) |
| `rpc` | `https://rpc.mainnet.chain.robinhood.com` |
| `explorer` | `https://robinhoodchain.blockscout.com` |

`creditRegistry`, `creditPool` and `attester` are `null` until a deploy fills
them. A Base record (`deployments/8453.json`) must be added by hand with Base's
identity registry and USDG before a deploy there is possible.

## Parameters

All read from the environment by `script/Deploy.s.sol`, with the defaults the
build brief suggests:

| Variable | Default | Meaning |
|---|---|---|
| `ATTESTER` | required outside the devnet | The engine's attester address |
| `PROTOCOL_TREASURY` | the broadcaster | Receives protocol fees |
| `CREDIT_LINE_CAP` | `1000000000` ($1,000) | Cap on any agent's credit line |
| `LENDER_BPS` / `RESERVE_BPS` / `PROTOCOL_BPS` | `7000` / `2000` / `1000` | Fee split; must sum to 10000 |
| `MIN_LOAN` / `MAX_LOAN` | `5000000` / `1000000000` ($5 / $1,000) | Loan size bounds |
| `ADVANCE_BPS` | `8000` | Share of a pending settlement that may be advanced |
| `GRACE_SECONDS` | `259200` (3 days) | After the due date before `markDefault` is allowed |

## Devnet rehearsal

```
anvil --port 8545 &
cd contracts
ATTESTER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
cat deployments/31337.json
```

`npm run quickstart` does the same and then walks an agent through every
lending path. `npm test` and `forge test` must be green first.

## Mainnet (after sign-off)

```
cd contracts
ATTESTER=0x<engine attester> PROTOCOL_TREASURY=0x<treasury> \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key $DEPLOYER_KEY --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/
```

The script refuses to run if `deployments/4663.json` is missing or lacks the
identity registry and USDG, and never deploys mocks there. On success it
writes `attester`, `creditRegistry`, `creditPool`, the parameters and
`deployedAt` into the record. Commit the record: it is how every engine and
CLI resolves the addresses.

Then, before any lender is invited:

1. Seed the first-loss reserve: `cast send <creditPool> "fundReserve(uint256)" <amount>` after approving USDG. Lenders are protected from the first default only to the extent of this reserve.
2. Point the engine at the chain: `VOUCH_CREDIT_CHAIN_ID=4663`, `VOUCH_CREDIT_ATTESTER_KEY=<the attester's key>`, optionally `VOUCH_CREDIT_RPC`. `vouch credit doctor` should print every check as `ok`.
3. Fund the attester with USDG for payouts and repayments (it is the treasury the pool pulls from) and with ETH for gas.
4. Have agents register on the ERC-8004 registry and link their agentId (`POST /v1/credit/identity/{id}` with the owner wallet's signature).

## What the record does not do

It does not grant anything. The registry's attester and the pool's attester
are immutable; the record only tells software where they live. A wrong
attester in a deploy means a redeploy.
