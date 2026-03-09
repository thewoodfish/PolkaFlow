// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IDexAdapter.sol";

/// @dev Minimal vault interface — only depositFor needed from the router.
interface IPolkaFlowVault {
    function depositFor(address beneficiary, uint256 amount) external returns (uint256 sharesMinted);
}

/// @title PolkaFlowRouter
/// @author PolkaFlow
/// @notice Central payment router deployed on Polkadot Asset Hub EVM (Paseo).
///
///         Two settlement paths:
///
///         PATH A — Stablecoin (single tx):
///           customer.payWithStablecoin(id, usdc, amount)
///           → fee deducted → merchant settled in USDC
///
///         PATH B — Any ERC20 token, e.g. WPAS (two events, one automatic settle):
///           1. customer.payWithToken(id, wpas, amount)
///              → WPAS locked in router, PaymentInitiated emitted
///           2. anyone (PolkaFlow relayer) calls swapAndSettle(id, minOut, deadline)
///              → dexAdapter.swap(wpas → usdc) → fee deducted → merchant settled
///
///         Auto-vault DeFi loop (opt-in per request):
///           createPaymentRequestWithVault(..., autoVault=true)
///           → on settlement, net USDC deposited atomically into PolkaFlowVault
///           → merchant earns yield instead of holding idle USDC
///
///         DEX adapters (swappable without redeploying the router):
///           SimpleDEX      — Solidity constant-product AMM, works on any EVM chain
///           AssetConversion — ink! bridge → pallet-asset-conversion (Paseo native AMM)
///
/// @dev    OpenZeppelin SafeERC20, Ownable, ReentrancyGuard.
contract PolkaFlowRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ─────────────────────────────────────────────────────────────────

    struct PaymentRequest {
        address merchant;    // Merchant wallet that receives settlement.
        uint256 amountUSDC;  // Requested amount in USDC atoms (6 decimals).
        address stablecoin;  // Settlement token (defaults to usdcToken).
        bool    settled;     // True once fully settled.
        uint256 createdAt;   // block.timestamp at creation.
        bool    autoVault;   // Auto-deposit net USDC into vault on settlement.
        address tokenIn;     // Token locked via payWithToken (address(0) = stablecoin path).
        uint256 amountIn;    // Amount locked via payWithToken.
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Canonical USDC token address on this chain.
    address public usdcToken;

    /// @notice Protocol fee in basis points (1 bp = 0.01%). Max 1000 (10%).
    uint256 public feesBps;

    /// @notice Address that accumulates protocol fees.
    address public feeRecipient;

    /// @notice Active DEX adapter for token swaps (PATH B settlement).
    IDexAdapter public dexAdapter;

    /// @notice Registered yield vault for the auto-vault DeFi loop.
    IPolkaFlowVault public vault;

    /// @notice All payment requests, keyed by their unique payment ID.
    mapping(bytes32 => PaymentRequest) public paymentRequests;

    /// @dev Accumulated (unwithdrawn) fees per token.
    mapping(address => uint256) private _accumulatedFees;

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted when a merchant creates a payment request.
    event PaymentCreated(
        bytes32 indexed paymentId,
        address indexed merchant,
        uint256 amountUSDC,
        bool    autoVault
    );

    /// @notice Emitted when a customer locks a token for PATH B payment.
    ///         Settlement is pending until swapAndSettle() is called.
    event PaymentInitiated(
        bytes32 indexed paymentId,
        address indexed payer,
        address tokenIn,
        uint256 amountIn
    );

    /// @notice Emitted when a payment is fully settled.
    event PaymentSettled(
        bytes32 indexed paymentId,
        address indexed merchant,
        uint256 usdcAmount,      // net USDC to merchant (after fee)
        uint256 fee,             // protocol fee retained
        uint256 vaultedAmount    // equals usdcAmount if autoVault, else 0
    );

    /// @notice Emitted when the DEX adapter is updated.
    event DexAdapterSet(address indexed adapter);

    /// @notice Emitted when the vault address is updated.
    event VaultSet(address indexed vault);

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @param _usdcToken    USDC token address on this chain.
    /// @param _feesBps      Initial fee in basis points (e.g. 30 = 0.30%).
    /// @param _feeRecipient Address that receives protocol fees.
    constructor(
        address _usdcToken,
        uint256 _feesBps,
        address _feeRecipient
    ) Ownable(msg.sender) {
        require(_usdcToken    != address(0), "Router: zero USDC address");
        require(_feeRecipient != address(0), "Router: zero fee recipient");
        require(_feesBps      <= 1000,       "Router: fee too high");

        usdcToken    = _usdcToken;
        feesBps      = _feesBps;
        feeRecipient = _feeRecipient;
    }

    // ── Merchant — create request ─────────────────────────────────────────────

    /// @notice Create a payment request (autoVault disabled).
    /// @param amountUSDC Invoice amount in USDC atoms (6 dec). Must be > 0.
    /// @param stablecoin Preferred settlement token. address(0) defaults to usdcToken.
    /// @return paymentId Unique bytes32 ID — read from the PaymentCreated event.
    function createPaymentRequest(
        uint256 amountUSDC,
        address stablecoin
    ) external returns (bytes32 paymentId) {
        paymentId = _createPaymentRequest(amountUSDC, stablecoin, false);
    }

    /// @notice Create a payment request with optional auto-vault routing.
    /// @dev    autoVault=true requires vault to be set, or settlement reverts.
    /// @param amountUSDC Invoice amount in USDC atoms.
    /// @param stablecoin Preferred settlement token. address(0) → usdcToken.
    /// @param autoVault  If true, settled USDC goes directly into the yield vault.
    /// @return paymentId Unique bytes32 ID — read from the PaymentCreated event.
    function createPaymentRequestWithVault(
        uint256 amountUSDC,
        address stablecoin,
        bool    autoVault
    ) external returns (bytes32 paymentId) {
        if (autoVault) require(address(vault) != address(0), "Router: vault not set");
        paymentId = _createPaymentRequest(amountUSDC, stablecoin, autoVault);
    }

    // ── Customer — PATH A (stablecoin, single tx) ─────────────────────────────

    /// @notice Pay with a stablecoin. Settles in one transaction.
    /// @dev    Caller must approve(router, amount) for `stablecoin` first.
    /// @param paymentId  Target payment request ID.
    /// @param stablecoin ERC20 stablecoin the customer is paying with.
    /// @param amount     Gross amount (must be ≥ req.amountUSDC). Fee deducted inside.
    function payWithStablecoin(
        bytes32 paymentId,
        address stablecoin,
        uint256 amount
    ) external nonReentrant {
        PaymentRequest storage req = paymentRequests[paymentId];
        require(req.createdAt != 0,         "Router: unknown payment");
        require(!req.settled,               "Router: already settled");
        require(stablecoin != address(0),   "Router: zero token");
        require(amount >= req.amountUSDC,   "Router: insufficient amount");

        uint256 feeAmt  = (amount * feesBps) / 10_000;
        uint256 netAmt  = amount - feeAmt;

        IERC20(stablecoin).safeTransferFrom(msg.sender, address(this), amount);
        if (feeAmt > 0) _accumulatedFees[stablecoin] += feeAmt;

        req.settled = true;
        uint256 vaultedAmt = _settle(req.merchant, stablecoin, netAmt, req.autoVault);

        emit PaymentSettled(paymentId, req.merchant, netAmt, feeAmt, vaultedAmt);
    }

    // ── Customer — PATH B step 1: lock token ─────────────────────────────────

    /// @notice Lock an ERC20 token in the router (e.g. WPAS) to begin a swap-based payment.
    /// @dev    Caller must approve(router, amountIn) for `tokenIn` first.
    ///         Settlement completes when swapAndSettle() is called (by anyone).
    /// @param paymentId Target payment request ID.
    /// @param tokenIn   ERC20 token to lock (e.g. WWPAS).
    /// @param amountIn  Amount to lock. Must be > 0.
    function payWithToken(
        bytes32 paymentId,
        address tokenIn,
        uint256 amountIn
    ) external nonReentrant {
        PaymentRequest storage req = paymentRequests[paymentId];
        require(req.createdAt  != 0,         "Router: unknown payment");
        require(!req.settled,                "Router: already settled");
        require(tokenIn != address(0),       "Router: zero token");
        require(amountIn > 0,               "Router: zero amount");
        require(req.tokenIn == address(0),   "Router: already initiated");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        req.tokenIn  = tokenIn;
        req.amountIn = amountIn;

        emit PaymentInitiated(paymentId, msg.sender, tokenIn, amountIn);
    }

    // ── Permissionless — PATH B step 2: swap + settle ────────────────────────

    /// @notice Execute the DEX swap and settle the merchant — callable by anyone.
    /// @dev    The PolkaFlow relayer calls this automatically after seeing a
    ///         PaymentInitiated event. No owner privilege required.
    ///
    ///         Flow:
    ///           1. Approve dexAdapter to pull req.tokenIn.
    ///           2. dexAdapter.swap(tokenIn → USDC) → USDC lands in this contract.
    ///           3. Deduct fee, settle net to merchant (or vault).
    ///           4. Emit PaymentSettled.
    ///
    /// @param paymentId  Target payment request (must be in "initiated" state).
    /// @param minUsdcOut Minimum USDC output — slippage protection.
    /// @param deadline   Unix timestamp after which the call reverts.
    function swapAndSettle(
        bytes32 paymentId,
        uint256 minUsdcOut,
        uint256 deadline
    ) external nonReentrant {
        require(block.timestamp <= deadline,            "Router: deadline expired");

        PaymentRequest storage req = paymentRequests[paymentId];
        require(req.createdAt != 0,                     "Router: unknown payment");
        require(!req.settled,                           "Router: already settled");
        require(req.tokenIn  != address(0),             "Router: not initiated");
        require(address(dexAdapter) != address(0),      "Router: dex not configured");

        address tokenIn  = req.tokenIn;
        uint256 amountIn = req.amountIn;

        // Approve DEX adapter to pull the locked token from this contract.
        IERC20(tokenIn).forceApprove(address(dexAdapter), amountIn);

        // Execute on-chain swap — USDC output lands in this contract.
        uint256 usdcOut = dexAdapter.swap(
            tokenIn, usdcToken, amountIn, minUsdcOut, address(this)
        );

        uint256 feeAmt  = (usdcOut * feesBps) / 10_000;
        uint256 netAmt  = usdcOut - feeAmt;

        if (feeAmt > 0) _accumulatedFees[usdcToken] += feeAmt;

        req.settled = true;
        uint256 vaultedAmt = _settle(req.merchant, usdcToken, netAmt, req.autoVault);

        emit PaymentSettled(paymentId, req.merchant, netAmt, feeAmt, vaultedAmt);
    }

    /// @notice Get a live swap quote for the frontend / relayer.
    /// @param tokenIn  Token to sell.
    /// @param amountIn Amount of tokenIn.
    /// @return usdcOut Expected USDC output.
    function getSwapQuote(address tokenIn, uint256 amountIn)
        external view returns (uint256 usdcOut)
    {
        require(address(dexAdapter) != address(0), "Router: dex not configured");
        return dexAdapter.getQuote(tokenIn, usdcToken, amountIn);
    }

    // ── Owner / Admin ─────────────────────────────────────────────────────────

    /// @notice Set or update the DEX adapter.
    /// @dev    Swap between SimpleDEX and the ink!/pallet-asset-conversion bridge
    ///         at any time without redeploying the router.
    function setDexAdapter(address _dexAdapter) external onlyOwner {
        require(_dexAdapter != address(0), "Router: zero adapter address");
        dexAdapter = IDexAdapter(_dexAdapter);
        emit DexAdapterSet(_dexAdapter);
    }

    /// @notice Register the PolkaFlowVault for the auto-vault DeFi loop.
    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "Router: zero vault address");
        vault = IPolkaFlowVault(_vault);
        emit VaultSet(_vault);
    }

    /// @notice Withdraw accumulated protocol fees for `token` to feeRecipient.
    function withdrawFees(address token) external onlyOwner {
        uint256 amount = _accumulatedFees[token];
        require(amount > 0, "Router: no fees to withdraw");
        _accumulatedFees[token] = 0;
        IERC20(token).safeTransfer(feeRecipient, amount);
    }

    /// @notice Update the protocol fee (max 1000 = 10%).
    function setFeesBps(uint256 _feesBps) external onlyOwner {
        require(_feesBps <= 1000, "Router: fee too high");
        feesBps = _feesBps;
    }

    /// @notice Update the fee recipient.
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Router: zero address");
        feeRecipient = _feeRecipient;
    }

    // ── View ──────────────────────────────────────────────────────────────────

    /// @notice Full payment request details by ID.
    function getPaymentRequest(bytes32 paymentId)
        external view returns (PaymentRequest memory)
    {
        return paymentRequests[paymentId];
    }

    /// @notice Accumulated (unwithdrawn) fee balance for a token.
    function accumulatedFees(address token) external view returns (uint256) {
        return _accumulatedFees[token];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _createPaymentRequest(
        uint256 amountUSDC,
        address stablecoin,
        bool    autoVault_
    ) internal returns (bytes32 paymentId) {
        require(amountUSDC > 0, "Router: zero amount");

        address settlementToken = stablecoin == address(0) ? usdcToken : stablecoin;

        paymentId = keccak256(abi.encodePacked(
            msg.sender,
            amountUSDC,
            block.timestamp,
            block.prevrandao
        ));

        require(paymentRequests[paymentId].createdAt == 0, "Router: payment ID collision");

        paymentRequests[paymentId] = PaymentRequest({
            merchant:   msg.sender,
            amountUSDC: amountUSDC,
            stablecoin: settlementToken,
            settled:    false,
            createdAt:  block.timestamp,
            autoVault:  autoVault_,
            tokenIn:    address(0),
            amountIn:   0
        });

        emit PaymentCreated(paymentId, msg.sender, amountUSDC, autoVault_);
    }

    /// @dev Disburse net USDC to merchant directly or via vault.depositFor.
    function _settle(
        address merchant,
        address token,
        uint256 netAmount,
        bool    autoVault_
    ) internal returns (uint256 vaultedAmount) {
        if (autoVault_) {
            require(address(vault) != address(0), "Router: vault not set");
            IERC20(token).forceApprove(address(vault), netAmount);
            vault.depositFor(merchant, netAmount);
            vaultedAmount = netAmount;
        } else {
            IERC20(token).safeTransfer(merchant, netAmount);
            vaultedAmount = 0;
        }
    }
}
