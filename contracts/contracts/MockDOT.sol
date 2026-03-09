// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockDOT
 * @author PolkaFlow
 * @notice A mintable mock of Polkadot's native DOT token represented as an
 *         ERC20 on Polkadot Asset Hub EVM.  Used in demo flows where a
 *         customer pays with DOT and the router swaps it to USDC.
 * @dev    Uses 18 decimals to match the wrapped-DOT convention on Hub EVM.
 *         NOT intended for production use.
 */
contract MockDOT is ERC20 {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @notice Deploys the mock DOT token.
     *         No initial supply is minted — use `mint` to fund accounts.
     */
    constructor() ERC20("Polkadot", "DOT") {}

    // -------------------------------------------------------------------------
    // External Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Mint DOT to any address.
     * @dev    Open for demo / test use only — no access control.
     * @param to     Recipient address.
     * @param amount Amount to mint (in DOT atoms, i.e. 1 DOT = 1e18).
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
