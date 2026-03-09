import { expect } from "chai";
import { ethers } from "hardhat";
import type { ContractTransactionReceipt } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  MockUSDC,
  MockDOT,
  SimpleDEX,
  PolkaFlowRouter,
  PolkaFlowVault,
} from "../contracts/typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEE_BPS        = 30n;                              // 0.3 %
const TWENTY_USDC    = 20_000_000n;                      // 20 USDC  (6 dec)
const THREE_DOT      = ethers.parseEther("3");
const FIVE_DOT       = ethers.parseEther("5");

// Pool bootstrap liquidity — 1 DOT ≈ 5 USDC implied price.
const DOT_RESERVE    = ethers.parseEther("1000");        // 1,000 DOT  (18 dec)
const USDC_RESERVE   = ethers.parseUnits("5000", 6);     // 5,000 USDC (6 dec)

function fee(gross: bigint): bigint { return (gross * FEE_BPS) / 10_000n; }
function net(gross: bigint): bigint { return gross - fee(gross); }

// Mirrors the Uniswap v2 formula in SimpleDEX (used for expected-value assertions).
function quote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amtFee = amountIn * 997n;
  return (amtFee * reserveOut) / (reserveIn * 1000n + amtFee);
}

// ---------------------------------------------------------------------------
// Helper — parse paymentId from a PaymentCreated event in a tx receipt.
//
//  NOTE: createPaymentRequest derives the ID from block.prevrandao which
//  changes every block, so staticCall and the real tx return different IDs.
//  We always read the ID from the emitted event instead.
// ---------------------------------------------------------------------------

async function getPaymentId(
  router: PolkaFlowRouter,
  receipt: ContractTransactionReceipt | null
): Promise<string> {
  if (!receipt) throw new Error("no receipt");
  for (const log of receipt.logs) {
    try {
      const parsed = router.interface.parseLog(log);
      if (parsed && parsed.name === "PaymentCreated") {
        return parsed.args.paymentId as string;
      }
    } catch {}
  }
  throw new Error("PaymentCreated event not found in receipt");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("PolkaFlowRouter", function () {
  let usdc:         MockUSDC;
  let dot:          MockDOT;
  let dex:          SimpleDEX;
  let router:       PolkaFlowRouter;
  let owner:        HardhatEthersSigner;
  let merchant:     HardhatEthersSigner;
  let customer:     HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let relayer:      HardhatEthersSigner;

  beforeEach(async function () {
    [owner, merchant, customer, feeRecipient, relayer] = await ethers.getSigners();

    usdc = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as unknown as MockUSDC;
    dot  = (await (await ethers.getContractFactory("MockDOT" )).deploy()) as unknown as MockDOT;

    dex  = (await (await ethers.getContractFactory("SimpleDEX")).deploy()) as unknown as SimpleDEX;

    router = (await (
      await ethers.getContractFactory("PolkaFlowRouter")
    ).deploy(
      await usdc.getAddress(),
      FEE_BPS,
      feeRecipient.address
    )) as unknown as PolkaFlowRouter;

    // Seed DOT/USDC pool (owner is LP).
    await usdc.mint(owner.address, USDC_RESERVE);
    await dot.mint(owner.address, DOT_RESERVE);
    await usdc.connect(owner).approve(await dex.getAddress(), USDC_RESERVE);
    await dot.connect(owner).approve(await dex.getAddress(), DOT_RESERVE);
    await dex.connect(owner).addLiquidity(
      await usdc.getAddress(), await dot.getAddress(),
      USDC_RESERVE, DOT_RESERVE, 0n
    );

    // Wire router → SimpleDEX.
    await router.connect(owner).setDexAdapter(await dex.getAddress());
  });

  // =========================================================================
  // 1. Deployment
  // =========================================================================

  describe("Deployment", function () {
    it("sets the correct owner, feesBps, usdcToken, feeRecipient, and dexAdapter", async function () {
      expect(await router.owner()).to.equal(owner.address);
      expect(await router.feesBps()).to.equal(FEE_BPS);
      expect(await router.usdcToken()).to.equal(await usdc.getAddress());
      expect(await router.feeRecipient()).to.equal(feeRecipient.address);
      expect(await router.dexAdapter()).to.equal(await dex.getAddress());
      expect(await router.vault()).to.equal(ethers.ZeroAddress);

      console.log(
        `\n  Router   : ${await router.getAddress()}`,
        `\n  USDC     : ${await usdc.getAddress()}`,
        `\n  DOT      : ${await dot.getAddress()}`,
        `\n  SimpleDEX: ${await dex.getAddress()}`,
        `\n  Fee      : ${FEE_BPS} bps (${Number(FEE_BPS) / 100}%)`
      );
    });
  });

  // =========================================================================
  // 2. createPaymentRequest
  // =========================================================================

  describe("createPaymentRequest", function () {
    it("returns a non-zero paymentId and emits PaymentCreated", async function () {
      const tx = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const paymentId = await getPaymentId(router, receipt);

      expect(paymentId).to.not.equal(ethers.ZeroHash);

      const req = await router.getPaymentRequest(paymentId);
      expect(req.merchant).to.equal(merchant.address);
      expect(req.amountUSDC).to.equal(TWENTY_USDC);

      console.log(`\n  paymentId : ${paymentId}`);
    });

    it("stores the correct PaymentRequest struct", async function () {
      const tx = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const paymentId = await getPaymentId(router, receipt);

      const req = await router.getPaymentRequest(paymentId);
      expect(req.merchant).to.equal(merchant.address);
      expect(req.amountUSDC).to.equal(TWENTY_USDC);
      expect(req.stablecoin).to.equal(await usdc.getAddress());
      expect(req.settled).to.be.false;
      expect(req.autoVault).to.be.false;
      expect(req.createdAt).to.be.gt(0n);
      // Path B fields default to zero before payWithToken.
      expect(req.tokenIn).to.equal(ethers.ZeroAddress);
      expect(req.amountIn).to.equal(0n);
    });
  });

  // =========================================================================
  // 3. payWithStablecoin — PATH A (direct USDC payment)
  // =========================================================================

  describe("payWithStablecoin — PATH A", function () {
    let paymentId: string;

    beforeEach(async function () {
      const tx = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      const receipt = await tx.wait();
      paymentId = await getPaymentId(router, receipt);
    });

    it("pays merchant net amount, accumulates fee, marks settled, emits PaymentSettled", async function () {
      await usdc.mint(customer.address, TWENTY_USDC);
      await usdc.connect(customer).approve(await router.getAddress(), TWENTY_USDC);

      const expectedFee = fee(TWENTY_USDC);
      const expectedNet = net(TWENTY_USDC);
      const merchantBefore = await usdc.balanceOf(merchant.address);

      await expect(
        router
          .connect(customer)
          .payWithStablecoin(paymentId, await usdc.getAddress(), TWENTY_USDC)
      )
        .to.emit(router, "PaymentSettled")
        .withArgs(paymentId, merchant.address, expectedNet, expectedFee, 0n);

      expect(await usdc.balanceOf(merchant.address)).to.equal(merchantBefore + expectedNet);
      expect(await router.accumulatedFees(await usdc.getAddress())).to.equal(expectedFee);
      expect((await router.getPaymentRequest(paymentId)).settled).to.be.true;

      console.log(
        `\n  Gross payment  : ${ethers.formatUnits(TWENTY_USDC, 6)} USDC`,
        `\n  Fee (0.3%)     : ${ethers.formatUnits(expectedFee, 6)} USDC`,
        `\n  Net to merchant: ${ethers.formatUnits(expectedNet, 6)} USDC`
      );
    });

    it("allows owner to withdraw accumulated fees to feeRecipient", async function () {
      await usdc.mint(customer.address, TWENTY_USDC);
      await usdc.connect(customer).approve(await router.getAddress(), TWENTY_USDC);
      await router.connect(customer).payWithStablecoin(paymentId, await usdc.getAddress(), TWENTY_USDC);

      const expectedFee    = fee(TWENTY_USDC);
      const recipientBefore = await usdc.balanceOf(feeRecipient.address);

      await router.connect(owner).withdrawFees(await usdc.getAddress());

      expect(await usdc.balanceOf(feeRecipient.address)).to.equal(recipientBefore + expectedFee);
      expect(await router.accumulatedFees(await usdc.getAddress())).to.equal(0n);
    });

    it("reverts on a second payment attempt (already settled)", async function () {
      await usdc.mint(customer.address, TWENTY_USDC * 2n);
      await usdc.connect(customer).approve(await router.getAddress(), TWENTY_USDC * 2n);
      await router.connect(customer).payWithStablecoin(paymentId, await usdc.getAddress(), TWENTY_USDC);

      await expect(
        router.connect(customer).payWithStablecoin(paymentId, await usdc.getAddress(), TWENTY_USDC)
      ).to.be.revertedWith("Router: already settled");
    });
  });

  // =========================================================================
  // 4. payWithToken — PATH B step 1
  // =========================================================================

  describe("payWithToken — PATH B step 1", function () {
    let paymentId: string;

    beforeEach(async function () {
      const tx = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      const receipt = await tx.wait();
      paymentId = await getPaymentId(router, receipt);
    });

    it("transfers DOT to router and emits PaymentInitiated", async function () {
      await dot.mint(customer.address, FIVE_DOT);
      await dot.connect(customer).approve(await router.getAddress(), FIVE_DOT);

      await expect(
        router.connect(customer).payWithToken(paymentId, await dot.getAddress(), FIVE_DOT)
      )
        .to.emit(router, "PaymentInitiated")
        .withArgs(paymentId, customer.address, await dot.getAddress(), FIVE_DOT);

      expect(await dot.balanceOf(await router.getAddress())).to.equal(FIVE_DOT);
      expect((await router.getPaymentRequest(paymentId)).settled).to.be.false;

      // tokenIn / amountIn stored for swapAndSettle.
      const req = await router.getPaymentRequest(paymentId);
      expect(req.tokenIn).to.equal(await dot.getAddress());
      expect(req.amountIn).to.equal(FIVE_DOT);

      console.log(`\n  Router holds: ${ethers.formatEther(FIVE_DOT)} DOT (pending swap)`);
    });

    it("reverts if payWithToken is called twice on the same request", async function () {
      await dot.mint(customer.address, FIVE_DOT * 2n);
      await dot.connect(customer).approve(await router.getAddress(), FIVE_DOT * 2n);
      await router.connect(customer).payWithToken(paymentId, await dot.getAddress(), FIVE_DOT);

      await expect(
        router.connect(customer).payWithToken(paymentId, await dot.getAddress(), FIVE_DOT)
      ).to.be.revertedWith("Router: already initiated");
    });
  });

  // =========================================================================
  // 5. swapAndSettle — PATH B step 2 (real on-chain DEX swap)
  // =========================================================================

  describe("swapAndSettle — PATH B step 2", function () {
    let paymentId: string;
    let deadline:  number;

    beforeEach(async function () {
      // Merchant creates request.
      const createTx = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      paymentId = await getPaymentId(router, await createTx.wait());

      // Customer locks 5 DOT (≈ 24.8 USDC at current pool price, enough to cover 20 USDC request).
      await dot.mint(customer.address, FIVE_DOT);
      await dot.connect(customer).approve(await router.getAddress(), FIVE_DOT);
      await router.connect(customer).payWithToken(paymentId, await dot.getAddress(), FIVE_DOT);

      // Deadline 10 min from now.
      deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    });

    it("swaps DOT→USDC and settles merchant at the correct constant-product price", async function () {
      // Expected USDC out = quote(5 DOT, DOT_RESERVE, USDC_RESERVE)
      const expectedUsdcOut = quote(FIVE_DOT, DOT_RESERVE, USDC_RESERVE);
      const expectedFee     = fee(expectedUsdcOut);
      const expectedNet     = net(expectedUsdcOut);

      const merchantBefore = await usdc.balanceOf(merchant.address);

      await expect(
        router.connect(relayer).swapAndSettle(paymentId, 0n, deadline)
      )
        .to.emit(router, "PaymentSettled")
        .withArgs(paymentId, merchant.address, expectedNet, expectedFee, 0n);

      expect(await usdc.balanceOf(merchant.address)).to.equal(merchantBefore + expectedNet);
      expect((await router.getPaymentRequest(paymentId)).settled).to.be.true;

      console.log(
        `\n  Swap: 5 DOT → ${ethers.formatUnits(expectedUsdcOut, 6)} USDC`,
        `\n  Protocol fee (0.3%): ${ethers.formatUnits(expectedFee, 6)} USDC`,
        `\n  Net to merchant    : ${ethers.formatUnits(expectedNet, 6)} USDC`
      );
    });

    it("is permissionless — any account (customer, relayer, stranger) can call it", async function () {
      // Customer calls swapAndSettle (not owner, not relayer).
      await expect(
        router.connect(customer).swapAndSettle(paymentId, 0n, deadline)
      ).to.emit(router, "PaymentSettled");

      expect((await router.getPaymentRequest(paymentId)).settled).to.be.true;
    });

    it("reverts when the deadline has passed", async function () {
      const pastDeadline = (await ethers.provider.getBlock("latest"))!.timestamp - 1;

      await expect(
        router.connect(relayer).swapAndSettle(paymentId, 0n, pastDeadline)
      ).to.be.revertedWith("Router: deadline expired");
    });

    it("reverts when minUsdcOut exceeds swap output (slippage protection)", async function () {
      await expect(
        router.connect(relayer).swapAndSettle(paymentId, ethers.MaxUint256, deadline)
      ).to.be.revertedWith("DEX: slippage exceeded");
    });

    it("reverts on an already-settled payment", async function () {
      await router.connect(relayer).swapAndSettle(paymentId, 0n, deadline);

      await expect(
        router.connect(relayer).swapAndSettle(paymentId, 0n, deadline)
      ).to.be.revertedWith("Router: already settled");
    });

    it("reverts when payWithToken was never called (tokenIn == address(0))", async function () {
      // Create a fresh request that has NOT been initiated via payWithToken.
      const tx2 = await router
        .connect(merchant)
        .createPaymentRequest(TWENTY_USDC, ethers.ZeroAddress);
      const paymentId2 = await getPaymentId(router, await tx2.wait());

      await expect(
        router.connect(relayer).swapAndSettle(paymentId2, 0n, deadline)
      ).to.be.revertedWith("Router: not initiated");
    });

    it("getSwapQuote returns the same value as the actual swap output", async function () {
      const quoted = await router.getSwapQuote(await dot.getAddress(), FIVE_DOT);
      await router.connect(relayer).swapAndSettle(paymentId, 0n, deadline);

      const req = await router.getPaymentRequest(paymentId);
      // net + fee = quoted  ↔  netAmt = quoted - fee(quoted)
      const expectedNet = net(quoted);
      expect(await usdc.balanceOf(merchant.address)).to.equal(expectedNet);
    });

    it("updates DEX reserves correctly after swap+settle", async function () {
      const [dotResBefore, usdcResBefore] = await dex.getReserves(
        await dot.getAddress(), await usdc.getAddress()
      );
      const expectedUsdcOut = quote(FIVE_DOT, dotResBefore, usdcResBefore);

      await router.connect(relayer).swapAndSettle(paymentId, 0n, deadline);

      const [dotResAfter, usdcResAfter] = await dex.getReserves(
        await dot.getAddress(), await usdc.getAddress()
      );
      expect(dotResAfter).to.equal(dotResBefore + FIVE_DOT);
      expect(usdcResAfter).to.equal(usdcResBefore - expectedUsdcOut);
    });
  });

  // =========================================================================
  // 6. autoVault flow
  // =========================================================================

  describe("autoVault flow", function () {
    let vault: PolkaFlowVault;

    beforeEach(async function () {
      vault = (await (
        await ethers.getContractFactory("PolkaFlowVault")
      ).deploy(await usdc.getAddress())) as unknown as PolkaFlowVault;

      await router.connect(owner).setVault(await vault.getAddress());
    });

    it("deposits net USDC into vault for merchant after stablecoin payment (PATH A)", async function () {
      const createTx = await router
        .connect(merchant)
        .createPaymentRequestWithVault(TWENTY_USDC, ethers.ZeroAddress, true);
      const paymentId = await getPaymentId(router, await createTx.wait());

      await usdc.mint(customer.address, TWENTY_USDC);
      await usdc.connect(customer).approve(await router.getAddress(), TWENTY_USDC);

      const expectedFee = fee(TWENTY_USDC);
      const expectedNet = net(TWENTY_USDC);

      await expect(
        router.connect(customer).payWithStablecoin(paymentId, await usdc.getAddress(), TWENTY_USDC)
      )
        .to.emit(router, "PaymentSettled")
        .withArgs(paymentId, merchant.address, expectedNet, expectedFee, expectedNet);

      // Merchant holds vault shares, NOT raw USDC.
      expect(await vault.balanceOf(merchant.address)).to.be.gt(0n);
      expect(await usdc.balanceOf(merchant.address)).to.equal(0n);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(expectedNet);

      console.log(
        `\n  Auto-Vault (PATH A):`,
        `\n    USDC vaulted : ${ethers.formatUnits(expectedNet, 6)} USDC`,
        `\n    Vault shares : ${await vault.balanceOf(merchant.address)}`
      );
    });

    it("deposits net USDC into vault after swapAndSettle (PATH B)", async function () {
      const createTx = await router
        .connect(merchant)
        .createPaymentRequestWithVault(TWENTY_USDC, ethers.ZeroAddress, true);
      const paymentId = await getPaymentId(router, await createTx.wait());

      // Customer locks 5 DOT.
      await dot.mint(customer.address, FIVE_DOT);
      await dot.connect(customer).approve(await router.getAddress(), FIVE_DOT);
      await router.connect(customer).payWithToken(paymentId, await dot.getAddress(), FIVE_DOT);

      const expectedUsdcOut = quote(FIVE_DOT, DOT_RESERVE, USDC_RESERVE);
      const expectedFee     = fee(expectedUsdcOut);
      const expectedNet     = net(expectedUsdcOut);
      const deadline        = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

      await expect(
        router.connect(relayer).swapAndSettle(paymentId, 0n, deadline)
      )
        .to.emit(router, "PaymentSettled")
        .withArgs(paymentId, merchant.address, expectedNet, expectedFee, expectedNet);

      // Merchant gets vault shares, not raw USDC.
      expect(await vault.balanceOf(merchant.address)).to.be.gt(0n);
      expect(await usdc.balanceOf(merchant.address)).to.equal(0n);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(expectedNet);

      console.log(
        `\n  Auto-Vault (PATH B — 5 DOT → USDC → vault):`,
        `\n    USDC from swap   : ${ethers.formatUnits(expectedUsdcOut, 6)} USDC`,
        `\n    Protocol fee     : ${ethers.formatUnits(expectedFee, 6)} USDC`,
        `\n    USDC vaulted     : ${ethers.formatUnits(expectedNet, 6)} USDC`,
        `\n    Vault total      : ${ethers.formatUnits(await vault.totalAssets(), 6)} USDC`
      );
    });

    it("reverts createPaymentRequestWithVault(autoVault=true) when vault is not set", async function () {
      const freshRouter = (await (
        await ethers.getContractFactory("PolkaFlowRouter")
      ).deploy(
        await usdc.getAddress(),
        FEE_BPS,
        feeRecipient.address
      )) as unknown as PolkaFlowRouter;

      await expect(
        freshRouter.connect(merchant).createPaymentRequestWithVault(TWENTY_USDC, ethers.ZeroAddress, true)
      ).to.be.revertedWith("Router: vault not set");
    });
  });
});
