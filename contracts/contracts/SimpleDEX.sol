// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IDexAdapter.sol";

/// @title SimpleDEX — Constant-product AMM
/// @author PolkaFlow
/// @notice A minimal Uniswap v2-style AMM deployed on Polkadot Asset Hub.
///         Supports any number of ERC20/ERC20 liquidity pools.
///         Implements IDexAdapter so PolkaFlowRouter can swap through it
///         without knowing any implementation details.
///
///         In production, this can be replaced by an ink! bridge contract
///         that calls pallet-asset-conversion (Polkadot's native on-chain AMM)
///         via Polkadot's cross-VM dispatch — without touching the Router at all.
///
/// @dev    Swap fee:   0.3%  (Uniswap v2 constant: 997/1000)
///         LP shares:  geometric mean on bootstrap, proportional on top-ups.
///         No minimum liquidity burn — simple version for demo purposes.
contract SimpleDEX is IDexAdapter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant FEE_NUMERATOR   = 997;   // after-fee multiplier
    uint256 public constant FEE_DENOMINATOR = 1000;  // 0.3% fee on input

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Pool {
        uint256 reserve0;   // reserve for the token with the lower address
        uint256 reserve1;   // reserve for the token with the higher address
        uint256 totalLP;
        bool    exists;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Pool data, keyed by sorted (token0, token1) pair.
    mapping(bytes32 => Pool) public pools;

    /// @notice LP share balances: poolId → user → shares.
    mapping(bytes32 => mapping(address => uint256)) public lpBalances;

    // ── Events ────────────────────────────────────────────────────────────────

    event LiquidityAdded(
        address indexed token0,
        address indexed token1,
        uint256 amount0,
        uint256 amount1,
        uint256 lpShares,
        address indexed provider
    );

    event LiquidityRemoved(
        address indexed token0,
        address indexed token1,
        uint256 amount0,
        uint256 amount1,
        uint256 lpShares,
        address indexed provider
    );

    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address indexed recipient
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── Liquidity management ──────────────────────────────────────────────────

    /// @notice Deposit tokens into a pool and receive LP shares.
    /// @dev    First deposit bootstraps the pool with geometric-mean LP shares.
    ///         Subsequent deposits are proportional to the smaller ratio.
    ///         Caller must approve this contract for both tokens first.
    /// @param tokenA   First token (order doesn't matter — internally sorted).
    /// @param tokenB   Second token.
    /// @param amountA  Amount of tokenA to deposit.
    /// @param amountB  Amount of tokenB to deposit.
    /// @param minLP    Minimum LP shares to accept (slippage guard).
    /// @return lpShares LP shares minted to caller.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 minLP
    ) external nonReentrant returns (uint256 lpShares) {
        require(tokenA != tokenB,           "DEX: identical tokens");
        require(amountA > 0 && amountB > 0, "DEX: zero amount");

        (address t0, address t1, uint256 a0, uint256 a1) =
            _sort(tokenA, tokenB, amountA, amountB);
        bytes32   id   = _poolId(t0, t1);
        Pool storage pool = pools[id];

        if (!pool.exists) {
            // Bootstrap — geometric mean of deposits.
            lpShares    = _sqrt(a0 * a1);
            pool.exists = true;
        } else {
            // Proportional — use the more conservative ratio.
            uint256 lp0 = (a0 * pool.totalLP) / pool.reserve0;
            uint256 lp1 = (a1 * pool.totalLP) / pool.reserve1;
            lpShares    = lp0 < lp1 ? lp0 : lp1;
        }

        require(lpShares > 0,      "DEX: zero LP minted");
        require(lpShares >= minLP, "DEX: insufficient LP");

        IERC20(t0).safeTransferFrom(msg.sender, address(this), a0);
        IERC20(t1).safeTransferFrom(msg.sender, address(this), a1);

        pool.reserve0 += a0;
        pool.reserve1 += a1;
        pool.totalLP  += lpShares;
        lpBalances[id][msg.sender] += lpShares;

        emit LiquidityAdded(t0, t1, a0, a1, lpShares, msg.sender);
    }

    /// @notice Burn LP shares and withdraw proportional tokens.
    /// @param tokenA   First token.
    /// @param tokenB   Second token.
    /// @param lpShares LP shares to burn.
    /// @return amountA tokenA received.
    /// @return amountB tokenB received.
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 lpShares
    ) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        require(lpShares > 0, "DEX: zero LP");

        (address t0, address t1,,) = _sort(tokenA, tokenB, 0, 0);
        bytes32   id   = _poolId(t0, t1);
        Pool storage pool = pools[id];

        require(pool.exists,                             "DEX: pool not found");
        require(lpBalances[id][msg.sender] >= lpShares,  "DEX: insufficient LP balance");
        require(pool.totalLP > 0,                        "DEX: empty pool");

        uint256 a0 = (lpShares * pool.reserve0) / pool.totalLP;
        uint256 a1 = (lpShares * pool.reserve1) / pool.totalLP;

        pool.reserve0 -= a0;
        pool.reserve1 -= a1;
        pool.totalLP  -= lpShares;
        lpBalances[id][msg.sender] -= lpShares;

        IERC20(t0).safeTransfer(msg.sender, a0);
        IERC20(t1).safeTransfer(msg.sender, a1);

        (amountA, amountB) = tokenA == t0 ? (a0, a1) : (a1, a0);
        emit LiquidityRemoved(t0, t1, a0, a1, lpShares, msg.sender);
    }

    // ── IDexAdapter ───────────────────────────────────────────────────────────

    /// @inheritdoc IDexAdapter
    /// @dev Uses the Uniswap v2 constant-product formula with 0.3% fee.
    ///      Caller must approve this contract for `amountIn` of `tokenIn`.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override nonReentrant returns (uint256 amountOut) {
        require(tokenIn != tokenOut,        "DEX: identical tokens");
        require(amountIn > 0,               "DEX: zero input");
        require(recipient != address(0),    "DEX: zero recipient");

        (address t0, address t1,,) = _sort(tokenIn, tokenOut, 0, 0);
        bytes32   id   = _poolId(t0, t1);
        Pool storage pool = pools[id];
        require(pool.exists, "DEX: pool not found");

        (uint256 reserveIn, uint256 reserveOut) = tokenIn == t0
            ? (pool.reserve0, pool.reserve1)
            : (pool.reserve1, pool.reserve0);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Uniswap v2: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        amountOut = (amountInWithFee * reserveOut) /
                    (reserveIn * FEE_DENOMINATOR + amountInWithFee);

        require(amountOut >= minAmountOut, "DEX: slippage exceeded");
        require(amountOut > 0,            "DEX: zero output");
        require(amountOut < reserveOut,   "DEX: insufficient liquidity");

        if (tokenIn == t0) {
            pool.reserve0 += amountIn;
            pool.reserve1 -= amountOut;
        } else {
            pool.reserve1 += amountIn;
            pool.reserve0 -= amountOut;
        }

        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    /// @inheritdoc IDexAdapter
    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        if (tokenIn == tokenOut || amountIn == 0) return 0;

        (address t0, address t1,,) = _sort(tokenIn, tokenOut, 0, 0);
        Pool storage pool = pools[_poolId(t0, t1)];
        if (!pool.exists) return 0;

        (uint256 reserveIn, uint256 reserveOut) = tokenIn == t0
            ? (pool.reserve0, pool.reserve1)
            : (pool.reserve1, pool.reserve0);

        if (reserveIn == 0 || reserveOut == 0) return 0;

        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        amountOut = (amountInWithFee * reserveOut) /
                    (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Current reserves for a token pair (in the caller's token order).
    function getReserves(address tokenA, address tokenB)
        external view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address t0, address t1,,) = _sort(tokenA, tokenB, 0, 0);
        Pool storage pool = pools[_poolId(t0, t1)];
        (reserveA, reserveB) = tokenA == t0
            ? (pool.reserve0, pool.reserve1)
            : (pool.reserve1, pool.reserve0);
    }

    /// @notice LP shares held by `user` for a given pool.
    function lpBalanceOf(address tokenA, address tokenB, address user)
        external view returns (uint256)
    {
        (address t0, address t1,,) = _sort(tokenA, tokenB, 0, 0);
        return lpBalances[_poolId(t0, t1)][user];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _poolId(address t0, address t1) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(t0, t1));
    }

    /// @dev Returns tokens and amounts sorted so t0 < t1 (canonical order).
    function _sort(address tA, address tB, uint256 aA, uint256 aB)
        internal pure
        returns (address t0, address t1, uint256 a0, uint256 a1)
    {
        if (tA < tB) { (t0, t1, a0, a1) = (tA, tB, aA, aB); }
        else         { (t0, t1, a0, a1) = (tB, tA, aB, aA); }
    }

    /// @dev Babylonian integer square root.
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }
}
