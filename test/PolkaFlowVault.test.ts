import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  MockUSDC,
  PolkaFlowVault,
} from "../contracts/typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n; // 31_536_000

// 100 USDC — generous enough to make fee arithmetic readable.
const DEPOSIT = 100_000_000n; // 100 USDC (6 decimals)

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("PolkaFlowVault", function () {
  let usdc: MockUSDC;
  let vault: PolkaFlowVault;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user, user2] = await ethers.getSigners();

    usdc = (await (
      await ethers.getContractFactory("MockUSDC")
    ).deploy()) as unknown as MockUSDC;

    vault = (await (
      await ethers.getContractFactory("PolkaFlowVault")
    ).deploy(
      await usdc.getAddress()
    )) as unknown as PolkaFlowVault;
  });

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Mint USDC to `signer`, approve vault, and deposit. */
  async function depositAs(
    signer: HardhatEthersSigner,
    amount: bigint
  ): Promise<void> {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await vault.getAddress(), amount);
    await vault.connect(signer).deposit(amount);
  }

  // =========================================================================
  // 1. deposit mints shares
  // =========================================================================

  describe("deposit mints shares", function () {
    it("mints shares 1:1 on the first deposit and emits Deposited", async function () {
      await usdc.mint(user.address, DEPOSIT);
      await usdc.connect(user).approve(await vault.getAddress(), DEPOSIT);

      await expect(vault.connect(user).deposit(DEPOSIT))
        .to.emit(vault, "Deposited")
        // First deposit: 1 share per USDC atom (1:1 bootstrap).
        .withArgs(user.address, DEPOSIT, DEPOSIT);

      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT);
      expect(await vault.totalAssets()).to.equal(DEPOSIT);
      expect(await vault.totalShares()).to.equal(DEPOSIT);

      console.log(
        `\n  Deposited         : ${ethers.formatUnits(DEPOSIT, 6)} USDC`,
        `\n  Shares minted     : ${DEPOSIT}`,
        `\n  Total vault assets: ${ethers.formatUnits(await vault.totalAssets(), 6)} USDC`
      );
    });

    it("mints proportional shares on a second deposit", async function () {
      // First depositor.
      await depositAs(user, DEPOSIT);

      // Second depositor deposits half as much.
      const secondDeposit = DEPOSIT / 2n;
      await usdc.mint(user2.address, secondDeposit);
      await usdc
        .connect(user2)
        .approve(await vault.getAddress(), secondDeposit);
      await vault.connect(user2).deposit(secondDeposit);

      // With an identical pool price the second depositor gets half the shares.
      const user1Shares = await vault.balanceOf(user.address);
      const user2Shares = await vault.balanceOf(user2.address);

      // user2 should own 1/3 of the pool (50 / 150).
      // user2_shares / total_shares ≈ 1/3.
      const total = user1Shares + user2Shares;
      // Allow 1-atom rounding tolerance.
      expect(user2Shares * 3n).to.be.closeTo(total, 3n);
    });

    it("reverts on zero deposit", async function () {
      await expect(
        vault.connect(user).deposit(0n)
      ).to.be.revertedWith("Vault: zero amount");
    });
  });

  // =========================================================================
  // 2. withdraw returns principal
  // =========================================================================

  describe("withdraw returns principal", function () {
    it("returns exact principal when withdrawn in the same block", async function () {
      await depositAs(user, DEPOSIT);

      const shares = await vault.balanceOf(user.address);
      const usdcBefore = await usdc.balanceOf(user.address);

      await expect(vault.connect(user).withdraw(shares))
        .to.emit(vault, "Withdrawn")
        // (user, shares, amount, yield) — yield = 0 for same-block withdrawal.
        .withArgs(user.address, shares, DEPOSIT, 0n);

      expect(await usdc.balanceOf(user.address)).to.equal(
        usdcBefore + DEPOSIT
      );
      expect(await vault.balanceOf(user.address)).to.equal(0n);
      expect(await vault.totalShares()).to.equal(0n);
      expect(await vault.totalAssets()).to.equal(0n);

      console.log(
        `\n  Deposited  : ${ethers.formatUnits(DEPOSIT, 6)} USDC`,
        `\n  Withdrawn  : ${ethers.formatUnits(DEPOSIT, 6)} USDC`,
        `\n  Yield      : 0.000000 USDC (immediate withdrawal)`
      );
    });

    it("supports partial withdrawals", async function () {
      await depositAs(user, DEPOSIT);

      const totalShares = await vault.balanceOf(user.address);
      const halfShares = totalShares / 2n;

      await vault.connect(user).withdraw(halfShares);

      // Should have got back half the USDC.
      expect(await usdc.balanceOf(user.address)).to.equal(DEPOSIT / 2n);
      // Should still hold half the shares.
      expect(await vault.balanceOf(user.address)).to.equal(
        totalShares - halfShares
      );
    });

    it("reverts when withdrawing more shares than owned", async function () {
      await depositAs(user, DEPOSIT);
      const shares = await vault.balanceOf(user.address);

      await expect(
        vault.connect(user).withdraw(shares + 1n)
      ).to.be.revertedWith("Vault: insufficient shares");
    });

    it("reverts on zero shares", async function () {
      await expect(
        vault.connect(user).withdraw(0n)
      ).to.be.revertedWith("Vault: zero shares");
    });
  });

  // =========================================================================
  // 3. yield accrues over time
  // =========================================================================

  describe("yield accrues over time", function () {
    it("shows higher previewWithdrawAll after 1 year (5% APY)", async function () {
      await depositAs(user, DEPOSIT);

      // Advance the chain by exactly 1 year.
      await time.increase(Number(SECONDS_PER_YEAR));

      const preview = await vault.previewWithdrawAll(user.address);
      // 5% APY on 100 USDC = 5 USDC yield → expect at least 105 USDC.
      const expectedMinimum = DEPOSIT + (DEPOSIT * 5n) / 100n;
      expect(preview).to.be.gte(expectedMinimum);

      console.log(
        `\n  After 1 year:`,
        `\n    Deposited       : ${ethers.formatUnits(DEPOSIT, 6)} USDC`,
        `\n    Preview withdraw: ${ethers.formatUnits(preview, 6)} USDC`,
        `\n    Simulated yield : ${ethers.formatUnits(preview - DEPOSIT, 6)} USDC`
      );
    });

    it("can actually withdraw principal + yield when vault is funded", async function () {
      await depositAs(user, DEPOSIT);

      await time.increase(Number(SECONDS_PER_YEAR));

      // Preview how much the user would receive.
      const preview = await vault.previewWithdrawAll(user.address);
      const expectedYield = preview - DEPOSIT;

      // Simulate an external yield source funding the vault.
      await usdc.mint(await vault.getAddress(), expectedYield + 1n);

      const shares = await vault.balanceOf(user.address);
      await vault.connect(user).withdraw(shares);

      // User should receive at least the deposited principal.
      const received = await usdc.balanceOf(user.address);
      expect(received).to.be.gte(DEPOSIT);

      console.log(
        `\n  Funded vault withdrawal:`,
        `\n    Received : ${ethers.formatUnits(received, 6)} USDC`,
        `\n    Gain     : ${ethers.formatUnits(received - DEPOSIT, 6)} USDC`
      );
    });

    it("getYield grows monotonically over multiple time periods", async function () {
      await depositAs(user, DEPOSIT);

      await time.increase(Number(SECONDS_PER_YEAR) / 4); // 3 months
      const yield3m = await vault.getYield(user.address);

      await time.increase(Number(SECONDS_PER_YEAR) / 4); // 6 months total
      const yield6m = await vault.getYield(user.address);

      await time.increase(Number(SECONDS_PER_YEAR) / 2); // 12 months total
      const yield12m = await vault.getYield(user.address);

      expect(yield3m).to.be.gt(0n);
      expect(yield6m).to.be.gt(yield3m);
      expect(yield12m).to.be.gt(yield6m);

      console.log(
        `\n  Yield at  3 months: ${ethers.formatUnits(yield3m, 6)} USDC`,
        `\n  Yield at  6 months: ${ethers.formatUnits(yield6m, 6)} USDC`,
        `\n  Yield at 12 months: ${ethers.formatUnits(yield12m, 6)} USDC`
      );
    });
  });

  // =========================================================================
  // 4. getYield returns correct amount after 1 year
  // =========================================================================

  describe("getYield returns correct amount after 1 year", function () {
    it("returns exactly 5% of principal after 365 days", async function () {
      await depositAs(user, DEPOSIT);

      // time.increase mines a block at exactly currentTimestamp + SECONDS_PER_YEAR
      // so elapsed = SECONDS_PER_YEAR and the calculation is deterministic.
      await time.increase(Number(SECONDS_PER_YEAR));

      const yieldAmount = await vault.getYield(user.address);
      // yield = principal * 5 * elapsed / (100 * SECONDS_PER_YEAR)
      //       = 100_000_000 * 5 / 100 = 5_000_000 (5.000000 USDC)
      const expectedYield = (DEPOSIT * 5n) / 100n; // 5_000_000

      // Allow ±1000 atoms (0.001 USDC) tolerance for any block-timing edge cases.
      expect(yieldAmount).to.be.gte(expectedYield);
      expect(yieldAmount).to.be.lte(expectedYield + 1_000n);

      // Also verify previewWithdrawAll matches principal + yield.
      const preview = await vault.previewWithdrawAll(user.address);
      expect(preview).to.be.gte(DEPOSIT + expectedYield);

      console.log(
        `\n  Principal            : ${ethers.formatUnits(DEPOSIT, 6)} USDC`,
        `\n  Expected yield (5%)  : ${ethers.formatUnits(expectedYield, 6)} USDC`,
        `\n  Actual yield         : ${ethers.formatUnits(yieldAmount, 6)} USDC`,
        `\n  Preview total        : ${ethers.formatUnits(preview, 6)} USDC`
      );
    });

    it("returns 0 yield before any deposit", async function () {
      expect(await vault.getYield(user.address)).to.equal(0n);
    });

    it("returns ~1.25% yield after 3 months (quarter of 5% APY)", async function () {
      await depositAs(user, DEPOSIT);

      await time.increase(Number(SECONDS_PER_YEAR) / 4);

      const yieldAmount = await vault.getYield(user.address);
      // 3 months ≈ 1.25% of 100 USDC = 1.25 USDC = 1_250_000 atoms.
      const expectedQuarterYield = (DEPOSIT * 5n) / 400n; // 1_250_000

      expect(yieldAmount).to.be.gte(expectedQuarterYield);
      expect(yieldAmount).to.be.lte(expectedQuarterYield + 1_000n);

      console.log(
        `\n  After 3 months:`,
        `\n    Expected yield (1.25%): ${ethers.formatUnits(expectedQuarterYield, 6)} USDC`,
        `\n    Actual yield          : ${ethers.formatUnits(yieldAmount, 6)} USDC`
      );
    });
  });
});
