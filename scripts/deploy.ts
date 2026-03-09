/**
 * deploy.ts — PolkaFlow full deployment script
 *
 * Deploys: MockUSDC → MockDOT → SimpleDEX → PolkaFlowRouter → PolkaFlowVault
 * Configures:
 *   router.setDexAdapter(simpleDex)
 *   router.setVault(vault)
 *   dex.addLiquidity(DOT, USDC, 1000 DOT, 5000 USDC)  ← real on-chain AMM pool
 * Outputs: frontend/src/deployments.json
 *
 * Run from repo root:
 *   npm run deploy:local
 *   npm run deploy:paseo
 */

import hre, { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─── helpers ────────────────────────────────────────────────────────────────

function pad(label: string, width = 18): string {
  return label.padEnd(width);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function top(width = 50): string { return `┌${"─".repeat(width + 2)}┐`; }
function divider(width = 50): string { return `├${"─".repeat(width + 2)}┤`; }
function bottom(width = 50): string { return `└${"─".repeat(width + 2)}┘`; }

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const signers     = await ethers.getSigners();
  const deployer    = signers[0];
  const customerAddr =
    process.env.CUSTOMER_ADDRESS || signers[1]?.address || deployer.address;
  const merchantAddr =
    process.env.MERCHANT_ADDRESS || signers[2]?.address || deployer.address;

  const W = 52;
  console.log("\n" + top(W));
  console.log(`│ ${"PolkaFlow — Deployment Script".padEnd(W)} │`);
  console.log(divider(W));
  console.log(`│  ${pad("Network", 14)}: ${network.name.padEnd(W - 16)} │`);
  console.log(`│  ${pad("Deployer", 14)}: ${deployer.address.padEnd(W - 16)} │`);
  console.log(bottom(W));
  console.log();

  // ── 1. MockUSDC ─────────────────────────────────────────────────────────
  process.stdout.write("  [1/5] Deploying MockUSDC       ");
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log(`✓  ${usdcAddr}`);

  // ── 2. MockDOT ──────────────────────────────────────────────────────────
  process.stdout.write("  [2/5] Deploying MockDOT        ");
  const dot = await (await ethers.getContractFactory("MockDOT")).deploy();
  await dot.waitForDeployment();
  const dotAddr = await dot.getAddress();
  console.log(`✓  ${dotAddr}`);

  // ── 3. SimpleDEX ────────────────────────────────────────────────────────
  process.stdout.write("  [3/5] Deploying SimpleDEX      ");
  const dex = await (await ethers.getContractFactory("SimpleDEX")).deploy();
  await dex.waitForDeployment();
  const dexAddr = await dex.getAddress();
  console.log(`✓  ${dexAddr}`);

  // ── 4. PolkaFlowRouter ──────────────────────────────────────────────────
  process.stdout.write("  [4/5] Deploying PolkaFlowRouter ");
  const router = await (await ethers.getContractFactory("PolkaFlowRouter"))
    .deploy(usdcAddr, 30, deployer.address);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`✓  ${routerAddr}`);

  // ── 5. PolkaFlowVault ───────────────────────────────────────────────────
  process.stdout.write("  [5/5] Deploying PolkaFlowVault  ");
  const vault = await (await ethers.getContractFactory("PolkaFlowVault"))
    .deploy(usdcAddr);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`✓  ${vaultAddr}`);

  // ── Configure ───────────────────────────────────────────────────────────
  console.log("\n  Configuring contracts...");
  await (await router.setDexAdapter(dexAddr)).wait();
  console.log("    router.setDexAdapter(simpleDex) ✓");
  await (await router.setVault(vaultAddr)).wait();
  console.log("    router.setVault(vault)          ✓");

  // ── Seed DOT/USDC liquidity pool ─────────────────────────────────────────
  console.log("\n  Seeding SimpleDEX liquidity pool (1000 DOT / 5000 USDC)...");

  const dotSeed  = ethers.parseEther("1000");         // 1,000 DOT  (18 dec)
  const usdcSeed = ethers.parseUnits("5000", 6);      // 5,000 USDC (6 dec)

  await (await usdc.mint(deployer.address, usdcSeed)).wait();
  await (await dot.mint(deployer.address, dotSeed)).wait();
  await (await usdc.approve(dexAddr, usdcSeed)).wait();
  await (await dot.approve(dexAddr, dotSeed)).wait();
  await (await dex.addLiquidity(usdcAddr, dotAddr, usdcSeed, dotSeed, 0n)).wait();

  console.log(`    DOT reserve  : 1,000 DOT  (implied price: 1 DOT = 5 USDC)`);
  console.log(`    USDC reserve : 5,000 USDC`);
  console.log(`    Fee          : 0.3% (x*y=k, Uniswap v2)`);

  // ── Mint demo tokens ────────────────────────────────────────────────────
  console.log("\n  Minting demo tokens...");

  // Customer gets DOT to pay with.
  await (await dot.mint(customerAddr, ethers.parseEther("1000"))).wait();
  console.log(`    1,000 DOT    →  customer  ${shortAddr(customerAddr)}`);

  // Merchant gets some USDC to start with.
  await (await usdc.mint(merchantAddr, ethers.parseUnits("1000", 6))).wait();
  console.log(`    1,000 USDC   →  merchant  ${shortAddr(merchantAddr)}`);

  // ── Write deployments.json ──────────────────────────────────────────────
  const { chainId } = await ethers.provider.getNetwork();

  const [usdcArt, dotArt, dexArt, routerArt, vaultArt] = await Promise.all([
    hre.artifacts.readArtifact("MockUSDC"),
    hre.artifacts.readArtifact("MockDOT"),
    hre.artifacts.readArtifact("SimpleDEX"),
    hre.artifacts.readArtifact("PolkaFlowRouter"),
    hre.artifacts.readArtifact("PolkaFlowVault"),
  ]);

  const deployments = {
    network:    network.name,
    chainId:    chainId.toString(),
    MockUSDC:         { address: usdcAddr,   abi: usdcArt.abi   },
    MockDOT:          { address: dotAddr,    abi: dotArt.abi    },
    SimpleDEX:        { address: dexAddr,    abi: dexArt.abi    },
    PolkaFlowRouter:  { address: routerAddr, abi: routerArt.abi },
    PolkaFlowVault:   { address: vaultAddr,  abi: vaultArt.abi  },
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.resolve(__dirname, "../frontend/src/deployments.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployments, null, 2));
  console.log(`\n  Deployments written → ${outPath}`);

  // ── Summary table ───────────────────────────────────────────────────────
  console.log("\n" + top(W));
  console.log(`│ ${"Deployment Summary".padEnd(W)} │`);
  console.log(divider(W));
  console.log(`│  ${pad("Network",  16)}: ${network.name.padEnd(W - 18)} │`);
  console.log(`│  ${pad("Chain ID", 16)}: ${chainId.toString().padEnd(W - 18)} │`);
  console.log(divider(W));
  console.log(`│  ${pad("MockUSDC",        16)}: ${usdcAddr.padEnd(W - 18)} │`);
  console.log(`│  ${pad("MockDOT",         16)}: ${dotAddr.padEnd(W - 18)} │`);
  console.log(`│  ${pad("SimpleDEX",       16)}: ${dexAddr.padEnd(W - 18)} │`);
  console.log(`│  ${pad("PolkaFlowRouter", 16)}: ${routerAddr.padEnd(W - 18)} │`);
  console.log(`│  ${pad("PolkaFlowVault",  16)}: ${vaultAddr.padEnd(W - 18)} │`);
  console.log(divider(W));
  console.log(`│  ${pad("DEX pool",  16)}: ${"1000 DOT / 5000 USDC (0.3% fee)".padEnd(W - 18)} │`);
  console.log(`│  ${pad("Fee",       16)}: ${"30 bps (0.30%)".padEnd(W - 18)} │`);
  console.log(`│  ${pad("Vault APY", 16)}: ${"5% (simulated)".padEnd(W - 18)} │`);
  console.log(bottom(W));
  console.log();
}

main().catch((err) => {
  console.error("\n  Deployment failed:", err.message ?? err);
  process.exit(1);
});
