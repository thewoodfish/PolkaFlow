# PolkaFlow

**Universal Payment & DeFi Settlement Engine on Polkadot Asset Hub EVM**

> Accept any token. Settle in stablecoins. Earn yield — automatically.

**[Live Demo](https://polka-flow-frontend.vercel.app)** | [Blockscout Explorer](https://blockscout-testnet.polkadot.io) | [Contracts Reference](./CONTRACTS.md)

---

## The Problem

Blockchain payments are broken in three ways:

**1. Token fragmentation.** Merchants want USDC. Customers hold DOT. Every cross-token payment requires the customer to manually swap first — adding friction, slippage risk, and failed UX before the invoice is even paid.

**2. Idle float.** Once a payment lands in a merchant wallet, the USDC sits earning nothing. Traditional payment processors automatically invest float. DeFi merchants have no equivalent.

**3. Privileged settlement.** Existing demo-grade payment dApps require a trusted, manually-operated account to trigger settlement. That's not permissionless — it's just a backend with extra steps.

---

## The Solution

PolkaFlow is a production-grade Solidity payment engine deployed on **Polkadot Asset Hub EVM (Paseo testnet)** that solves all three:

| Problem | PolkaFlow's answer |
|---|---|
| Token fragmentation | Customers pay with any ERC20 (DOT, WWPAS, etc.). The router locks it and an on-chain AMM swap converts it to USDC atomically. Merchant always receives USDC. |
| Idle float | One flag at invoice creation (`autoVault: true`) routes settled USDC directly into `PolkaFlowVault`, minting yield-bearing shares to the merchant in the same transaction. No extra step. |
| Privileged settlement | `swapAndSettle()` has zero access control. Any account can call it. The relayer is automation, not a gatekeeper. |

---

## Live Demo

**Frontend:** [https://polka-flow-frontend.vercel.app](https://polka-flow-frontend.vercel.app)

**Relayer:** Deployed on Railway — continuously watching for `PaymentInitiated` events on Paseo and calling `swapAndSettle()` automatically.

**Try it in 60 seconds:**

1. Install MetaMask → visit the demo → click **Connect MetaMask** (Paseo chain is auto-added)
2. Get free PAS from [faucet.polkadot.io](https://faucet.polkadot.io) to cover gas
3. Use the **Merchant tab** to mint MockUSDC/MockDOT and create an invoice
4. Switch to the **Customer tab**, paste the payment ID, pay with DOT
5. Watch the relayer auto-settle on-chain and the UI update in real time — no refresh

---

## How It Works

### Payment Paths

```
  ┌─────────────┐
  │  Customer   │  holds DOT / USDC / any ERC20
  └──────┬──────┘
         │
         ├─── PATH A: payWithStablecoin(id, USDC, amount) ──────────────────┐
         │                                                                    │
         └─── PATH B: payWithToken(id, DOT, amount) ──┐                     │
                                                       │                     │
                                                       ▼                     │
                                              PaymentInitiated event         │
                                                       │                     │
                                                       ▼                     │
                                          ┌────────────────────┐             │
                                          │  Relayer / anyone  │             │
                                          │  swapAndSettle()   │             │
                                          └────────┬───────────┘             │
                                                   │                         │
                                                   ▼                         │
                                          ┌────────────────────┐             │
                                          │     SimpleDEX      │             │
                                          │   x*y=k · 0.3%     │             │
                                          └────────┬───────────┘             │
                                                   │ USDC out                │
                                                   └──────────────┬──────────┘
                                                                  │
                                                    net USDC (after 0.3% protocol fee)
                                                                  │
                                         ┌────────────────────────┴──────────────────┐
                                         │                                           │
                                         ▼  (autoVault = false)     (autoVault = true) ▼
                                   ┌───────────┐                        ┌──────────────────────┐
                                   │  Merchant │                        │   PolkaFlowVault     │
                                   │  Wallet   │                        │   ERC4626-lite       │
                                   └───────────┘                        │   5% APY · shares    │
                                                                        └──────────────────────┘
```

### Smart Contracts

**`PolkaFlowRouter`** — The core payment engine.
- Merchants create payment requests (direct USDC or auto-vault)
- Customers lock any ERC20 token (`payWithToken`) or pay directly in stablecoin (`payWithStablecoin`)
- Anyone — including the automated relayer — calls `swapAndSettle(paymentId, minUsdcOut, deadline)` to execute the DEX swap and finalize settlement in one transaction
- 30 bps (0.3%) protocol fee on all settlements, configurable up to 10%, ownable fee recipient
- `IDexAdapter` interface makes the DEX fully pluggable — swap SimpleDEX for Polkadot's native `pallet-asset-conversion` with a single `setDexAdapter()` call, no router redeployment

**`SimpleDEX`** — A real, on-chain constant-product AMM.
- Uniswap v2 formula: `x * y = k`
- 0.3% swap fee (997/1000 multiplier)
- Live pool on Paseo: **1,000 DOT / 5,000 USDC** (implied price: 1 DOT = 5 USDC)
- Supports LP provisioning, removal, and swaps for any ERC20 pair

**`PolkaFlowVault`** — An ERC4626-lite yield vault.
- Proportional share minting on deposit; burning on withdrawal
- 5% APY accrual: `yield = principal × 5% × (elapsed / 365 days)`
- `depositFor(beneficiary, amount)` — called atomically by the router during settlement so the merchant receives shares without ever touching the funds
- Merchants withdraw shares at any time to receive principal + accumulated yield

**`IDexAdapter`** — The pluggability interface.
```solidity
interface IDexAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn,
                  uint256 minAmountOut, address recipient) external returns (uint256);
    function getQuote(address tokenIn, address tokenOut, uint256 amountIn)
                  external view returns (uint256);
}
```
Any contract implementing this interface can be registered with the router. The path to Polkadot's native AMM is one owner transaction away.

**`WWPAS`** — Wrapped PAS (WETH pattern). Lets customers pay with the native gas token via standard ERC20 approval flow.

### Relayer

The relayer (`scripts/relayer.ts`) is a stateless Node.js process:

1. Subscribes to `PaymentInitiated(paymentId, customer, tokenIn, amountIn)` events on the router
2. For each event, fetches a quote: `router.getSwapQuote(tokenIn, amountIn)`
3. Applies 1% slippage: `minOut = quote * 9900 / 10000`
4. Calls `swapAndSettle(paymentId, minOut, now + 300s)`

Because `swapAndSettle()` is permissionless, the relayer is just one possible caller. Any MEV bot, keeper network, or end-user could settle instead — the system doesn't depend on it.

---

## Settlement Math

```
Customer pays:   3 DOT
DEX swap:        3 DOT → 20.00 USDC  (at 1 DOT = 5 USDC, less 0.3% DEX fee)
Protocol fee:    20.00 × 0.30% = 0.06 USDC
Net to merchant: 19.94 USDC

If autoVault = true, after 30 days at 5% APY:
  yield ≈ 19.94 × 0.05 × (30/365) ≈ $0.082
  Claimable: 19.94 + 0.082 = $20.022 USDC
```

---

## Live Deployment — Polkadot Asset Hub Paseo

| Contract | Address | Explorer |
|---|---|---|
| `PolkaFlowRouter` | `0xc30ADf3Cba57e9eB6B9f89Ad3a6722d18072Ac8c` | [View ↗](https://blockscout-testnet.polkadot.io/address/0xc30ADf3Cba57e9eB6B9f89Ad3a6722d18072Ac8c) |
| `SimpleDEX` | `0xAD2085749859ED1FA007E003CBCd34F062297E4C` | [View ↗](https://blockscout-testnet.polkadot.io/address/0xAD2085749859ED1FA007E003CBCd34F062297E4C) |
| `PolkaFlowVault` | `0x124cA7a7D92A89ceA5F41d095Cd14E10941F8636` | [View ↗](https://blockscout-testnet.polkadot.io/address/0x124cA7a7D92A89ceA5F41d095Cd14E10941F8636) |
| `MockUSDC` | `0xF4bF0d92142F5C5780B5E6c5753b13118AF4A870` | [View ↗](https://blockscout-testnet.polkadot.io/address/0xF4bF0d92142F5C5780B5E6c5753b13118AF4A870) |
| `MockDOT` | `0x5479585CEef22bB274C699E47254a583723DB2C2` | [View ↗](https://blockscout-testnet.polkadot.io/address/0x5479585CEef22bB274C699E47254a583723DB2C2) |

**Network:** Polkadot Asset Hub Paseo · Chain ID `420420417`

**Active liquidity pool:** 1,000 DOT / 5,000 USDC on SimpleDEX

**MetaMask auto-config** — the frontend adds Paseo automatically on first connect. Manual config:

| Field | Value |
|---|---|
| Network name | Polkadot Asset Hub Paseo |
| RPC URL | `https://eth-rpc-testnet.polkadot.io/` |
| Chain ID | `420420417` |
| Block explorer | `https://blockscout-testnet.polkadot.io` |
| Native token | PAS |

---

## OpenZeppelin

PolkaFlow uses **OpenZeppelin v5** as a core security dependency across both production contracts — not as a boilerplate token deployment, but composited into custom payment routing and vault logic.

| Library | Contracts | Role |
|---|---|---|
| `SafeERC20` | Router, Vault | Wraps every token transfer. `forceApprove` handles non-standard ERC20s that revert on non-zero→non-zero allowance resets — critical when accepting arbitrary customer payment tokens and resetting DEX adapter allowances between swaps. |
| `ReentrancyGuard` | Router, Vault | Guards all state-modifying functions. Non-optional: the router holds user funds between two separate transactions (`payWithToken` locks, `swapAndSettle` releases), creating a real reentrancy surface if a malicious ERC20 hook triggers re-entry. |
| `Ownable` | Router, Vault | Scopes admin functions that would otherwise allow an attacker to substitute a malicious DEX adapter, redirect vault deposits, drain accumulated fees, or set the protocol fee to 100%. |

Full breakdown of every OZ call site and the attack surface each one protects against: **[CONTRACTS.md → OpenZeppelin Library Usage](./CONTRACTS.md#3-openzeppelin-library-usage)**

---

## Security

- **`ReentrancyGuard`** on all state-modifying functions in `PolkaFlowRouter` and `PolkaFlowVault`
- **`SafeERC20`** on all token transfers (handles non-standard ERC20 return values)
- **`Ownable`** access control on admin functions (fee config, vault registration, DEX adapter)
- **Slippage protection** — every swap enforces `minAmountOut` and a `deadline`
- **Fee cap** — protocol fee hard-capped at 10% (1,000 bps) in the contract
- **Payment ID uniqueness** — derived from `keccak256(merchant, amount, timestamp, block.prevrandao)` preventing pre-computation and ID collision
- **Double-settlement prevention** — `settled` flag checked and set atomically before any token movement

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.24 |
| Contract framework | Hardhat 2.22 + TypeScript |
| Libraries | OpenZeppelin v5 (`SafeERC20`, `Ownable`, `ReentrancyGuard`) |
| Network | Polkadot Asset Hub EVM — Paseo testnet (chain ID `420420417`) |
| DEX | SimpleDEX — constant-product AMM (x\*y=k, Uniswap v2 formula) |
| Relayer | Node.js + ethers.js v6 — event-driven, permissionless, deployed on Railway |
| Frontend | React 18 + Vite 5 + TypeScript — deployed on Vercel |
| Web3 | ethers.js v6 (`BrowserProvider`, event listeners) |
| Wallet | MetaMask (Paseo chain auto-added on connect) |
| Styling | Tailwind CSS + Polkadot brand palette |
| Tests | Hardhat + Mocha + Chai — **40 tests, 100% passing** |

---

## Why Polkadot Asset Hub EVM?

Polkadot Asset Hub is uniquely positioned for payment infrastructure:

- **Native multi-asset support** — DOT, USDC, and custom assets coexist at the protocol level
- **EVM compatibility** — full Solidity toolchain, MetaMask, ethers.js, Hardhat work out of the box
- **Low fees** — negligible gas costs make micropayments viable
- **`pallet-asset-conversion` path** — by upgrading the `IDexAdapter`, PolkaFlow can route through Polkadot's native on-chain AMM instead of SimpleDEX, accessing deeper liquidity with zero additional contract complexity

The `IDexAdapter` interface was designed specifically with this migration in mind.

---

## Project Structure

```
polkaflow/
├── contracts/
│   ├── contracts/
│   │   ├── PolkaFlowRouter.sol    Payment router — permissionless settlement
│   │   ├── SimpleDEX.sol          Constant-product AMM — IDexAdapter impl
│   │   ├── IDexAdapter.sol        Pluggable DEX interface
│   │   ├── PolkaFlowVault.sol     ERC4626-lite yield vault (5% APY)
│   │   ├── WWPAS.sol              Wrapped PAS (WETH pattern)
│   │   ├── MockUSDC.sol           Test stablecoin (6 decimals)
│   │   └── MockDOT.sol            Test DOT (18 decimals)
│   └── hardhat.config.ts
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── MerchantPanel.tsx  Invoice creation, vault dashboard, payment history
│       │   ├── CustomerPanel.tsx  Pay by USDC or DOT, live settlement status
│       │   ├── StatsBar.tsx       Live on-chain volume, fees, vault assets
│       │   ├── FlowDiagram.tsx    Animated 5-step payment flow
│       │   ├── ConnectWallet.tsx  MetaMask connector with Paseo auto-add
│       │   └── ContractsModal.tsx Deployed addresses + Blockscout links
│       ├── hooks/usePolkaFlow.ts  ethers.js provider + contract instances
│       └── deployments.json      Written by deploy script, read by frontend
├── scripts/
│   ├── deploy.ts                  Deploy all contracts, seed pool, wire adapters
│   ├── relayer.ts                 Event-driven permissionless settlement relayer
│   └── demo-flow.ts               End-to-end CLI walkthrough
├── test/
│   ├── PolkaFlowRouter.test.ts    19 tests
│   ├── PolkaFlowVault.test.ts     13 tests
│   └── SimpleDEX.test.ts          8 tests
├── CONTRACTS.md                   Full NatSpec reference + settlement math
├── Dockerfile                     Relayer container (Railway deployment)
├── railway.json                   Railway service config
└── .env.example
```

---

## Quick Start

### Prerequisites

- Node.js >= 18, npm >= 9
- MetaMask browser extension

### Run against live Paseo deployment

```bash
git clone https://github.com/thewoodfish/PolkaFlow.git
cd PolkaFlow
npm install

# Start the relayer (watches Paseo for PaymentInitiated events)
cp .env.example .env
# Set RELAYER_PRIVATE_KEY in .env
npm run relayer:paseo

# Start the frontend
npm run dev
# → http://localhost:5173
```

### Run tests

```bash
npm test
# 40 tests passing
```

### Run locally (Hardhat node)

```bash
# Terminal 1 — local chain
cd contracts && npx hardhat node

# Terminal 2 — deploy + seed pool
npm run deploy:local

# Terminal 3 — relayer
npm run relayer

# Terminal 4 — frontend
npm run dev
```

### Deploy your own instance to Paseo

```bash
cp .env.example .env
# Set DEPLOYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY

npm run deploy:paseo
# Deploys 5 contracts, seeds DOT/USDC pool, writes deployments.json to frontend/src/
```

---

## Demo Walkthrough

### Merchant flow

1. Open [the demo](https://polka-flow-frontend.vercel.app), connect MetaMask
2. **Merchant tab** → mint some MockUSDC (for wallet balance display)
3. Enter an invoice amount (e.g., `20`), optionally enable **Auto-deposit to Vault**
4. Click **Create Payment Request** → copy the payment ID

### Customer flow (PATH A — USDC)

1. **Customer tab** → paste the payment ID
2. Select **USDC** as payment token → click **Pay**
3. Approve USDC spend → confirm payment tx
4. Router deducts fee, settles net USDC to merchant (or vault) atomically
5. `PaymentSettled` event updates both tabs in real time

### Customer flow (PATH B — DOT)

1. **Customer tab** → paste the payment ID
2. Select **DOT**, enter amount (e.g., `3`)
3. Approve DOT spend → click **Pay with DOT**
4. Router emits `PaymentInitiated` — UI shows "Awaiting settlement..."
5. Relayer picks up the event → calls `swapAndSettle()` on-chain (usually within seconds)
6. `PaymentSettled` event fires → UI updates to "Done" with net USDC received

### Vault flow

1. Create invoice with **Auto-deposit to Vault** toggled on
2. After settlement, go to **My Vault** in the Merchant tab
3. See deposited shares, pending yield (5% APY), and claimable total
4. Click **Withdraw** to redeem principal + yield

---

## Vision & Roadmap

PolkaFlow is built to be the payment layer of the Polkadot ecosystem — not a hackathon demo that stops here. Every architectural decision made during this sprint was made with production in mind.

### The Big Idea

Polkadot is uniquely positioned to solve the global payments problem. It has native multi-asset support, shared security, and XCM — a message-passing protocol that lets value move across 50+ parachains atomically. What it has lacked is a **merchant-facing payment primitive** that makes all of that invisible to the end user.

PolkaFlow is that primitive. A merchant creates one invoice. A customer pays with whatever they hold — DOT, USDC, an LP token, a parachain-native asset. The protocol handles the rest. The merchant receives stablecoins and earns yield. They never think about tokens.

### Near-term (v1.1 — next 3 months)

| Feature | Status | Notes |
|---|---|---|
| `pallet-asset-conversion` adapter | Designed | `IDexAdapter` interface already in place — one deployment away |
| Real yield via existing DeFi protocols | Planned | Replace book-entry 5% APY with actual on-chain yield sources |
| Merchant SDK (JS/TS) | Planned | Drop-in library: `polkaflow.createInvoice(amount)` |
| Invoice payment links | Planned | Shareable URLs that deep-link into the payment flow |
| On-chain fee governance | Planned | Merchant DAOs can vote on protocol fee parameters |

### Medium-term (v2 — 6–12 months)

**XCM cross-chain payments.** Today PolkaFlow runs on Asset Hub EVM. The next leap is XCM integration: a customer on Moonbeam, Astar, or HydraDX sends a cross-chain message that triggers settlement on Asset Hub — still in one user action, still settling in USDC to the merchant. The `IDexAdapter` interface already accounts for this; the router does not need to change.

**Native ink! hybrid.** Deploy a companion ink! contract that bridges to Polkadot's Substrate layer, enabling merchants to receive payments directly into Substrate accounts — not just EVM addresses. This removes the EVM requirement from the merchant side entirely.

**Keeper network.** Replace the single relayer with a decentralized keeper network where any node can settle payments for a share of the protocol fee. Fully permissionless end-to-end.

**Real-world merchant integration.** A WooCommerce / Shopify plugin that generates PolkaFlow payment requests at checkout. The customer sees a QR code; their mobile wallet submits the on-chain transaction; the merchant's ERP receives a webhook when `PaymentSettled` fires.

### Why We'll Ship It

The contracts are live on Paseo. The relayer is running. The frontend is deployed. This isn't a whitepaper — it's working software with 40 passing tests, a pluggable architecture, and zero hardcoded dependencies on any single component. Every piece was built to be replaced, upgraded, or extended.

The team is committed to deploying on Polkadot Mainnet when Asset Hub EVM reaches production readiness. The migration path is: swap `MockUSDC` for Circle's native USDC on Asset Hub, point `IDexAdapter` at `pallet-asset-conversion`, and redeploy. The router, vault, and relayer are unchanged.

---

## Hackathon Track

**EVM Smart Contract Track — DeFi & Stablecoin-enabled dApps**

PolkaFlow directly addresses the track criteria:

- **Real on-chain DEX** — `SimpleDEX` is a deployed constant-product AMM with a live liquidity pool on Paseo. Not a mock. Swaps execute on-chain with real reserves.
- **Stablecoin-first** — merchants always receive USDC regardless of payment token, eliminating volatility risk and enabling real commerce on Polkadot.
- **Permissionless settlement** — `swapAndSettle()` has no `onlyOwner` or `onlyRelayer` modifier. Anyone can call it. The automated relayer is a convenience, not a requirement.
- **DeFi composability** — settled USDC routes atomically into an ERC4626-compatible vault. The merchant receives yield-bearing shares in the same settlement transaction.
- **Polkadot-native upgrade path** — `IDexAdapter` decouples the router from any specific AMM. Upgrading to `pallet-asset-conversion` is a single owner call, no redeployment.

---

## License

Apache 2.0
