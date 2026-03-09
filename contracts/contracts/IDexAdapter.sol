// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IDexAdapter
/// @notice Standard interface for on-chain DEX adapters plugged into PolkaFlowRouter.
///
///         Two implementations ship with PolkaFlow:
///         1. SimpleDEX           — Solidity constant-product AMM (works anywhere)
///         2. AssetConversionBridge — ink! contract that calls Polkadot's native
///            pallet-asset-conversion via cross-VM dispatch (Paseo Asset Hub only)
///
///         Swap the active adapter at any time with router.setDexAdapter(address).
interface IDexAdapter {
    /// @notice Execute a token swap, sending output to `recipient`.
    /// @dev    Caller must approve this contract for `amountIn` of `tokenIn` before calling.
    /// @param tokenIn       ERC20 token to sell.
    /// @param tokenOut      ERC20 token to buy.
    /// @param amountIn      Exact input amount.
    /// @param minAmountOut  Minimum acceptable output (slippage protection).
    /// @param recipient     Address that receives the output tokens.
    /// @return amountOut    Actual output amount sent to `recipient`.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);

    /// @notice Quote expected output for a given input — does NOT modify state.
    /// @param tokenIn   ERC20 token to sell.
    /// @param tokenOut  ERC20 token to buy.
    /// @param amountIn  Input amount to quote.
    /// @return amountOut Expected output (before any on-chain slippage).
    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 amountOut);
}
