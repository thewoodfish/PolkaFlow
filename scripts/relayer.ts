/**
 * relayer.ts — PolkaFlow automated settlement relayer
 *
 * Watches for PaymentInitiated events on PolkaFlowRouter and automatically
 * calls swapAndSettle() with 1% slippage protection.
 *
 * The call is permissionless — any account can trigger it.
 *
 * Run from repo root:
 *   npm run relayer          (localhost)
 *   npm run relayer:paseo    (Paseo testnet)
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ─── config ─────────────────────────────────────────────────────────────────

const NETWORK        = process.env.NETWORK ?? "localhost";
const RPC_URL        = NETWORK === "paseo"
  ? (process.env.POLKADOT_HUB_RPC_URL ?? "https://eth-rpc-testnet.polkadot.io/")
  : "http://127.0.0.1:8545";
const RELAYER_PK     = process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "";
const SLIPPAGE_BPS   = 100n;   // 1% slippage tolerance
const DEADLINE_SECS  = 300;    // 5 minutes from now

// ─── load deployments ────────────────────────────────────────────────────────

const deployments = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../frontend/src/deployments.json"), "utf8")
);

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!RELAYER_PK) {
    console.error("Error: RELAYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) not set in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(RELAYER_PK, provider);

  const router = new ethers.Contract(
    deployments.PolkaFlowRouter.address,
    deployments.PolkaFlowRouter.abi,
    wallet
  );

  // ── startup banner ──────────────────────────────────────────────────────
  const { chainId } = await provider.getNetwork();
  const balance     = await provider.getBalance(wallet.address);

  console.log("┌─────────────────────────────────────────┐");
  console.log("│ PolkaFlow Relayer                        │");
  console.log("├─────────────────────────────────────────┤");
  console.log(`│  Network : ${NETWORK.padEnd(29)} │`);
  console.log(`│  Chain   : ${chainId.toString().padEnd(29)} │`);
  console.log(`│  RPC     : ${RPC_URL.slice(0, 29).padEnd(29)} │`);
  console.log(`│  Relayer : ${wallet.address.slice(0, 29)} │`);
  console.log(`│  Balance : ${ethers.formatEther(balance).slice(0, 12).padEnd(29)} │`);
  console.log(`│  Router  : ${deployments.PolkaFlowRouter.address.slice(0, 29)} │`);
  console.log(`│  Slippage: ${"1%".padEnd(29)} │`);
  console.log("└─────────────────────────────────────────┘");
  console.log("\nListening for PaymentInitiated events...\n");

  // ── event listener ──────────────────────────────────────────────────────
  router.on(
    "PaymentInitiated",
    async (
      paymentId: string,
      payer: string,
      tokenIn: string,
      amountIn: bigint
    ) => {
      const ts = new Date().toISOString();
      console.log(`[${ts}] PaymentInitiated`);
      console.log(`  paymentId : ${paymentId}`);
      console.log(`  payer     : ${payer}`);
      console.log(`  tokenIn   : ${tokenIn}`);
      console.log(`  amountIn  : ${ethers.formatEther(amountIn)} tokens`);

      try {
        // Get USDC quote for the incoming token amount.
        const quoted: bigint = await router.getSwapQuote(tokenIn, amountIn);
        const minOut: bigint  = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        const deadline        = Math.floor(Date.now() / 1000) + DEADLINE_SECS;

        console.log(`  USDC quote: ${ethers.formatUnits(quoted, 6)} USDC`);
        console.log(`  minUsdcOut: ${ethers.formatUnits(minOut, 6)} USDC (1% slippage floor)`);
        console.log(`  Calling swapAndSettle...`);

        const tx      = await router.swapAndSettle(paymentId, minOut, deadline);
        const receipt = await tx.wait();

        console.log(`  ✓ Settled!  tx: ${receipt.hash}`);
      } catch (e) {
        const msg = (e as Error).message?.slice(0, 200) ?? String(e);
        console.error(`  ✗ Failed:  ${msg}`);
      }

      console.log();
    }
  );

  // ── graceful shutdown ────────────────────────────────────────────────────
  process.on("SIGINT", () => {
    console.log("\n[Relayer] SIGINT received — shutting down...");
    router.removeAllListeners();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Relayer startup failed:", err.message ?? err);
  process.exit(1);
});
