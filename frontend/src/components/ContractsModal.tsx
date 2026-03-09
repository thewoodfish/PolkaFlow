import { useEffect } from "react";
import type { Deployments } from "../hooks/usePolkaFlow";

interface Props {
  deployments: Deployments;
  onClose: () => void;
}

const BLOCKSCOUT  = "https://blockscout-testnet.polkadot.io/address";
const LOCALHOST_ID = "31337";

function explorerUrl(address: string, chainId: string): string | null {
  if (chainId === LOCALHOST_ID) return null;
  return `${BLOCKSCOUT}/${address}`;
}

function CopyButton({ text }: { text: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(text);
  };
  return (
    <button
      onClick={copy}
      title="Copy address"
      className="text-gray-500 hover:text-pk-pink transition-colors px-1 text-xs"
    >
      ⧉
    </button>
  );
}

const CONTRACTS = [
  { key: "PolkaFlowRouter" as const, label: "PolkaFlowRouter", icon: "🔀", desc: "Core payment router & permissionless settlement" },
  { key: "SimpleDEX"       as const, label: "SimpleDEX",       icon: "⚡", desc: "Constant-product AMM (x*y=k) — 0.3% swap fee" },
  { key: "PolkaFlowVault"  as const, label: "PolkaFlowVault",  icon: "🏦", desc: "ERC4626-lite merchant yield vault (5% APY)" },
  { key: "MockUSDC"        as const, label: "MockUSDC",        icon: "💵", desc: "Test stablecoin — 6 decimals, open mint" },
  { key: "MockDOT"         as const, label: "MockDOT",         icon: "🔴", desc: "Wrapped DOT test token — 18 decimals" },
] as const;

export function ContractsModal({ deployments, onClose }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isLive = deployments.chainId !== LOCALHOST_ID;
  const networkLabel = isLive ? "Polkadot Asset Hub Paseo" : "Localhost (Dev)";

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div className="w-full max-w-lg bg-pk-card border border-pk-purple/30 rounded-2xl shadow-2xl shadow-black/60 animate-slide-up">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-pk-purple/20">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>📄</span> Deployed Contracts
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Network: <span className={`font-semibold ${isLive ? "text-pk-pink" : "text-yellow-400"}`}>{networkLabel}</span>
              <span className="ml-2 font-mono text-gray-600">chainId {deployments.chainId}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-lg leading-none px-1"
          >
            ✕
          </button>
        </div>

        {/* Contract rows */}
        <div className="px-6 py-4 space-y-3">
          {CONTRACTS.map(({ key, label, icon, desc }) => {
            const address = deployments[key].address;
            const url     = explorerUrl(address, deployments.chainId);

            return (
              <div key={key} className="rounded-xl bg-pk-deep border border-pk-purple/20 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white">
                      {icon} {label}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5">{desc}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-pk-purple hover:text-pk-pink transition-colors border border-pk-purple/30 hover:border-pk-pink/40 rounded-lg px-2 py-0.5"
                      >
                        Blockscout ↗
                      </a>
                    ) : (
                      <span className="text-[10px] text-gray-700 border border-pk-purple/15 rounded-lg px-2 py-0.5">
                        local
                      </span>
                    )}
                    <CopyButton text={address} />
                  </div>
                </div>
                <code className="mt-2 block font-mono text-[10px] text-pk-pink break-all leading-relaxed">
                  {address}
                </code>
              </div>
            );
          })}
        </div>

        {/* Footer note */}
        <div className="px-6 pb-5">
          {isLive ? (
            <p className="text-[11px] text-gray-600 text-center">
              View full transaction history on{" "}
              <a
                href="https://blockscout-testnet.polkadot.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-pk-purple hover:text-pk-pink transition-colors"
              >
                blockscout-testnet.polkadot.io ↗
              </a>
            </p>
          ) : (
            <p className="text-[11px] text-yellow-600 text-center">
              Running against local Hardhat node — deploy to Paseo for live explorer links.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
