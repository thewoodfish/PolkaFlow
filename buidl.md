## What We Built

**PolkaFlow** is a permissionless payment and DeFi settlement engine deployed on Polkadot Asset Hub EVM (Paseo testnet). It lets merchants accept any ERC20 token and always receive USDC — with optional auto-deposit into a yield vault earning 5% APY.

---

## The Stack

### Smart Contracts (Solidity, Polkadot Asset Hub EVM)

**`PolkaFlowRouter`** — the core payment engine. Merchants create invoices; customers pay with USDC (single-tx settlement) or any ERC20 token (locked in the router, settled by the relayer via DEX swap). A 30 bps protocol fee is deducted on every settlement. The DEX is fully pluggable via `IDexAdapter` — upgrading to Polkadot's native `pallet-asset-conversion` requires one owner call, no redeployment.

**`SimpleDEX`** — a real, deployed constant-product AMM (x\*y=k, Uniswap v2 formula) with a live **1,000 DOT / 5,000 USDC** liquidity pool on Paseo. Not a mock.

**`PolkaFlowVault`** — an ERC4626-lite yield vault. Settled USDC is deposited atomically into the vault in the same settlement transaction (`depositFor`), minting yield-bearing shares directly to the merchant.

**`IDexAdapter`** — a clean interface decoupling the router from any specific AMM, designed for the `pallet-asset-conversion` migration path.

### Relayer (Node.js + ethers.js)

An event-driven, stateless process deployed on Railway. Watches for `PaymentInitiated` events on the router, fetches a DEX quote, applies 1% slippage protection, and calls `swapAndSettle()`. Permissionless — any account can settle; the relayer is automation, not a gatekeeper.

### Frontend (React + Vite + ethers.js)

Deployed on Vercel. Two panels — Merchant and Customer — with real-time settlement status via on-chain event polling. MetaMask auto-adds the Paseo Asset Hub chain on first connect.

---

## Live Deployment

| Contract | Address |
|---|---|
| `PolkaFlowRouter` | `0xc30ADf3Cba57e9eB6B9f89Ad3a6722d18072Ac8c` |
| `SimpleDEX` | `0xAD2085749859ED1FA007E003CBCd34F062297E4C` |
| `PolkaFlowVault` | `0x124cA7a7D92A89ceA5F41d095Cd14E10941F8636` |
| `MockUSDC` | `0xF4bF0d92142F5C5780B5E6c5753b13118AF4A870` |
| `MockDOT` | `0x5479585CEef22bB274C699E47254a583723DB2C2` |

**Network:** Polkadot Asset Hub Paseo · Chain ID `420420417`
**Frontend:** https://polka-flow-frontend.vercel.app
**Relayer:** Running on Railway, watching Paseo 24/7

---

## How a Payment Works

1. Merchant creates an invoice (`$20 USDC`, `autoVault: true`)
2. Customer locks 3 DOT in the router → `PaymentInitiated` event fires
3. Relayer detects event → calls `swapAndSettle(paymentId, minOut, deadline)`
4. Router pulls DOT → SimpleDEX swaps to USDC → fee deducted → net USDC deposited into vault
5. Merchant's dashboard updates: **Vaulted 🏦** — earning 5% APY from block one

---

## Tests

40 tests across three suites — `PolkaFlowRouter` (19), `PolkaFlowVault` (13), `SimpleDEX` (8) — all passing.

---

## What Makes It Different

- **Permissionless settlement** — `swapAndSettle()` has no access control. No privileged account required.
- **Real on-chain DEX** — SimpleDEX is a deployed AMM with live reserves, not a simulation.
- **Atomic yield** — vault deposit happens in the same transaction as settlement. Zero custody gap.
- **Pluggable DEX** — `IDexAdapter` makes the router DEX-agnostic. One call to upgrade to `pallet-asset-conversion`.
