import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../hooks/usePolkaFlow";

interface Props {
  contracts:    Contracts | null;
  account:      string | null;
  onStepChange: (step: number) => void;
}

interface PaymentRow {
  paymentId:     string;
  amount:        string;
  autoVault:     boolean;
  status:        "pending" | "settled" | "vaulted";
  settledAmount: string | null;
  createdAt:     number;
}

interface VaultInfo {
  shares:  bigint;
  preview: string;
  yield:   string;
}

function trunc(id: string): string {
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function parsePaymentIdFromLogs(router: ethers.Contract, receipt: ethers.ContractTransactionReceipt): string {
  for (const log of receipt.logs) {
    try {
      const p = router.interface.parseLog({ data: log.data, topics: [...log.topics] });
      if (p?.name === "PaymentCreated") return p.args.paymentId as string;
    } catch {}
  }
  throw new Error("PaymentCreated event not found in receipt");
}

export function MerchantPanel({ contracts, account, onStepChange }: Props) {
  const [amount,     setAmount]     = useState("20");
  const [autoVault,  setAutoVault]  = useState(true);
  const [creating,   setCreating]   = useState(false);
  const [createErr,  setCreateErr]  = useState<string | null>(null);
  const [payments,   setPayments]   = useState<PaymentRow[]>([]);
  const [copiedId,   setCopiedId]   = useState<string | null>(null);
  const [vault,      setVaultInfo]  = useState<VaultInfo | null>(null);
  const [withdrawing,setWithdrawing]= useState(false);

  // ── Vault info ────────────────────────────────────────────────────────────
  const refreshVault = useCallback(async () => {
    if (!contracts || !account) return;
    try {
      const [shares, preview, yieldAmt] = await Promise.all([
        contracts.vault.balanceOf(account),
        contracts.vault.previewWithdrawAll(account),
        contracts.vault.getYield(account),
      ]);
      setVaultInfo({
        shares:  BigInt(shares),
        preview: ethers.formatUnits(preview,  6),
        yield:   ethers.formatUnits(yieldAmt, 6),
      });
    } catch {}
  }, [contracts, account]);

  useEffect(() => {
    refreshVault();
    const id = setInterval(refreshVault, 10_000);
    return () => clearInterval(id);
  }, [refreshVault]);

  // ── PaymentSettled polling (Paseo RPC doesn't support eth_newFilter) ────────
  useEffect(() => {
    if (!contracts || !account) return;

    let lastBlock = 0;

    const poll = async () => {
      try {
        const filter = contracts.router.filters["PaymentSettled"](null, account);
        const events = await contracts.router.queryFilter(filter, lastBlock || -2000);
        if (events.length === 0) return;

        const latest = events[events.length - 1];
        lastBlock = latest.blockNumber + 1;

        for (const ev of events) {
          const parsed = contracts.router.interface.parseLog({ data: ev.data, topics: [...ev.topics] });
          if (!parsed) continue;
          const paymentId    = parsed.args.paymentId as string;
          const usdcAmount   = BigInt(parsed.args.netAmount);
          const vaultedAmount= BigInt(parsed.args.vaultedAmount);
          const isVaulted    = vaultedAmount > 0n;

          setPayments(prev =>
            prev.map(p =>
              p.paymentId === paymentId
                ? { ...p, status: isVaulted ? "vaulted" : "settled", settledAmount: ethers.formatUnits(usdcAmount, 6) }
                : p,
            ),
          );
          onStepChange(isVaulted ? 5 : 4);
        }
        refreshVault();
      } catch {}
    };

    const id = setInterval(poll, 5_000);
    poll();
    return () => clearInterval(id);
  }, [contracts, account, refreshVault, onStepChange]);

  // ── Create request ────────────────────────────────────────────────────────
  const createRequest = async () => {
    if (!contracts || !amount) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const amtBig = ethers.parseUnits(amount, 6);
      const tx = autoVault
        ? await contracts.router.createPaymentRequestWithVault(amtBig, ethers.ZeroAddress, true, { gasLimit: 300_000 })
        : await contracts.router.createPaymentRequest(amtBig, ethers.ZeroAddress, { gasLimit: 300_000 });

      const receipt = await tx.wait();
      if (!receipt) throw new Error("No receipt");
      const paymentId = parsePaymentIdFromLogs(contracts.router, receipt);

      setPayments(prev => [{
        paymentId, amount, autoVault, status: "pending",
        settledAmount: null, createdAt: Date.now(),
      }, ...prev]);
      onStepChange(1);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (err.code !== 4001) setCreateErr(err.message?.slice(0, 100) ?? "Failed");
    } finally {
      setCreating(false);
    }
  };

  // ── Copy ──────────────────────────────────────────────────────────────────
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ── Withdraw ──────────────────────────────────────────────────────────────
  const withdraw = async () => {
    if (!contracts || !vault || vault.shares === 0n) return;
    setWithdrawing(true);
    try {
      const tx = await contracts.vault.withdraw(vault.shares, { gasLimit: 200_000 });
      await tx.wait();
      await refreshVault();
    } catch {}
    finally { setWithdrawing(false); }
  };

  const hasVaultBalance = vault && vault.shares > 0n;

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Create Request ─────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
          <span>🧾</span> Create Payment Request
        </h2>

        <div className="space-y-4">
          {/* Amount */}
          <div>
            <label className="label">Amount (USDC)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
              <input
                type="number" min="0.01" step="0.01"
                value={amount} onChange={e => setAmount(e.target.value)}
                className="field pl-7" placeholder="20.00"
                disabled={creating}
              />
            </div>
          </div>

          {/* Auto-vault toggle */}
          <button
            onClick={() => setAutoVault(v => !v)}
            disabled={creating}
            className={[
              "w-full flex items-center justify-between p-3.5 rounded-xl border transition-all",
              autoVault
                ? "border-pk-pink/40 bg-pk-pink/8"
                : "border-pk-purple/25 bg-pk-deep",
            ].join(" ")}
          >
            <div className="text-left">
              <p className="text-sm font-semibold text-white">Auto-deposit to Vault</p>
              <p className="text-xs text-gray-400 mt-0.5">Earn 5% APY on every settlement</p>
            </div>
            {/* Toggle pill */}
            <div className={`relative h-6 w-11 rounded-full transition-colors duration-300 flex-shrink-0 ${autoVault ? "bg-pk-pink" : "bg-gray-700"}`}>
              <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform duration-300 ${autoVault ? "translate-x-6" : "translate-x-1"}`} />
            </div>
          </button>

          {createErr && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">
              {createErr}
            </p>
          )}

          <button onClick={createRequest} disabled={creating || !contracts || !amount} className="btn-pk w-full">
            {creating ? <><span className="spinner inline-block" /> Creating…</> : "Create Request →"}
          </button>

          {!contracts && (
            <p className="text-xs text-gray-600 text-center">Connect wallet to create requests</p>
          )}
        </div>
      </div>

      {/* ── Payment table ──────────────────────────────────────────────── */}
      {payments.length > 0 && (
        <div className="card animate-slide-up">
          <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
            <span>📋</span> My Payments
          </h2>

          {/* Latest paymentId callout */}
          <div className="mb-4 p-3 rounded-xl bg-pk-deep border border-pk-pink/25">
            <p className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wide">
              Latest ID — share with customer:
            </p>
            <div className="flex items-center gap-2">
              <code className="font-mono text-[11px] text-pk-pink flex-1 break-all leading-relaxed">
                {payments[0].paymentId}
              </code>
              <button
                onClick={() => copy(payments[0].paymentId)}
                className="flex-shrink-0 text-xs border border-pk-purple/40 rounded-lg px-2.5 py-1
                           text-gray-400 hover:text-pk-pink hover:border-pk-pink/50 transition-colors"
              >
                {copiedId === payments[0].paymentId ? "✓" : "⧉"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-gray-600 border-b border-pk-purple/15">
                  <th className="text-left pb-2 pr-4 font-medium">ID</th>
                  <th className="text-right pb-2 pr-4 font-medium">Amount</th>
                  <th className="text-center pb-2 pr-4 font-medium">Status</th>
                  <th className="text-center pb-2 font-medium">Copy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-pk-purple/10">
                {payments.map(p => (
                  <tr key={p.paymentId} className="hover:bg-pk-deep/40 transition-colors">
                    <td className="py-2.5 pr-4">
                      <span className="font-mono text-[11px] text-pk-pink">{trunc(p.paymentId)}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-white tabular-nums">
                      ${p.settledAmount ?? p.amount}
                    </td>
                    <td className="py-2.5 pr-4 text-center">
                      {p.status === "settled" && <span className="badge-green">Settled</span>}
                      {p.status === "vaulted" && <span className="badge-purple">Vaulted 🏦</span>}
                      {p.status === "pending" && <span className="badge-yellow">Pending…</span>}
                    </td>
                    <td className="py-2.5 text-center">
                      <button
                        onClick={() => copy(p.paymentId)}
                        className="text-gray-500 hover:text-pk-pink transition-colors px-1"
                      >
                        {copiedId === p.paymentId ? "✓" : "⧉"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Vault card ─────────────────────────────────────────────────── */}
      {vault && (
        <div className="card border-pk-purple/40 animate-slide-up">
          <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
            <span>🏦</span> My Vault
            <span className="ml-auto text-[11px] font-medium text-pk-pink bg-pk-pink/10 px-2.5 py-0.5 rounded-full border border-pk-pink/25">
              5% APY
            </span>
          </h2>

          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: "Shares",     val: Number(vault.shares).toLocaleString(), accent: false },
              { label: "Claimable",  val: `$${(+vault.preview).toFixed(4)}`,     accent: false },
              { label: "Yield",      val: `+$${(+vault.yield).toFixed(6)}`,      accent: true  },
            ].map(({ label, val, accent }) => (
              <div key={label} className={`rounded-xl p-3 ${accent ? "bg-pk-pink/8 border border-pk-pink/20" : "bg-pk-deep"}`}>
                <p className={`text-[10px] uppercase tracking-wide mb-1 ${accent ? "text-pk-pink" : "text-gray-500"}`}>
                  {label}
                </p>
                <p className={`text-sm font-bold tabular-nums ${accent ? "text-pk-pink" : "text-white"}`}>
                  {val}
                </p>
              </div>
            ))}
          </div>

          <button
            onClick={withdraw}
            disabled={withdrawing || !hasVaultBalance}
            className="btn-outline w-full"
          >
            {withdrawing ? <><span className="spinner inline-block" /> Withdrawing…</> : "Withdraw All →"}
          </button>
          {!hasVaultBalance && (
            <p className="text-xs text-gray-600 text-center mt-2">No vault balance yet</p>
          )}
        </div>
      )}
    </div>
  );
}
