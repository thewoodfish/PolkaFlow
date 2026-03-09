/**
 * demo-flow.ts — PolkaFlow end-to-end hackathon demo
 *
 * Simulates the full payment loop on a local or live network:
 *   Merchant request → Customer pays DOT → Swap → Settle USDC →
 *   Auto-vault deposit → Yield accrual
 *
 * Run:
 *   npm run demo                  (localhost)
 *   npm run demo:hub              (Westend Asset Hub testnet)
 */

import { ethers, network } from "hardhat";

// ─── formatting helpers ──────────────────────────────────────────────────────

const LINE_W = 47; // inner width of summary box

function box(lines: string[]): void {
  const w = LINE_W;
  console.log(`  ┌${"─".repeat(w + 2)}┐`);
  for (const l of lines) {
    const content = l.padEnd(w);
    console.log(`  │ ${content} │`);
  }
  console.log(`  └${"─".repeat(w + 2)}┘`);
}

function sep(): void {
  console.log(`  ${"─".repeat(LINE_W + 4)}`);
}

function step(n: number, label: string): void {
  console.log(`\n  ╔══ Step ${n}: ${label}`);
}

function indent(msg: string): void {
  console.log(`  ║   ${msg}`);
}

function done(msg: string): void {
  console.log(`  ╚→  ${msg}`);
}

// ─── event helper ────────────────────────────────────────────────────────────

async function getPaymentId(
  router: any,
  receipt: any
): Promise<string> {
  for (const log of receipt.logs) {
    try {
      const parsed = router.interface.parseLog(log);
      if (parsed?.name === "PaymentCreated") return parsed.args.paymentId;
    } catch {}
  }
  throw new Error("PaymentCreated event not found");
}

// ─── time helper (localhost only) ────────────────────────────────────────────

async function increaseTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

const IS_LOCAL =
  network.name === "localhost" ||
  network.name === "hardhat";

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n");
  box([
    "  PolkaFlow Demo — Polkadot Hub EVM",
    `  Network: ${network.name}`,
    "  Full payment loop: DOT → USDC → Vault → Yield",
  ]);

  const signers = await ethers.getSigners();
  const owner    = signers[0];
  const merchant = signers[1] ?? signers[0];
  const customer = signers[2] ?? signers[0];

  console.log(`\n  Owner    : ${owner.address}`);
  console.log(`  Merchant : ${merchant.address}`);
  console.log(`  Customer : ${customer.address}`);

  // ── Deploy fresh contracts ─────────────────────────────────────────────
  console.log("\n  Deploying contracts...");

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  const dot = await (await ethers.getContractFactory("MockDOT")).deploy();
  await dot.waitForDeployment();

  const router = await (
    await ethers.getContractFactory("PolkaFlowRouter")
  ).deploy(await usdc.getAddress(), 30, owner.address);
  await router.waitForDeployment();

  const vault = await (
    await ethers.getContractFactory("PolkaFlowVault")
  ).deploy(await usdc.getAddress());
  await vault.waitForDeployment();

  // Register vault and seed demo balances.
  await (await (router as any).setVault(await vault.getAddress())).wait();

  // Fund router as simulated DEX reserve.
  await (
    await (usdc as any).mint(
      await router.getAddress(),
      ethers.parseUnits("10000", 6)
    )
  ).wait();

  // Give customer 10 DOT.
  await (
    await (dot as any).mint(customer.address, ethers.parseEther("10"))
  ).wait();

  console.log("  MockUSDC        :", await usdc.getAddress());
  console.log("  MockDOT         :", await dot.getAddress());
  console.log("  PolkaFlowRouter :", await router.getAddress());
  console.log("  PolkaFlowVault  :", await vault.getAddress());
  sep();

  // ────────────────────────────────────────────────────────────────────────
  // Step 1 — Merchant creates a $20 USDC payment request
  // ────────────────────────────────────────────────────────────────────────
  step(1, "Merchant creates $20 USDC payment request");

  const TWENTY_USDC = ethers.parseUnits("20", 6); // 20_000_000

  // Use createPaymentRequestWithVault so settlement auto-deposits to vault.
  const createTx = await (router as any)
    .connect(merchant)
    .createPaymentRequestWithVault(TWENTY_USDC, ethers.ZeroAddress, true);
  const createReceipt = await createTx.wait();
  const paymentId = await getPaymentId(router, createReceipt);

  indent(`Amount    : 20 USDC`);
  indent(`Auto-vault: enabled (yield on settlement)`);
  done(`Payment ID: ${paymentId}`);

  // ────────────────────────────────────────────────────────────────────────
  // Step 2 — Customer pays with 3 DOT
  // ────────────────────────────────────────────────────────────────────────
  step(2, "Customer pays with 3 DOT");

  const THREE_DOT = ethers.parseEther("3");

  await (dot as any)
    .connect(customer)
    .approve(await router.getAddress(), THREE_DOT);

  const payTx = await (router as any)
    .connect(customer)
    .payWithToken(paymentId, await dot.getAddress(), THREE_DOT);
  await payTx.wait();

  const routerDotBalance = await (dot as any).balanceOf(
    await router.getAddress()
  );

  indent(`DOT approved  : 3 DOT`);
  indent(`Router DOT bal: ${ethers.formatEther(routerDotBalance)} DOT`);
  done(`💸 Customer paid 3 DOT — settlement pending`);

  // ────────────────────────────────────────────────────────────────────────
  // Step 3 — Simulate XCM swap: 3 DOT → 20 USDC
  // ────────────────────────────────────────────────────────────────────────
  step(3, "Simulate XCM + DEX swap: 3 DOT → 20 USDC");

  // Mint the swap output directly to the router (simulates bridged USDC).
  await (
    await (usdc as any).mint(await router.getAddress(), TWENTY_USDC)
  ).wait();

  indent(`XCM message   : relayed (simulated)`);
  indent(`DEX swap      : 3 DOT → 20 USDC`);
  done(`🔄 20 USDC credited to router`);

  // ────────────────────────────────────────────────────────────────────────
  // Step 4 — simulateSwapAndSettle → vault auto-deposit
  // ────────────────────────────────────────────────────────────────────────
  step(4, "Settle payment — auto-vault enabled");

  const FEE_BPS = 30n;
  const feeAmt = (TWENTY_USDC * FEE_BPS) / 10_000n; // 60_000 = 0.06 USDC
  const netAmt = TWENTY_USDC - feeAmt;               // 19_940_000 = 19.94 USDC

  const settleTx = await (router as any)
    .connect(owner)
    .simulateSwapAndSettle(
      paymentId,
      TWENTY_USDC,
      await usdc.getAddress()
    );
  await settleTx.wait();

  const merchantShares = await (vault as any).balanceOf(merchant.address);
  const vaultAssets    = await (vault as any).totalAssets();

  indent(
    `Protocol fee  : ${ethers.formatUnits(feeAmt, 6)} USDC (${Number(FEE_BPS) / 100}%)`
  );
  indent(
    `Net settled   : ${ethers.formatUnits(netAmt, 6)} USDC`
  );
  indent(
    `Vault assets  : ${ethers.formatUnits(vaultAssets, 6)} USDC`
  );
  indent(`Merchant shares: ${merchantShares}`);
  done(`✅ ${ethers.formatUnits(netAmt, 6)} USDC settled → vaulted for merchant`);

  // ────────────────────────────────────────────────────────────────────────
  // Step 5 — Confirm vault deposit
  // ────────────────────────────────────────────────────────────────────────
  step(5, "Vault deposit confirmed");

  indent(`Vault address  : ${await vault.getAddress()}`);
  indent(`Merchant shares: ${merchantShares}`);
  indent(`USDC in vault  : ${ethers.formatUnits(vaultAssets, 6)}`);
  done(`🏦 Deposited into PolkaFlowVault — earning 5% APY`);

  // ────────────────────────────────────────────────────────────────────────
  // Step 6 — Fast-forward time, check accrued yield
  // ────────────────────────────────────────────────────────────────────────
  step(6, "Yield accrual over time");

  const THIRTY_DAYS = 30 * 24 * 60 * 60; // seconds

  let yieldAmt: bigint;
  let yieldLabel: string;

  if (IS_LOCAL) {
    await increaseTime(THIRTY_DAYS);
    yieldAmt = await (vault as any).getYield(merchant.address);
    yieldLabel = `${ethers.formatUnits(yieldAmt, 6)} USDC (30 days actual)`;
    indent(`Time advanced  : 30 days (evm_increaseTime)`);
  } else {
    // On live networks we can't manipulate time; show the projection.
    // 5% APY on netAmt for 30 days = netAmt * 5 * 30 / (100 * 365)
    yieldAmt = (netAmt * 5n * 30n) / (100n * 365n);
    yieldLabel = `${ethers.formatUnits(yieldAmt, 6)} USDC (30 days projected)`;
    indent(`Time            : live network — projected yield shown`);
  }

  // 1-year projection
  const annualYield = (netAmt * 5n) / 100n;

  indent(`Yield (30d)    : ${ethers.formatUnits(yieldAmt, 6)} USDC`);
  indent(`Yield (1 year) : ${ethers.formatUnits(annualYield, 6)} USDC`);
  done(`📈 Vault yield accrued: ${yieldLabel}`);

  // ────────────────────────────────────────────────────────────────────────
  // Final summary
  // ────────────────────────────────────────────────────────────────────────
  const shortId = `${paymentId.slice(0, 12)}…${paymentId.slice(-6)}`;

  console.log();
  box([
    " PolkaFlow Demo Complete ✅",
    "─".repeat(LINE_W - 1),
    ` Payment ID    : ${shortId}`,
    ` Network       : ${network.name}`,
    "─".repeat(LINE_W - 1),
    ` DOT paid      : 3 DOT`,
    ` USDC settled  : ${ethers.formatUnits(netAmt, 6)} USDC`,
    ` Protocol fee  : ${ethers.formatUnits(feeAmt, 6)} USDC`,
    "─".repeat(LINE_W - 1),
    ` Vault APY     : 5% (simulated)`,
    ` Yield (30d)   : ${ethers.formatUnits(yieldAmt, 6)} USDC`,
    ` Yield (1 yr)  : ${ethers.formatUnits(annualYield, 6)} USDC`,
    "─".repeat(LINE_W - 1),
    ` DeFi loop     : DOT → USDC → Vault → Yield`,
  ]);
  console.log();
}

main().catch((err) => {
  console.error("\n  Demo failed:", err.message ?? err);
  process.exit(1);
});
