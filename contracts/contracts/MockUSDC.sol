// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @author PolkaFlow
 * @notice A mintable mock USD Coin for local and testnet development.
 *         Exposes an open mint function so demo scripts and tests can
 *         fund accounts without any access control overhead.
 * @dev    Uses 6 decimals to match the canonical USDC specification.
 *         NOT intended for production use.
 */
contract MockUSDC is ERC20 {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @notice Deploys the mock USDC token.
     *         No initial supply is minted — use `mint` to fund accounts.
     */
    constructor() ERC20("USD Coin", "USDC") {}

    // -------------------------------------------------------------------------
    // Overrides
    // -------------------------------------------------------------------------

    /**
     * @notice Returns 6, matching the real USDC decimals.
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // -------------------------------------------------------------------------
    // External Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Mint USDC to any address.
     * @dev    Open for demo / test use only — no access control.
     * @param to     Recipient address.
     * @param amount Amount to mint (in USDC atoms, i.e. 1 USDC = 1_000_000).
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
