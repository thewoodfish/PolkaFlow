import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { MockUSDC, MockDOT, SimpleDEX } from "../contracts/typechain-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 1 DOT = 5 USDC implied price from 1000 DOT / 5000 USDC bootstrap liquidity.
const DOT_RESERVE  = ethers.parseEther("1000");         // 1,000 DOT  (18 dec)
const USDC_RESERVE = ethers.parseUnits("5000", 6);      // 5,000 USDC (6 dec)
const THREE_DOT    = ethers.parseEther("3");
const ONE_DOT      = ethers.parseEther("1");

// Uniswap v2 formula (mirrors SimpleDEX contract).
function quote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amtFee = amountIn * 997n;
  return (amtFee * reserveOut) / (reserveIn * 1000n + amtFee);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("SimpleDEX", function () {
  let dex:  SimpleDEX;
  let usdc: MockUSDC;
  let dot:  MockDOT;
  let owner:    HardhatEthersSigner;
  let lp:       HardhatEthersSigner;
  let trader:   HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  // Addresses in sorted order (needed for canonical pool direction checks).
  let t0Addr: string; // lower address
  let t1Addr: string;

  beforeEach(async function () {
    [owner, lp, trader, recipient] = await ethers.getSigners();

    usdc = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as unknown as MockUSDC;
    dot  = (await (await ethers.getContractFactory("MockDOT" )).deploy()) as unknown as MockDOT;
    dex  = (await (await ethers.getContractFactory("SimpleDEX")).deploy()) as unknown as SimpleDEX;

    // Sort token addresses for consistent pool-direction tests.
    const uAddr = await usdc.getAddress();
    const dAddr = await dot.getAddress();
    [t0Addr, t1Addr] = uAddr < dAddr ? [uAddr, dAddr] : [dAddr, uAddr];
  });

  // ==========================================================================
  // 1. addLiquidity
  // ==========================================================================

  describe("addLiquidity", function () {
    it("bootstraps a new pool and mints sqrt(a0*a1) LP shares", async function () {
      await usdc.mint(lp.address, USDC_RESERVE);
      await dot.mint(lp.address, DOT_RESERVE);
      await usdc.connect(lp).approve(await dex.getAddress(), USDC_RESERVE);
      await dot.connect(lp).approve(await dex.getAddress(), DOT_RESERVE);

      const tx = await dex.connect(lp).addLiquidity(
        await usdc.getAddress(), await dot.getAddress(),
        USDC_RESERVE, DOT_RESERVE, 0n
      );
      const receipt = await tx.wait();

      // LP shares = sqrt(USDC_RESERVE * DOT_RESERVE)
      const expectedLP = BigInt(Math.floor(
        Math.sqrt(Number(USDC_RESERVE) * Number(DOT_RESERVE))
      ));

      const lpBal = await dex.lpBalanceOf(
        await usdc.getAddress(), await dot.getAddress(), lp.address
      );
      // Allow 1 wei tolerance from integer sqrt.
      expect(lpBal).to.be.gte(expectedLP - 1n);
      expect(lpBal).to.be.lte(expectedLP + 1n);

      const [rA, rB] = await dex.getReserves(await usdc.getAddress(), await dot.getAddress());
      expect(rA).to.equal(USDC_RESERVE);
      expect(rB).to.equal(DOT_RESERVE);

      console.log(
        `\n  Bootstrap liquidity:`,
        `\n    USDC reserve : ${ethers.formatUnits(USDC_RESERVE, 6)}`,
        `\n    DOT  reserve : ${ethers.formatEther(DOT_RESERVE)}`,
        `\n    LP shares    : ${lpBal}`
      );
    });

    it("mints proportional shares on a second deposit", async function () {
      // First LP.
      await usdc.mint(lp.address, USDC_RESERVE * 2n);
      await dot.mint(lp.address, DOT_RESERVE * 2n);
      await usdc.connect(lp).approve(await dex.getAddress(), USDC_RESERVE * 2n);
      await dot.connect(lp).approve(await dex.getAddress(), DOT_RESERVE * 2n);

      await dex.connect(lp).addLiquidity(
        await usdc.getAddress(), await dot.getAddress(),
        USDC_RESERVE, DOT_RESERVE, 0n
      );
      const lp1 = await dex.lpBalanceOf(await usdc.getAddress(), await dot.getAddress(), lp.address);

      // Second equal-size deposit → should get same number of LP shares.
      await dex.connect(lp).addLiquidity(
        await usdc.getAddress(), await dot.getAddress(),
        USDC_RESERVE, DOT_RESERVE, 0n
      );
      const lp2 = await dex.lpBalanceOf(await usdc.getAddress(), await dot.getAddress(), lp.address);

      // After second deposit, total LP ≈ 2× first batch.
      expect(lp2).to.be.approximately(lp1 * 2n, lp1 / 100n); // within 1%
    });

    it("reverts on minLP not met", async function () {
      await usdc.mint(lp.address, USDC_RESERVE);
      await dot.mint(lp.address, DOT_RESERVE);
      await usdc.connect(lp).approve(await dex.getAddress(), USDC_RESERVE);
      await dot.connect(lp).approve(await dex.getAddress(), DOT_RESERVE);

      await expect(
        dex.connect(lp).addLiquidity(
          await usdc.getAddress(), await dot.getAddress(),
          USDC_RESERVE, DOT_RESERVE,
          ethers.MaxUint256 // impossible minLP
        )
      ).to.be.revertedWith("DEX: insufficient LP");
    });
  });

  // ==========================================================================
  // 2. swap
  // ==========================================================================

  describe("swap", function () {
    beforeEach(async function () {
      // Seed the pool.
      await usdc.mint(lp.address, USDC_RESERVE);
      await dot.mint(lp.address, DOT_RESERVE);
      await usdc.connect(lp).approve(await dex.getAddress(), USDC_RESERVE);
      await dot.connect(lp).approve(await dex.getAddress(), DOT_RESERVE);
      await dex.connect(lp).addLiquidity(
        await usdc.getAddress(), await dot.getAddress(),
        USDC_RESERVE, DOT_RESERVE, 0n
      );

      // Mint DOT to trader.
      await dot.mint(trader.address, THREE_DOT);
      await dot.connect(trader).approve(await dex.getAddress(), THREE_DOT);
    });

    it("swaps DOT for USDC at the correct constant-product price", async function () {
      const expectedOut = quote(THREE_DOT, DOT_RESERVE, USDC_RESERVE);

      await expect(
        dex.connect(trader).swap(
          await dot.getAddress(), await usdc.getAddress(),
          THREE_DOT, 0n, recipient.address
        )
      )
        .to.emit(dex, "Swapped")
        .withArgs(
          await dot.getAddress(), await usdc.getAddress(),
          THREE_DOT, expectedOut, recipient.address
        );

      expect(await usdc.balanceOf(recipient.address)).to.equal(expectedOut);

      console.log(
        `\n  Swap: 3 DOT → ${ethers.formatUnits(expectedOut, 6)} USDC`,
        `\n  Implied price: ${Number(ethers.formatUnits(expectedOut, 6)) / 3} USDC/DOT`
      );
    });

    it("getQuote matches actual swap output", async function () {
      const quoted = await dex.getQuote(
        await dot.getAddress(), await usdc.getAddress(), THREE_DOT
      );
      await dex.connect(trader).swap(
        await dot.getAddress(), await usdc.getAddress(),
        THREE_DOT, 0n, recipient.address
      );
      expect(await usdc.balanceOf(recipient.address)).to.equal(quoted);
    });

    it("reverts when slippage protection triggers", async function () {
      await expect(
        dex.connect(trader).swap(
          await dot.getAddress(), await usdc.getAddress(),
          THREE_DOT,
          ethers.MaxUint256, // impossible minAmountOut
          recipient.address
        )
      ).to.be.revertedWith("DEX: slippage exceeded");
    });

    it("updates reserves correctly after a swap", async function () {
      await dex.connect(trader).swap(
        await dot.getAddress(), await usdc.getAddress(),
        THREE_DOT, 0n, recipient.address
      );
      const [rUsdc, rDot] = await dex.getReserves(
        await usdc.getAddress(), await dot.getAddress()
      );
      // DOT reserve increases, USDC reserve decreases.
      expect(rDot).to.equal(DOT_RESERVE + THREE_DOT);
      const expectedOut = quote(THREE_DOT, DOT_RESERVE, USDC_RESERVE);
      expect(rUsdc).to.equal(USDC_RESERVE - expectedOut);
    });
  });

  // ==========================================================================
  // 3. removeLiquidity
  // ==========================================================================

  describe("removeLiquidity", function () {
    it("returns proportional tokens and burns LP shares", async function () {
      await usdc.mint(lp.address, USDC_RESERVE);
      await dot.mint(lp.address, DOT_RESERVE);
      await usdc.connect(lp).approve(await dex.getAddress(), USDC_RESERVE);
      await dot.connect(lp).approve(await dex.getAddress(), DOT_RESERVE);
      await dex.connect(lp).addLiquidity(
        await usdc.getAddress(), await dot.getAddress(),
        USDC_RESERVE, DOT_RESERVE, 0n
      );

      const lpShares = await dex.lpBalanceOf(
        await usdc.getAddress(), await dot.getAddress(), lp.address
      );

      await dex.connect(lp).removeLiquidity(
        await usdc.getAddress(), await dot.getAddress(), lpShares
      );

      // LP burned to zero.
      expect(
        await dex.lpBalanceOf(await usdc.getAddress(), await dot.getAddress(), lp.address)
      ).to.equal(0n);

      // LP gets back all tokens (full pool was withdrawn).
      expect(await usdc.balanceOf(lp.address)).to.equal(USDC_RESERVE);
      expect(await dot.balanceOf(lp.address)).to.equal(DOT_RESERVE);
    });
  });
});
