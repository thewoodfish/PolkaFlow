import { useState } from "react";
import { usePolkaFlow } from "./hooks/usePolkaFlow";
import { ConnectWallet } from "./components/ConnectWallet";
import { StatsBar } from "./components/StatsBar";
import { FlowDiagram } from "./components/FlowDiagram";
import { MerchantPanel } from "./components/MerchantPanel";
import { CustomerPanel } from "./components/CustomerPanel";
import { ContractsModal } from "./components/ContractsModal";

type Tab = "merchant" | "customer";

function trunc(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

export default function App() {
  const { account, chainId, contracts, connect, connecting, error, deployments } = usePolkaFlow();
  const [tab,           setTab]           = useState<Tab>("merchant");
  const [flowStep,      setFlowStep]      = useState(0);
  const [showContracts, setShowContracts] = useState(false);

  const isLocalhost = String(deployments.chainId) === "31337";

  return (
    <div className="min-h-screen bg-pk-dark text-white flex flex-col">

      {/* ── Demo mode banner ──────────────────────────────────────────────── */}
      <div className="bg-yellow-900/40 border-b border-yellow-700/40 px-4 py-2">
        <p className="max-w-6xl mx-auto text-[11px] text-yellow-300 flex items-center gap-2 flex-wrap">
          <span>⚠️</span>
          <span className="font-semibold">Demo Mode</span>
          <span className="text-yellow-500">·</span>
          <span className="text-yellow-400">
            {isLocalhost
              ? "Running on local Hardhat node — relayer settles DOT payments automatically via SimpleDEX"
              : "Running on Polkadot Asset Hub Paseo — relayer settles DOT payments automatically via SimpleDEX"}
          </span>
          <button
            onClick={() => setShowContracts(true)}
            className="ml-auto flex-shrink-0 text-yellow-400 hover:text-yellow-200 underline underline-offset-2 transition-colors"
          >
            View contracts ↗
          </button>
        </p>
      </div>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="bg-pk-card/90 border-b border-pk-purple/25 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-pk-pink flex items-center justify-center shadow-lg shadow-pk-pink/30">
              <span className="text-base">⚡</span>
            </div>
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">
                Polka<span className="text-pk-pink">Flow</span>
              </h1>
              <p className="text-[10px] text-gray-500 leading-none mt-0.5 hidden sm:block">
                Cross-Chain Payments · Polkadot Hub EVM
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowContracts(true)}
              className="hidden sm:flex items-center gap-1.5 text-xs border border-pk-purple/35 rounded-xl px-3 py-1.5 text-gray-400 hover:text-pk-pink hover:border-pk-pink/40 transition-colors"
            >
              <span>📄</span> Contracts
            </button>
            <ConnectWallet
              account={account}
              chainId={chainId}
              connecting={connecting}
              onConnect={connect}
            />
          </div>
        </div>

        {error && (
          <div className="max-w-6xl mx-auto px-6 pb-3">
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl px-3.5 py-2">
              {error}
            </p>
          </div>
        )}
      </header>

      {/* ── Stats bar ────────────────────────────────────────────────────── */}
      <StatsBar contracts={contracts} />

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">

          {/* Left column */}
          <div className="min-w-0">
            {/* Flow diagram */}
            <FlowDiagram activeStep={flowStep} />

            {/* Tab bar */}
            <div className="flex gap-1 mb-5 bg-pk-card rounded-2xl p-1 border border-pk-purple/20">
              {(["merchant", "customer"] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    "flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all",
                    tab === t
                      ? "bg-pk-pink text-white shadow-lg shadow-pk-pink/20"
                      : "text-gray-400 hover:text-white",
                  ].join(" ")}
                >
                  {t === "merchant" ? "💼 Merchant" : "👤 Customer"}
                </button>
              ))}
            </div>

            {/* Panel */}
            {tab === "merchant" ? (
              <MerchantPanel
                contracts={contracts}
                account={account}
                onStepChange={setFlowStep}
              />
            ) : (
              <CustomerPanel
                contracts={contracts}
                account={account}
                onStepChange={setFlowStep}
              />
            )}
          </div>

          {/* Right sidebar */}
          <div className="space-y-4">

            {/* How it works */}
            <div className="card">
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-pk-pink">⚙</span> How It Works
              </h3>
              <ol className="space-y-3.5">
                {[
                  { n: "1", icon: "🧾", title: "Create Invoice", desc: "Merchant creates a payment request with optional auto-vault." },
                  { n: "2", icon: "💳", title: "Customer Pays", desc: "Pay with USDC directly or DOT via XCM swap." },
                  { n: "3", icon: "⚡", title: "XCM + DEX", desc: "DOT crosses chains, gets swapped for USDC on-chain." },
                  { n: "4", icon: "✅", title: "Settled", desc: "Merchant receives USDC (minus 0.3% protocol fee)." },
                  { n: "5", icon: "📈", title: "Yield", desc: "Auto-vault deposits earn 5% APY via PolkaFlowVault." },
                ].map(step => (
                  <li key={step.n} className="flex gap-3">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-pk-pink/15 border border-pk-pink/30 text-pk-pink text-[10px] font-bold flex items-center justify-center mt-0.5">
                      {step.n}
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-white">
                        {step.icon} {step.title}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Contract addresses */}
            <div className="card">
              <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                <span className="text-pk-purple">📄</span> Contracts
                <span className="ml-auto text-[10px] font-normal text-gray-600 capitalize">
                  {deployments.network}
                </span>
              </h3>
              <div className="space-y-2">
                {[
                  { label: "Router",    addr: deployments.PolkaFlowRouter.address },
                  { label: "Vault",     addr: deployments.PolkaFlowVault.address  },
                  { label: "Mock USDC", addr: deployments.MockUSDC.address         },
                  { label: "Mock DOT",  addr: deployments.MockDOT.address          },
                ].map(({ label, addr }) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-gray-500 flex-shrink-0">{label}</span>
                    <code className="font-mono text-[10px] text-pk-pink truncate">{trunc(addr)}</code>
                  </div>
                ))}
              </div>
            </div>

            {/* Demo tip */}
            <div className="card border-pk-purple/40 bg-pk-purple/5">
              <h3 className="text-xs font-bold text-pk-purple mb-2">🧪 Demo Tips</h3>
              <ul className="space-y-1.5 text-[11px] text-gray-400 leading-relaxed">
                <li>• Use two MetaMask accounts: one as Merchant, one as Customer.</li>
                <li>• Contracts pre-seeded with mock USDC &amp; DOT tokens.</li>
                <li>• Start the relayer (<code className="text-pk-pink">npm run relayer</code>) — it settles DOT payments automatically.</li>
                <li>• DOT path: pay → relayer swaps via SimpleDEX → merchant receives USDC.</li>
                <li>• Chain ID <span className="font-mono text-gray-300">{deployments.chainId}</span></li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-pk-purple/15 bg-pk-card/40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs text-gray-600">
            Built on <span className="text-pk-pink font-semibold">Polkadot Hub</span> · EVM Smart Contract Track
          </p>
          <div className="flex items-center gap-4 text-[11px] text-gray-700">
            <span>PolkaFlow v1.0</span>
            <span>·</span>
            <span>Solidity ^0.8.20</span>
            <span>·</span>
            <button
              onClick={() => setShowContracts(true)}
              className="hover:text-pk-pink transition-colors"
            >
              Contracts ↗
            </button>
          </div>
        </div>
      </footer>

      {/* ── Contracts modal ───────────────────────────────────────────────── */}
      {showContracts && (
        <ContractsModal
          deployments={deployments}
          onClose={() => setShowContracts(false)}
        />
      )}
    </div>
  );
}
