import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../hooks/usePolkaFlow";

interface Props {
  contracts: Contracts | null;
}

interface Stats {
  volume:      string;
  fees:        string;
  vaultAssets: string;
  settlements: number;
}

const EMPTY: Stats = { volume: "—", fees: "—", vaultAssets: "—", settlements: 0 };

export function StatsBar({ contracts }: Props) {
  const [stats, setStats] = useState<Stats>(EMPTY);

  useEffect(() => {
    if (!contracts) return;

    async function load() {
      try {
        const [assets, events] = await Promise.all([
          contracts!.vault.totalAssets(),
          contracts!.router.queryFilter(
            contracts!.router.filters["PaymentSettled"](),
            -2000,
          ),
        ]);

        let volume = 0n, fees = 0n;
        for (const evt of events) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = (evt as any).args;
          volume += BigInt(a.usdcAmount ?? a[2] ?? 0n);
          fees   += BigInt(a.fee       ?? a[3] ?? 0n);
        }

        setStats({
          volume:      ethers.formatUnits(volume, 6),
          fees:        ethers.formatUnits(fees,   6),
          vaultAssets: ethers.formatUnits(assets, 6),
          settlements: events.length,
        });
      } catch {
        // provider not ready yet — silently retry on next interval
      }
    }

    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [contracts]);

  const items = [
    { icon: "💱", label: "Total Volume",  val: stats.volume      !== "—" ? `$${(+stats.volume).toFixed(2)}`      : "—" },
    { icon: "⚡", label: "Fees",          val: stats.fees        !== "—" ? `$${(+stats.fees).toFixed(4)}`        : "—" },
    { icon: "🏦", label: "Vault Assets",  val: stats.vaultAssets !== "—" ? `$${(+stats.vaultAssets).toFixed(2)}` : "—" },
    { icon: "✅", label: "Settlements",   val: stats.settlements.toString() },
  ];

  return (
    <div className="bg-pk-card/80 border-b border-pk-purple/20 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-6 py-2.5 flex items-center gap-6 overflow-x-auto">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-sm">{item.icon}</span>
            <span className="text-xs text-gray-500">{item.label}:</span>
            <span className="text-sm font-mono font-semibold text-pk-pink">{item.val}</span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-600 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Live · 10s
        </div>
      </div>
    </div>
  );
}
