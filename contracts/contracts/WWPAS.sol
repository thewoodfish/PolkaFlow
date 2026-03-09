// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WWPAS — Wrapped PAS
/// @notice ERC20 wrapper for the native PAS token on Polkadot Asset Hub (Paseo testnet).
///         Follows the same WETH deposit/withdraw pattern so customers can pay
///         PolkaFlowRouter with native PAS through the standard ERC20 approval flow.
///
///         Mainnet equivalent would be WDOT on Polkadot Asset Hub.
///
/// @dev    No mint function — supply is backed 1:1 by native PAS held in this contract.
contract WWPAS is ERC20 {
    // ── Events ────────────────────────────────────────────────────────────────
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor() ERC20("Wrapped PAS", "WPAS") {}

    // ── External ──────────────────────────────────────────────────────────────

    /// @notice Accept native PAS and mint WPAS 1:1 to the sender.
    receive() external payable {
        deposit();
    }

    /// @notice Wrap `msg.value` PAS → WPAS minted to `msg.sender`.
    function deposit() public payable {
        require(msg.value > 0, "WWPAS: zero value");
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Burn `wad` WPAS and withdraw the equivalent native PAS to caller.
    /// @param wad Amount of WPAS to burn (must be ≤ caller's WPAS balance).
    function withdraw(uint256 wad) external {
        require(balanceOf(msg.sender) >= wad, "WWPAS: insufficient balance");
        _burn(msg.sender, wad);
        (bool ok, ) = payable(msg.sender).call{ value: wad }("");
        require(ok, "WWPAS: PAS transfer failed");
        emit Withdrawal(msg.sender, wad);
    }
}
