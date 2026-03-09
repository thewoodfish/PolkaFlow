# PolkaFlow — Contract Reference

Complete NatSpec documentation, fee & yield mathematics, and integration guide.

---

## Table of Contents

1. [PolkaFlowRouter](#1-polkaflowrouter)
   - [State Variables](#state-variables)
   - [Events](#events)
   - [Functions — Merchant](#functions--merchant)
   - [Functions — Customer](#functions--customer)
   - [Functions — Owner / Admin](#functions--owner--admin)
   - [Functions — View](#functions--view)
   - [Internal Helpers](#internal-helpers)
2. [PolkaFlowVault](#2-polkaflowvault)
   - [State Variables](#state-variables-1)
   - [Events](#events-1)
   - [Functions — External](#functions--external)
   - [Functions — View](#functions--view-1)
   - [Internal Helpers](#internal-helpers-1)
3. [MockUSDC](#3-mockusdc)
4. [MockDOT](#4-mockdot)
5. [Fee Math](#5-fee-math)
6. [Vault Yield Formula](#6-vault-yield-formula)
7. [PaymentId Derivation](#7-paymentid-derivation)
8. [Extending to a Real DEX](#8-extending-to-a-real-dex)

---

## 1. PolkaFlowRouter

```
contracts/contracts/PolkaFlowRouter.sol
Solidity ^0.8.20 · Ownable · ReentrancyGuard · SafeERC20
```

Central payment router. Accepts customer ERC20 payments, deducts a protocol fee, and settles net USDC to the merchant — either directly or atomically into `PolkaFlowVault`.

### State Variables

| Variable | Type | Description |
|---|---|---|
| `usdcToken` | `address public` | Canonical USDC token address on this chain. |
| `feesBps` | `uint256 public` | Protocol fee in basis points (1 bp = 0.01%). Default: 30 (0.30%). Max: 1000 (10%). |
| `feeRecipient` | `address public` | Address that accumulates protocol fees. |
| `vault` | `IPolkaFlowVault public` | Registered `PolkaFlowVault` for the auto-vault DeFi loop. `address(0)` when unset. |
| `paymentRequests` | `mapping(bytes32 => PaymentRequest)` | All payment requests keyed by their unique ID. |

**`PaymentRequest` struct:**

| Field | Type | Description |
|---|---|---|
| `merchant` | `address` | Merchant wallet that will receive settlement funds. |
| `amountUSDC` | `uint256` | Requested amount denominated in USDC (6 decimals). |
| `stablecoin` | `address` | Preferred settlement token (defaults to `usdcToken`). |
| `settled` | `bool` | True once fully settled. Prevents double-settlement. |
| `createdAt` | `uint256` | `block.timestamp` at creation. Zero means request does not exist. |
| `autoVault` | `bool` | If true, net USDC is deposited into the vault for the merchant rather than transferred directly. |

---

### Events

#### `PaymentCreated`

```solidity
event PaymentCreated(
    bytes32 indexed paymentId,
    address indexed merchant,
    uint256 amountUSDC,
    bool    autoVault
);
```

Emitted when a merchant calls `createPaymentRequest` or `createPaymentRequestWithVault`. The `paymentId` must be extracted from this event — do **not** use `staticCall` to predict the ID because `block.prevrandao` differs between simulation and mining.

---

#### `PaymentInitiated`

```solidity
event PaymentInitiated(
    bytes32 indexed paymentId,
    address indexed payer,
    address tokenIn,
    uint256 amountIn
);
```

Emitted by `payWithToken`. Signals that a non-stablecoin token has been locked by the router. Settlement is pending until `simulateSwapAndSettle` is called.

---

#### `PaymentSettled`

```solidity
event PaymentSettled(
    bytes32 indexed paymentId,
    address indexed merchant,
    uint256 usdcAmount,    // net USDC received by merchant (after fee)
    uint256 fee,           // protocol fee retained by router
    uint256 vaultedAmount  // equals usdcAmount when autoVault=true, else 0
);
```

Emitted on final settlement by either `payWithStablecoin` or `simulateSwapAndSettle`.

---

#### `VaultSet`

```solidity
event VaultSet(address indexed vault);
```

Emitted when the owner registers or updates the vault address via `setVault`.

---

### Functions — Merchant

#### `createPaymentRequest`

```solidity
function createPaymentRequest(
    uint256 amountUSDC,
    address stablecoin
) external returns (bytes32 paymentId)
```

Creates a new payment request with `autoVault = false`. A convenience wrapper around `createPaymentRequestWithVault`.

| Parameter | Description |
|---|---|
| `amountUSDC` | Invoice amount in USDC atoms (6 decimals). Must be > 0. E.g. `20_000_000` = $20.00 USDC. |
| `stablecoin` | Preferred settlement token. Pass `address(0)` to default to `usdcToken`. |

**Returns:** `paymentId` — unique `bytes32` identifier. Read from the `PaymentCreated` event in the receipt.

---

#### `createPaymentRequestWithVault`

```solidity
function createPaymentRequestWithVault(
    uint256 amountUSDC,
    address stablecoin,
    bool    autoVault
) external returns (bytes32 paymentId)
```

Creates a payment request with optional auto-vault routing.

| Parameter | Description |
|---|---|
| `amountUSDC` | Invoice amount in USDC atoms. Must be > 0. |
| `stablecoin` | Preferred settlement token. `address(0)` defaults to `usdcToken`. |
| `autoVault` | If `true`, settled net USDC is deposited directly into `PolkaFlowVault` for the merchant. Reverts if vault not set. |

**Auto-vault DeFi loop:** The vault must be registered via `setVault` before `autoVault = true` can be used. When the payment settles, `_settle` calls `vault.depositFor(merchant, netAmount)` — the merchant receives vault shares, not raw USDC. Shares can be redeemed later via `vault.withdraw(shares)`.

---

### Functions — Customer

#### `payWithStablecoin`

```solidity
function payWithStablecoin(
    bytes32 paymentId,
    address stablecoin,
    uint256 amount
) external nonReentrant
```

Pay a request directly with a stablecoin. Settles in a single transaction.

**Pre-condition:** Caller must call `IERC20(stablecoin).approve(router, amount)` before calling this function.

| Parameter | Description |
|---|---|
| `paymentId` | Target payment request ID (from `PaymentCreated` event). |
| `stablecoin` | ERC20 stablecoin address. Does not need to match the merchant's preferred stablecoin. |
| `amount` | Gross amount to send. Must be >= `req.amountUSDC`. Fee is deducted from this amount. |

**Settlement flow:**
```
gross  = amount
fee    = gross * feesBps / 10_000
net    = gross - fee
→ fee accumulated in _accumulatedFees[stablecoin]
→ net transferred to merchant (or vault.depositFor if autoVault)
```

**Reverts:** unknown payment ID, already settled, zero stablecoin address, amount < amountUSDC.

---

#### `payWithToken`

```solidity
function payWithToken(
    bytes32 paymentId,
    address tokenIn,
    uint256 amountIn
) external nonReentrant
```

Initiate payment with any ERC20 token (e.g. wrapped DOT). The token is held by the router until `simulateSwapAndSettle` is called by the owner.

**Pre-condition:** Caller must call `IERC20(tokenIn).approve(router, amountIn)` first.

| Parameter | Description |
|---|---|
| `paymentId` | Target payment request ID. |
| `tokenIn` | ERC20 token the customer is paying with. Must not be `address(0)`. |
| `amountIn` | Token amount to lock in the router. Must be > 0. |

After this call the payment is **initiated but not settled**. The `PaymentInitiated` event is emitted. Settlement requires the owner to call `simulateSwapAndSettle` with the USDC swap output.

**Reverts:** unknown payment ID, already settled, zero token, zero amount.

---

### Functions — Owner / Admin

#### `simulateSwapAndSettle`

```solidity
function simulateSwapAndSettle(
    bytes32 paymentId,
    uint256 usdcOut,
    address _usdcToken
) external onlyOwner nonReentrant
```

Finalises a token-based payment after a (simulated) DEX swap. The owner confirms how much USDC was obtained and the contract must already hold at least `usdcOut` of `_usdcToken`.

> **Demo function.** In production this is replaced by an on-chain DEX integration (see [Extending to a Real DEX](#8-extending-to-a-real-dex)).

| Parameter | Description |
|---|---|
| `paymentId` | Target payment request ID (must be in initiated-but-not-settled state). |
| `usdcOut` | USDC amount the swap produced. Fee is deducted from this. |
| `_usdcToken` | USDC token address for settlement (must match what was minted to the router). |

**For the demo:** Before calling this, the demo script (or the UI's "Simulate XCM Settlement" button) first calls `MockUSDC.mint(router, usdcOut)` to fund the router with the simulated swap output.

**Reverts:** not owner, unknown payment, already settled, zero `usdcOut`, zero `_usdcToken`.

---

#### `setVault`

```solidity
function setVault(address _vault) external onlyOwner
```

Register the `PolkaFlowVault` contract. Must be called after deployment before any `autoVault = true` payments can be settled.

Can be updated at any time. Existing unsettled requests retain their `autoVault` flag and will use the vault address set at the time of settlement.

---

#### `withdrawFees`

```solidity
function withdrawFees(address token) external onlyOwner
```

Transfers all accumulated protocol fees for `token` to `feeRecipient`. Resets the fee balance to zero.

---

#### `setFeesBps`

```solidity
function setFeesBps(uint256 _feesBps) external onlyOwner
```

Update the protocol fee. Maximum 1000 (10%). Takes effect on the next payment.

---

#### `setFeeRecipient`

```solidity
function setFeeRecipient(address _feeRecipient) external onlyOwner
```

Update the fee recipient wallet.

---

### Functions — View

#### `getPaymentRequest`

```solidity
function getPaymentRequest(bytes32 paymentId)
    external view returns (PaymentRequest memory)
```

Returns full details of a payment request. The frontend uses this to validate a payment ID before showing the invoice to the customer. A request is valid when `createdAt != 0` and `merchant != address(0)`.

---

#### `accumulatedFees`

```solidity
function accumulatedFees(address token) external view returns (uint256)
```

Returns the current accumulated (unwithdrawn) fee balance for `token`.

---

### Internal Helpers

#### `_createPaymentRequest`

```solidity
function _createPaymentRequest(
    uint256 amountUSDC,
    address stablecoin,
    bool    autoVault_
) internal returns (bytes32 paymentId)
```

Derives a unique payment ID:

```solidity
paymentId = keccak256(abi.encodePacked(
    msg.sender,       // merchant address
    amountUSDC,       // requested amount
    block.timestamp,  // creation time
    block.prevrandao  // block randomness (changes each block)
));
```

The use of `block.prevrandao` prevents the ID from being predicted via `staticCall`, since simulation and mining occur in different blocks with different randomness values. Always parse the ID from the mined `PaymentCreated` event.

---

#### `_settle`

```solidity
function _settle(
    address merchant,
    address token,
    uint256 netAmount,
    bool    autoVault_
) internal returns (uint256 vaultedAmount)
```

Handles final net USDC disbursement.

- **`autoVault_ = false`:** `safeTransfer(merchant, netAmount)`. Direct wallet transfer.
- **`autoVault_ = true`:** `forceApprove(vault, netAmount)` then `vault.depositFor(merchant, netAmount)`. USDC moves router → vault in one atomic call; vault mints shares directly to merchant. No separate merchant transaction required.

---

## 2. PolkaFlowVault

```
contracts/contracts/PolkaFlowVault.sol
Solidity ^0.8.20 · ReentrancyGuard · SafeERC20
```

ERC4626-lite yield vault. Merchants deposit USDC and earn a simulated 5% APY. Shares are minted proportionally on deposit and burned on withdrawal. `depositFor` allows the router to deposit on behalf of a merchant atomically during settlement.

### State Variables

| Variable | Type | Description |
|---|---|---|
| `asset` | `IERC20 public immutable` | USDC token accepted and distributed by this vault. Set once in constructor. |
| `totalShares` | `uint256 public` | Total shares outstanding across all depositors. |
| `_shares` | `mapping(address => uint256) private` | Shares held per depositor. |
| `_lastInteraction` | `mapping(address => uint256) private` | `block.timestamp` of each user's last deposit or withdrawal. Used as yield accrual start. |
| `_principalOf` | `mapping(address => uint256) private` | Recorded principal (USDC atoms) per user. Includes previously settled yield. |

**Constants:**

| Constant | Value | Description |
|---|---|---|
| `SECONDS_PER_YEAR` | `365 days` = 31,536,000 | Denominator for APY time-fraction. |
| `APY_NUM` | `5` | APY numerator. |
| `APY_DEN` | `100` | APY denominator. Together: 5/100 = 5%. |

---

### Events

#### `Deposited`

```solidity
event Deposited(
    address indexed user,
    uint256 amount,   // USDC deposited (6 decimals)
    uint256 shares    // vault shares minted
);
```

Emitted for both `deposit` and `depositFor`. `user` is the beneficiary (share recipient).

---

#### `Withdrawn`

```solidity
event Withdrawn(
    address indexed user,
    uint256 shares,   // vault shares burned
    uint256 amount,   // total USDC returned (principal + yield)
    uint256 yield     // yield component included in amount
);
```

---

### Functions — External

#### `deposit`

```solidity
function deposit(uint256 amount)
    external nonReentrant returns (uint256 sharesMinted)
```

Deposit `amount` USDC and receive proportional vault shares. On the first deposit (empty vault), shares are minted 1:1 with USDC atoms to bootstrap the share price.

**Pre-condition:** `asset.approve(vault, amount)` must be called first.

**Share minting formula:**

```
First deposit (totalShares == 0):
    sharesMinted = amount

Subsequent deposits:
    sharesMinted = amount * totalShares / poolAssets
```

---

#### `depositFor`

```solidity
function depositFor(address beneficiary, uint256 amount)
    external nonReentrant returns (uint256 sharesMinted)
```

Deposit `amount` USDC on behalf of `beneficiary`. The caller (typically `PolkaFlowRouter`) transfers USDC and shares are minted directly to `beneficiary`.

This is the entry point for the **auto-vault DeFi loop**: the router holds settled USDC, calls `forceApprove(vault, net)` then `depositFor(merchant, net)`. The vault pulls USDC from the router and mints shares to the merchant — entirely in one transaction initiated by the customer's payment.

---

#### `withdraw`

```solidity
function withdraw(uint256 shares)
    external nonReentrant returns (uint256 usdcReturned)
```

Burn `shares` and receive proportional USDC. Accrued yield is folded into principal before calculating the payout, so long-held shares return more USDC than the original deposit.

```
usdcReturned = shares * poolAssets / totalShares
```

Partial withdrawals are supported — burn fewer shares than your balance.

---

### Functions — View

#### `balanceOf`

```solidity
function balanceOf(address user) external view returns (uint256)
```

Returns vault shares held by `user`.

---

#### `totalAssets`

```solidity
function totalAssets() external view returns (uint256)
```

Returns current USDC balance held by the vault contract (`asset.balanceOf(address(this))`). Used by `StatsBar` in the frontend.

---

#### `getYield`

```solidity
function getYield(address user) external view returns (uint256)
```

Returns the simulated yield accrued by `user` since their last interaction (deposit or withdrawal), in USDC atoms. Does not modify state.

---

#### `previewWithdrawAll`

```solidity
function previewWithdrawAll(address user) external view returns (uint256)
```

Returns an estimate of how much USDC `user` would receive if they withdrew all their shares right now (principal + pending yield). Used by the frontend Vault card to show the "Claimable" amount.

---

### Internal Helpers

#### `_deposit`

```solidity
function _deposit(
    address payer,
    address beneficiary,
    uint256 amount
) internal returns (uint256 sharesMinted)
```

Shared core logic for `deposit` and `depositFor`. Settles pending yield for the beneficiary first (via `_settleYield`), then calculates and mints shares.

---

#### `_pendingYield`

```solidity
function _pendingYield(address user) internal view returns (uint256)
```

Pure calculation — does not modify state:

```
yield = principal * APY_NUM * elapsed
        / (APY_DEN * SECONDS_PER_YEAR)
      = principal * 5 * elapsed
        / (100 * 31_536_000)
```

Where `elapsed = block.timestamp - _lastInteraction[user]`.

---

#### `_settleYield`

```solidity
function _settleYield(address user) internal
```

Folds `_pendingYield(user)` into `_principalOf[user]` and resets `_lastInteraction[user]` to `block.timestamp`. Called at the start of every deposit and withdrawal to ensure yield compounds correctly across multiple interactions.

> **Note:** This is a book-entry operation. The yield amount is added to the principal record without any corresponding USDC being transferred in. For actual withdrawals of yield to succeed, the vault contract must hold sufficient USDC (either from other depositors' funds or from an external yield source). See the test `"can actually withdraw principal + yield when vault is funded"` for an example of how to fund the yield pool.

---

## 3. MockUSDC

```
contracts/contracts/MockUSDC.sol
ERC20("USD Coin", "USDC") · 6 decimals · open mint
```

Test stablecoin. Anyone can call `mint(to, amount)` — no access control, for demo purposes only.

```solidity
function mint(address to, uint256 amount) external {
    _mint(to, amount);
}
```

**Decimals:** 6. `1_000_000` atoms = $1.00 USDC.

---

## 4. MockDOT

```
contracts/contracts/MockDOT.sol
ERC20("Polkadot", "DOT") · 18 decimals · open mint
```

Test wrapped DOT token. Anyone can call `mint(to, amount)`.

**Decimals:** 18. `1_000_000_000_000_000_000` atoms = 1.0 DOT (matching the real DOT token denomination).

---

## 5. Fee Math

The router charges a protocol fee expressed in **basis points** (bps):

```
1 basis point = 0.01%
fee = grossAmount * feesBps / 10_000
net = grossAmount - fee
```

### Default fee: 30 bps = 0.30%

| Gross Amount | Fee (30 bps) | Net to Merchant |
|---|---|---|
| $10.00 USDC (10,000,000) | $0.03 (30,000) | $9.97 (9,970,000) |
| $20.00 USDC (20,000,000) | $0.06 (60,000) | $19.94 (19,940,000) |
| $100.00 USDC (100,000,000) | $0.30 (300,000) | $99.70 (99,700,000) |
| $1,000.00 USDC (1,000,000,000) | $3.00 (3,000,000) | $997.00 (997,000,000) |

### Fee range

| `feesBps` | Percentage | Description |
|---|---|---|
| `0` | 0.00% | Fee-free |
| `10` | 0.10% | Minimal fee |
| `30` | 0.30% | Default (comparable to stablecoin transfer fees) |
| `100` | 1.00% | Typical DeFi swap fee tier |
| `1000` | 10.00% | Maximum allowed (`require(_feesBps <= 1000)`) |

### Solidity integer arithmetic note

The fee calculation uses integer division. Rounding is always **floor** (towards zero), slightly favouring the customer:

```solidity
uint256 fee       = (amount * feesBps) / 10_000;
uint256 netAmount = amount - fee;
```

For a $20 payment with 30 bps: `(20_000_000 * 30) / 10_000 = 600_000_000 / 10_000 = 60_000`. No rounding error at this scale.

---

## 6. Vault Yield Formula

The vault simulates **5% APY (Annual Percentage Yield)** using a simple linear accrual model:

```
yield = principal × rate × (elapsed / year)

where:
  principal = _principalOf[user]        (USDC atoms, 6 decimals)
  rate      = 5 / 100                   (5% APY)
  elapsed   = block.timestamp - _lastInteraction[user]   (seconds)
  year      = 365 × 24 × 60 × 60        = 31,536,000 seconds

Solidity:
  yield = (principal * 5 * elapsed) / (100 * 31_536_000)
```

### Example yield calculations

| Principal | Time held | Yield | Annual rate |
|---|---|---|---|
| $100.00 | 1 year (31,536,000 s) | $5.00 | 5.000% |
| $100.00 | 6 months (15,768,000 s) | $2.50 | 5.000% |
| $100.00 | 3 months (7,884,000 s) | $1.25 | 5.000% |
| $100.00 | 1 day (86,400 s) | $0.013699 | 5.000% |
| $20.00 | 30 days (2,592,000 s) | $0.082192 | 5.000% |

### Compounding behaviour

Yield is **compounded at every interaction** (deposit or withdrawal). When a user deposits more tokens or withdraws, `_settleYield` folds the pending yield into `_principalOf`, so subsequent yield accrues on the larger principal. This is effectively **continuous compounding triggered by interactions** rather than true continuous compounding.

### Book-entry limitation

In this demo, `_settleYield` adds to the recorded principal without transferring real USDC into the vault. For actual yield withdrawals to succeed, the vault needs a funded USDC balance:

1. **External funding:** An admin mints or transfers USDC to the vault address.
2. **Production model:** The vault would deploy deposited USDC into an underlying lending protocol (e.g. a Hub-native money market), and the yield would be earned from real borrower interest.

---

## 7. PaymentId Derivation

```solidity
paymentId = keccak256(abi.encodePacked(
    msg.sender,       // merchant address (20 bytes)
    amountUSDC,       // uint256 (32 bytes)
    block.timestamp,  // uint256 (32 bytes)
    block.prevrandao  // uint256 (32 bytes)
));
```

**Why `block.prevrandao`?**

`block.prevrandao` (formerly `block.difficulty` in pre-Merge EVM) provides per-block randomness derived from the validator's RANDAO reveal. It changes every block, meaning:

- Two merchants creating identical requests in the same second get different IDs (collision resistance).
- The ID cannot be pre-computed via `eth_call` / `staticCall` — the simulated call runs in one block, but the mined transaction lands in the next block where `prevrandao` has a different value.

**Practical consequence for tests and integrations:**

Always extract `paymentId` from the mined `PaymentCreated` event, not from a simulated call:

```typescript
// WRONG — staticCall returns a different prevrandao
const id = await router.createPaymentRequest.staticCall(amount, addr);

// CORRECT — parse from receipt
const tx      = await router.createPaymentRequest(amount, addr);
const receipt = await tx.wait();
const log     = receipt.logs.map(l => router.interface.parseLog(l))
                             .find(p => p?.name === "PaymentCreated");
const paymentId = log.args.paymentId;
```

---

## 8. Extending to a Real DEX

The current `simulateSwapAndSettle` is an **owner-only demo function** that accepts a manually-specified `usdcOut`. In production on Polkadot Hub EVM, replace it with a direct DEX integration:

### Step 1 — Add the DEX router interface

```solidity
interface IHubDex {
    /// @dev Swap exact `amountIn` of `tokenIn` for at least `minOut` of `tokenOut`.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
```

### Step 2 — Store the DEX address

```solidity
IHubDex public dex;

function setDex(address _dex) external onlyOwner {
    dex = IHubDex(_dex);
    emit DexSet(_dex);
}
```

### Step 3 — Replace `simulateSwapAndSettle` with `swapAndSettle`

```solidity
/// @notice Permissionless: anyone can trigger swap + settle for a pending payment.
function swapAndSettle(
    bytes32 paymentId,
    address tokenIn,
    uint256 amountIn,
    uint256 minUsdcOut   // slippage protection
) external nonReentrant {
    PaymentRequest storage req = paymentRequests[paymentId];
    require(req.createdAt != 0,  "Router: unknown payment");
    require(!req.settled,        "Router: already settled");
    require(address(dex) != address(0), "Router: dex not set");

    // The tokenIn was locked here by payWithToken — approve the DEX to pull it.
    IERC20(tokenIn).forceApprove(address(dex), amountIn);

    // Execute the on-chain swap. USDC lands directly in this contract.
    uint256 usdcOut = dex.swapExactIn(
        tokenIn,
        usdcToken,
        amountIn,
        minUsdcOut,
        address(this)
    );

    uint256 fee       = (usdcOut * feesBps) / 10_000;
    uint256 netAmount = usdcOut - fee;

    if (fee > 0) {
        _accumulatedFees[usdcToken] += fee;
    }

    req.settled = true;

    uint256 vaultedAmount = _settle(req.merchant, usdcToken, netAmount, req.autoVault);

    emit PaymentSettled(paymentId, req.merchant, netAmount, fee, vaultedAmount);
}
```

### Step 4 — XCM production path

For true cross-chain payments (DOT on a parachain → USDC on Asset Hub):

1. Customer calls an **XCM sender contract** on the source chain. It locks DOT and sends an XCM message to Asset Hub with the `paymentId` as memo data.
2. An **XCM receiver contract** on Asset Hub receives the message, holds the bridged DOT, and calls `swapAndSettle(paymentId, wDOT, amount, minUsdc)`.
3. The router swaps via the Hub DEX, settles USDC to the merchant, and emits `PaymentSettled`.

The `payWithToken` + `swapAndSettle` split in the current code already mirrors this architecture — step (1) corresponds to `payWithToken` (token lock + event), step (2)+(3) correspond to `swapAndSettle` (swap + settle). The XCM integration replaces the manual owner call with an autonomous on-chain trigger.

### Slippage & price feeds

For production, consider adding:

- **Price oracle check:** compare the expected USDC output (from a Chainlink or Substrate price feed) against `minUsdcOut` to protect merchants from sandwich attacks.
- **Deadline parameter:** revert stale settlements by checking `block.timestamp <= deadline`.
- **Partial fill handling:** if the swap returns less USDC than `req.amountUSDC`, decide whether to refund the customer or settle the partial amount and credit the difference as a future liability.
