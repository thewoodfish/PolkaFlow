# PolkaFlow ⚡

**Universal Payment & DeFi Settlement Engine**
*Built on Polkadot Asset Hub EVM — EVM Smart Contract Track*

> "Accept any token. Settle in stablecoins. Earn yield automatically."

---

## The Problem

Blockchain payments are chain-locked and economically inefficient:

- **Token fragmentation** — merchants want USDC, customers hold DOT. Every cross-chain payment requires the customer to manually swap first, adding friction.
- **Idle settlement funds** — once a payment lands, the USDC sits in a wallet earning nothing. There is no protocol-level equivalent of a merchant acquirer auto-investing float.
- **Manual settlement** — existing demo-grade payment dApps require a privileged account to manually trigger settlement, making them unsuitable for real use.

---

## The Solution

PolkaFlow is a Solidity payment router on **Polkadot Asset Hub EVM (Paseo)** that solves all three problems:

1. **Accept any ERC20 token** — customers pay with DOT (or any token). The router locks it and an on-chain AMM swap converts it to USDC automatically.
2. **Permissionless settlement** — anyone (including an automated relayer) can call `swapAndSettle()`. No privileged account required.
3. **Auto-vault DeFi loop** — with one flag at invoice creation (`autoVault: true`), settled USDC is deposited atomically into `PolkaFlowVault`, earning **5% APY**. The merchant withdraws more than they received.

---

## Architecture

```
  ┌─────────────┐
  │  Customer   │  holds DOT / USDC / any ERC20
  └──────┬──────┘
         │  payWithToken(DOT)  or  payWithStablecoin(USDC)
         ▼
  ┌──────────────────────┐
  │   PolkaFlowRouter    │  Solidity · Polkadot Asset Hub EVM
  │   ──────────────────  │
  │   • Creates invoice  │
  │   • Locks token      │
  │   • Emits event      │
  └──────┬───────────────┘
         │  PaymentInitiated event
         ▼
  ┌──────────────────────┐
  │   PolkaFlow Relayer  │  Node.js · watches events · permissionless
  │   (or anyone)        │
  └──────┬───────────────┘
         │  swapAndSettle(paymentId, minUsdcOut, deadline)
         ▼
  ┌──────────────────────┐
  │   SimpleDEX          │  Constant-product AMM (x*y=k) · 0.3% fee
  │   IDexAdapter        │  Pluggable — swap for ink!/pallet-asset-conversion
  └──────┬───────────────┘
         │  net USDC (after 0.3% protocol fee)
         ▼
  ┌─────────────┐        ┌──────────────────────┐
  │  Merchant   │  -OR-  │   PolkaFlowVault      │
  │  Wallet     │        │   ERC4626-lite · 5%APY│
  │  (direct)   │        │   (autoVault=true)    │
  └─────────────┘        └──────────────────────┘
```

**Two settlement paths:**

| Path | Flow | Settled by |
|------|------|------------|
| PATH A — Stablecoin | `payWithStablecoin(id, usdc, amount)` | Customer (single tx) |
| PATH B — Any token | `payWithToken(id, dot, amount)` → relayer calls `swapAndSettle()` | Anyone (permissionless) |

**Pluggable DEX adapter (`IDexAdapter`):**

The router never calls SimpleDEX directly — it calls the `IDexAdapter` interface. To upgrade from SimpleDEX to Polkadot's native `pallet-asset-conversion` AMM, the owner calls `setDexAdapter(inkBridgeAddress)` — no router redeployment needed.

---

## Live Deployment — Polkadot Asset Hub Paseo

**Network:** Polkadot Asset Hub Paseo · Chain ID `420420417`

| Contract | Address | Explorer |
|---|---|---|
| `PolkaFlowRouter` | `0xc30ADf3Cba57e9eB6B9f89Ad3a6722d18072Ac8c` | [Blockscout ↗](https://blockscout-testnet.polkadot.io/address/0xc30ADf3Cba57e9eB6B9f89Ad3a6722d18072Ac8c) |
| `SimpleDEX` | `0xAD2085749859ED1FA007E003CBCd34F062297E4C` | [Blockscout ↗](https://blockscout-testnet.polkadot.io/address/0xAD2085749859ED1FA007E003CBCd34F062297E4C) |
| `PolkaFlowVault` | `0x124cA7a7D92A89ceA5F41d095Cd14E10941F8636` | [Blockscout ↗](https://blockscout-testnet.polkadot.io/address/0x124cA7a7D92A89ceA5F41d095Cd14E10941F8636) |
| `MockUSDC` | `0xF4bF0d92142F5C5780B5E6c5753b13118AF4A870` | [Blockscout ↗](https://blockscout-testnet.polkadot.io/address/0xF4bF0d92142F5C5780B5E6c5753b13118AF4A870) |
| `MockDOT` | `0x5479585CEef22bB274C699E47254a583723DB2C2` | [Blockscout ↗](https://blockscout-testnet.polkadot.io/address/0x5479585CEef22bB274C699E47254a583723DB2C2) |

**Live DEX pool:** 5,000 USDC / 1,000 DOT (implied price: 1 DOT = 5 USDC)

**Network config for MetaMask:**

| Field | Value |
|---|---|
| Network name | Polkadot Asset Hub Paseo |
| Chain ID | `420420417` |
| RPC URL | `https://eth-rpc-testnet.polkadot.io/` |
| Block explorer | `https://blockscout-testnet.polkadot.io` |
| Native token | PAS (free from [faucet.polkadot.io](https://faucet.polkadot.io)) |

> MetaMask is auto-configured when you click "Connect MetaMask" in the frontend.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Smart Contracts | Solidity ^0.8.20 |
| Contract Framework | Hardhat 2.22 + TypeScript |
| Libraries | OpenZeppelin v5 (`SafeERC20`, `Ownable`, `ReentrancyGuard`) |
| Network | Polkadot Asset Hub EVM — Paseo testnet (chainId `420420417`) |
| DEX | SimpleDEX — constant-product AMM (x\*y=k, Uniswap v2 formula) |
| Token Standards | ERC20 (payments), ERC4626-lite (vault shares) |
| Relayer | Node.js + ethers.js v6 — event-driven, permissionless |
| Frontend | React 18 + Vite 5 + TypeScript |
| Web3 | ethers.js v6 (`BrowserProvider`, `Contract`) |
| Wallet | MetaMask (auto-adds Paseo chain) |
| Styling | Tailwind CSS + custom Polkadot brand colours |
| Tests | Hardhat + Mocha + Chai — 40 tests, 100% passing |

---

## Quick Start

### Prerequisites

- Node.js >= 18, npm >= 9
- MetaMask browser extension

### 1 — Clone and install

```bash
git clone https://github.com/your-org/polkaflow.git
cd polkaflow
npm install
```

### 2 — Run tests

```bash
npm test
# 40 tests passing — PolkaFlowRouter, PolkaFlowVault, SimpleDEX
```

### 3 — Run against live Paseo deployment

```bash
# Terminal 1 — start the automated settlement relayer
npm run relayer:paseo

# Terminal 2 — start the frontend
npm run dev
# Opens http://localhost:5173
```

### 4 — Run locally (Hardhat node)

```bash
# Terminal 1
cd contracts && npx hardhat node

# Terminal 2
npm run deploy:local

# Terminal 3
npm run relayer

# Terminal 4
npm run dev
```

### 5 — Deploy your own instance to Paseo

```bash
cp .env.example .env
# Set DEPLOYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY in .env

npm run deploy:paseo
# Deploys all 5 contracts, seeds DOT/USDC pool, writes deployments.json
```

---

## Demo Walkthrough

1. **Merchant tab** — enter invoice amount, optionally toggle **Auto-deposit to Vault**, click **Create Request**, copy the payment ID.
2. **Customer tab** — paste the payment ID, choose:
   - **USDC** — single tx, settles immediately (PATH A)
   - **DOT** — locks DOT in the router, emits `PaymentInitiated` (PATH B)
3. **DOT path** — the relayer detects the event and automatically calls `swapAndSettle()`. The UI listens for the `PaymentSettled` event and updates in real time — no page refresh, no manual steps.
4. Watch the **Flow Diagram** animate through each step and the **Stats Bar** update with live on-chain totals.
5. **Merchant tab** — payment flips to *Settled* or *Vaulted* with the received USDC amount.

---

## Project Structure

```
polkaflow/
├── contracts/
│   ├── contracts/
│   │   ├── PolkaFlowRouter.sol   Payment router · permissionless settlement
│   │   ├── SimpleDEX.sol         Constant-product AMM · IDexAdapter impl
│   │   ├── IDexAdapter.sol       Pluggable DEX interface
│   │   ├── PolkaFlowVault.sol    ERC4626-lite yield vault (5% APY)
│   │   ├── WWPAS.sol             Wrapped PAS (WETH pattern)
│   │   ├── MockUSDC.sol          Test stablecoin (6 dec)
│   │   └── MockDOT.sol           Test DOT token (18 dec)
│   └── hardhat.config.ts
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── CustomerPanel.tsx  DOT/USDC payment UI · auto-settles via event
│       │   ├── MerchantPanel.tsx  Invoice creation · vault toggle
│       │   ├── ConnectWallet.tsx  MetaMask · auto-adds Paseo chain
│       │   ├── ContractsModal.tsx Deployed addresses · Blockscout links
│       │   ├── StatsBar.tsx       Live on-chain stats
│       │   └── FlowDiagram.tsx    Animated payment flow
│       ├── hooks/usePolkaFlow.ts  ethers.js wallet + contract hook
│       └── deployments.json      Written by deploy script
├── scripts/
│   ├── deploy.ts                 Deploys + seeds pool + wires contracts
│   ├── relayer.ts                Event-driven settlement relayer
│   └── demo-flow.ts              End-to-end CLI demo
├── test/
│   ├── PolkaFlowRouter.test.ts   19 tests
│   ├── PolkaFlowVault.test.ts    13 tests
│   └── SimpleDEX.test.ts         8 tests
├── CONTRACTS.md                  Full NatSpec reference + math
├── .env.example
└── README.md
```

---

## Hackathon Track

**EVM Smart Contract Track — DeFi & Stablecoin-enabled dApps**

PolkaFlow is purpose-built for the Polkadot Hub EVM ecosystem:

- **Real on-chain DEX** — `SimpleDEX` is a production-grade constant-product AMM (x\*y=k) deployed on Paseo with a live liquidity pool. This is not a mock or simulation.
- **Permissionless settlement** — `swapAndSettle()` has no access control. Any account can trigger it, including the automated relayer. No privileged account required in the demo critical path.
- **Pluggable DEX architecture** — `IDexAdapter` decouples the router from any specific AMM. The path to Polkadot's native `pallet-asset-conversion` is `setDexAdapter(inkBridgeAddress)` — one owner call, no redeployment.
- **Stablecoin-first** — merchants always receive USDC regardless of what the customer paid with, eliminating volatility risk and enabling real commerce on Polkadot.
- **DeFi composability** — the `autoVault` flag routes settled USDC atomically into an ERC4626-compatible vault, giving merchants yield on payment float.

---

## License

MIT
