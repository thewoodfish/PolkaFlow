// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PolkaFlowVault
 * @author PolkaFlow
 * @notice A simple DeFi yield vault for idle merchant USDC.
 *         Merchants deposit USDC between payment settlements and earn a
 *         simulated 5 % APY.  Shares are minted proportionally on deposit
 *         and burned on withdrawal, following an ERC-4626-lite model.
 *
 *         The PolkaFlowRouter can deposit directly into this vault on behalf
 *         of a merchant via `depositFor`, enabling the auto-vault DeFi loop:
 *         Customer pays → Router settles → Vault earns yield → Merchant
 *         withdraws more than they received.
 *
 * @dev    Yield formula: principal * 5% * (secondsHeld / 365 days)
 *         This is a book-entry simulation for demo purposes; in production,
 *         real yield would be sourced from an underlying lending protocol
 *         and the vault owner would need to fund the yield pool.
 */
contract PolkaFlowVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @dev Seconds in a 365-day year, used for APY calculation.
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @dev 5 % APY numerator — yield = principal * APY_NUM / APY_DEN * elapsed / SECONDS_PER_YEAR
    uint256 private constant APY_NUM = 5;
    uint256 private constant APY_DEN = 100;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice The USDC token accepted and distributed by this vault.
    IERC20 public immutable asset;

    /// @notice Total shares outstanding across all depositors.
    uint256 public totalShares;

    /// @notice Shares held per depositor.
    mapping(address => uint256) private _shares;

    /// @notice Timestamp of each depositor's last interaction (deposit/withdraw).
    ///         Used as the start point for yield accrual.
    mapping(address => uint256) private _lastInteraction;

    /// @notice Principal (in USDC atoms) recorded for each user.
    ///         Updated on every interaction; includes previously settled yield.
    mapping(address => uint256) private _principalOf;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when USDC is deposited into the vault for a user.
    /// @param user   Wallet that will own the minted shares.
    /// @param amount USDC deposited (6 decimals).
    /// @param shares Vault shares minted.
    event Deposited(
        address indexed user,
        uint256 amount,
        uint256 shares
    );

    /// @notice Emitted when a user burns shares to withdraw USDC.
    /// @param user   Wallet that initiated the withdrawal.
    /// @param shares Vault shares burned.
    /// @param amount Total USDC returned (principal + yield).
    /// @param yield  Simulated yield component included in `amount`.
    event Withdrawn(
        address indexed user,
        uint256 shares,
        uint256 amount,
        uint256 yield
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param _asset Address of the USDC token contract.
     */
    constructor(address _asset) {
        require(_asset != address(0), "Vault: zero asset address");
        asset = IERC20(_asset);
    }

    // -------------------------------------------------------------------------
    // External Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit USDC into the vault and receive proportional shares.
     * @dev    On the first deposit (totalShares == 0) shares are minted 1:1
     *         with USDC atoms.  Subsequent deposits mint shares proportionally
     *         to preserve each depositor's ownership fraction.
     *         Caller must approve this contract for at least `amount` USDC.
     * @param amount USDC amount to deposit (6 decimals, must be > 0).
     * @return sharesMinted Number of vault shares minted to msg.sender.
     */
    function deposit(uint256 amount)
        external
        nonReentrant
        returns (uint256 sharesMinted)
    {
        sharesMinted = _deposit(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Deposit USDC on behalf of a beneficiary.
     * @dev    Caller (e.g. PolkaFlowRouter) transfers USDC and shares are
     *         minted directly to `beneficiary`.  Caller must approve this
     *         contract for at least `amount` USDC before calling.
     *         This is the entry point used by the router's auto-vault flow:
     *         the router holds the settled USDC and deposits it directly for
     *         the merchant in a single atomic transaction.
     * @param beneficiary Wallet that will receive the minted shares.
     * @param amount      USDC amount to deposit (6 decimals, must be > 0).
     * @return sharesMinted Number of vault shares minted to `beneficiary`.
     */
    function depositFor(address beneficiary, uint256 amount)
        external
        nonReentrant
        returns (uint256 sharesMinted)
    {
        require(beneficiary != address(0), "Vault: zero beneficiary");
        sharesMinted = _deposit(msg.sender, beneficiary, amount);
    }

    /**
     * @notice Withdraw USDC by burning vault shares.
     * @dev    Returns principal proportional to shares burned, plus any
     *         simulated yield accrued since the last interaction.
     *         Partial withdrawals are supported.
     * @param shares Number of vault shares to burn (> 0 and ≤ balance).
     * @return usdcReturned Total USDC (principal + yield) sent to msg.sender.
     */
    function withdraw(uint256 shares)
        external
        nonReentrant
        returns (uint256 usdcReturned)
    {
        require(shares > 0, "Vault: zero shares");
        require(_shares[msg.sender] >= shares, "Vault: insufficient shares");

        // Fold pending yield into principal before calculating payout.
        _settleYield(msg.sender);

        uint256 pool   = _poolAssets();
        uint256 supply = totalShares;
        uint256 userTotalShares = _shares[msg.sender]; // after yield settle, before burn

        // USDC the burned shares represent in the current pool.
        usdcReturned = (shares * pool) / supply;

        // Compute yield component for the event (informational only).
        uint256 principalForShares = (_principalOf[msg.sender] * shares) / userTotalShares;
        uint256 yieldForShares = usdcReturned > principalForShares
            ? usdcReturned - principalForShares
            : 0;

        // Reduce principal and shares proportionally.
        _principalOf[msg.sender] =
            (_principalOf[msg.sender] * (userTotalShares - shares)) / userTotalShares;
        _shares[msg.sender] -= shares;
        totalShares         -= shares;
        _lastInteraction[msg.sender] = block.timestamp;

        asset.safeTransfer(msg.sender, usdcReturned);

        emit Withdrawn(msg.sender, shares, usdcReturned, yieldForShares);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the number of vault shares held by `user`.
     * @param user Wallet address to query.
     * @return Number of shares owned by `user`.
     */
    function balanceOf(address user) external view returns (uint256) {
        return _shares[user];
    }

    /**
     * @notice Total USDC held by the vault across all depositors.
     * @return Current USDC balance of this contract.
     */
    function totalAssets() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @notice Simulated yield accrued by `user` since their last interaction.
     * @dev    Formula: principal * 5% * (secondsElapsed / 365 days)
     *         This is a pure view — it does not modify state.
     * @param user Wallet address to query.
     * @return Yield in USDC atoms not yet settled into the user's principal.
     */
    function getYield(address user) external view returns (uint256) {
        return _pendingYield(user);
    }

    /**
     * @notice Preview how much USDC `user` would receive if they withdrew
     *         all their shares right now (principal + accrued yield).
     * @param user Wallet address to query.
     * @return Estimated USDC claimable by `user`.
     */
    function previewWithdrawAll(address user) external view returns (uint256) {
        uint256 userShares = _shares[user];
        if (userShares == 0) return 0;

        // Simulate yield being settled to get the adjusted pool size.
        uint256 pendingYield = _pendingYield(user);
        uint256 pool = asset.balanceOf(address(this)) + pendingYield;

        return (userShares * pool) / totalShares;
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Core deposit logic shared by `deposit` and `depositFor`.
     *      Pulls USDC from `payer`, mints shares to `beneficiary`.
     */
    function _deposit(
        address payer,
        address beneficiary,
        uint256 amount
    ) internal returns (uint256 sharesMinted) {
        require(amount > 0, "Vault: zero amount");

        // Settle any pending yield for the beneficiary before changing position.
        _settleYield(beneficiary);

        uint256 supply = totalShares;
        uint256 pool   = _poolAssets();

        if (supply == 0 || pool == 0) {
            // First deposit: 1 share per USDC atom to bootstrap share price.
            sharesMinted = amount;
        } else {
            // Proportional: sharesMinted = amount * totalShares / pool
            sharesMinted = (amount * supply) / pool;
        }

        require(sharesMinted > 0, "Vault: zero shares minted");

        asset.safeTransferFrom(payer, address(this), amount);

        _shares[beneficiary]          += sharesMinted;
        totalShares                   += sharesMinted;
        _principalOf[beneficiary]     += amount;
        _lastInteraction[beneficiary]  = block.timestamp;

        emit Deposited(beneficiary, amount, sharesMinted);
    }

    /**
     * @dev Returns the vault's current USDC balance (the live pool size).
     */
    function _poolAssets() internal view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @dev Calculates simulated yield for `user` accrued since last interaction.
     *      Formula: principal * 5% * (elapsed / 365 days)
     *             = principal * APY_NUM * elapsed / (APY_DEN * SECONDS_PER_YEAR)
     */
    function _pendingYield(address user) internal view returns (uint256) {
        uint256 last = _lastInteraction[user];
        if (last == 0) return 0;
        uint256 elapsed   = block.timestamp - last;
        uint256 principal = _principalOf[user];
        // principal * 5 * elapsed / (100 * 31_536_000)
        return (principal * APY_NUM * elapsed) / (APY_DEN * SECONDS_PER_YEAR);
    }

    /**
     * @dev Folds accrued yield into `user`'s recorded principal so that
     *      subsequent share-price calculations reflect the earned yield.
     *      NOTE: This is a book entry for demo purposes.  In production,
     *      real USDC would need to flow in from an external yield source.
     */
    function _settleYield(address user) internal {
        uint256 yield = _pendingYield(user);
        if (yield > 0) {
            _principalOf[user] += yield;
        }
        _lastInteraction[user] = block.timestamp;
    }
}
