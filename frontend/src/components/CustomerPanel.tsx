import { useState, useEffect } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../hooks/usePolkaFlow";

interface Props {
  contracts:    Contracts | null;
  account:      string | null;
  onStepChange: (step: number) => void;
}

type Token  = "USDC" | "DOT";
type Status = "idle" | "approving" | "paying" | "awaiting-settle" | "done" | "error";

interface PaymentInfo {
  merchant:   string;
  amountUSDC: string;
  settled:    boolean;
}

function trunc(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function statusBanner(s: Status): { text: string; cls: string } {
  const map: Record<Status, { text: string; cls: string }> = {
    "idle":            { text: "", cls: "" },
    "approving":       { text: "⏳ Approving token spend…",          cls: "text-pk-pink bg-pk-pink/8 border-pk-pink/20" },
    "paying":          { text: "⏳ Sending payment…",                cls: "text-pk-pink bg-pk-pink/8 border-pk-pink/20" },
    "awaiting-settle": { text: "🔄 DOT locked — relayer is settling…", cls: "text-pk-purple bg-pk-purple/10 border-pk-purple/30" },
    "done":            { text: "✅ Payment complete!",               cls: "text-green-400 bg-green-900/20 border-green-700/30" },
    "error":           { text: "❌ Transaction failed",              cls: "text-red-400 bg-red-900/20 border-red-800/30" },
  };
  return map[s];
}

export function CustomerPanel({ contracts, account, onStepChange }: Props) {
  const [paymentId, setPaymentId] = useState("");
  const [token,     setToken]     = useState<Token>("DOT");
  const [dotAmount, setDotAmount] = useState("3");
  const [payInfo,   setPayInfo]   = useState<PaymentInfo | null>(null);
  const [status,    setStatus]    = useState<Status>("idle");
  const [txHash,    setTxHash]    = useState<string | null>(null);
  const [txError,   setTxError]   = useState<string | null>(null);
  const [minting,   setMinting]   = useState(false);
  const [mintDone,  setMintDone]  = useState(false);

  // ── Auto-load payment request info ───────────────────────────────────────
  useEffect(() => {
    if (!contracts || paymentId.length < 10) { setPayInfo(null); return; }

    let active = true;
    (async () => {
      try {
        const req = await contracts.router.getPaymentRequest(paymentId);
        if (!active) return;
        if (req.createdAt === 0n || req.merchant === ethers.ZeroAddress) {
          setPayInfo(null);
          return;
        }
        setPayInfo({
          merchant:   req.merchant as string,
          amountUSDC: ethers.formatUnits(req.amountUSDC, 6),
          settled:    req.settled as boolean,
        });
      } catch { setPayInfo(null); }
    })();

    return () => { active = false; };
  }, [contracts, paymentId]);

  // ── Poll for PaymentSettled while awaiting relayer ───────────────────────
  useEffect(() => {
    if (!contracts || !paymentId || status !== "awaiting-settle") return;

    const poll = async () => {
      try {
        const filter = contracts.router.filters["PaymentSettled"](paymentId);
        const events = await contracts.router.queryFilter(filter, -2000);
        if (events.length === 0) return;

        const ev = events[events.length - 1];
        setTxHash(ev.transactionHash);
        setStatus("done");
        onStepChange(4);
      } catch {}
    };

    const id = setInterval(poll, 4_000);
    poll();
    return () => clearInterval(id);
  }, [contracts, paymentId, status, onStepChange]);

  // ── Pay ───────────────────────────────────────────────────────────────────
  const pay = async () => {
    if (!contracts || !paymentId || !account) return;
    setTxError(null);

    try {
      const usdcAmt = ethers.parseUnits(payInfo?.amountUSDC ?? "20", 6);

      if (token === "USDC") {
        setStatus("approving");
        await (await contracts.usdc.approve(await contracts.router.getAddress(), usdcAmt, { gasLimit: 100_000 })).wait();

        setStatus("paying");
        const payTx  = await contracts.router.payWithStablecoin(
          paymentId, await contracts.usdc.getAddress(), usdcAmt, { gasLimit: 300_000 },
        );
        const receipt = await payTx.wait();
        setTxHash(receipt?.hash ?? null);
        setStatus("done");
        onStepChange(4);

      } else {
        // DOT path — lock tokens, then relayer auto-settles
        const dotBig = ethers.parseEther(dotAmount || "3");

        setStatus("approving");
        await (await contracts.dot.approve(await contracts.router.getAddress(), dotBig, { gasLimit: 100_000 })).wait();

        setStatus("paying");
        const payTx  = await contracts.router.payWithToken(
          paymentId, await contracts.dot.getAddress(), dotBig, { gasLimit: 200_000 },
        );
        const receipt = await payTx.wait();
        setTxHash(receipt?.hash ?? null);
        setStatus("awaiting-settle");
        onStepChange(3);   // "relayer settling" step
      }
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (err.code !== 4001) {
        setTxError(err.message?.slice(0, 120) ?? "Transaction failed");
        setStatus("error");
      } else {
        setStatus("idle");
      }
    }
  };

  const mintTokens = async () => {
    if (!contracts || !account) return;
    setMinting(true);
    try {
      const usdcTx = await contracts.usdc.mint(account, ethers.parseUnits("1000", 6),  { gasLimit: 100_000 });
      await usdcTx.wait();
      const dotTx  = await contracts.dot.mint(account,  ethers.parseEther("100"),       { gasLimit: 100_000 });
      await dotTx.wait();
      setMintDone(true);
    } catch {}
    finally { setMinting(false); }
  };

  const banner = statusBanner(status);
  const busy   = status === "approving" || status === "paying";

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Get test tokens ─────────────────────────────────────────────── */}
      <div className="card border-pk-purple/30">
        <h2 className="text-base font-bold text-white mb-1 flex items-center gap-2">
          <span>🪙</span> Get Test Tokens
        </h2>
        <p className="text-xs text-gray-500 mb-3">Mint 1,000 MockUSDC + 100 MockDOT to your wallet for testing.</p>
        <button
          onClick={mintTokens}
          disabled={minting || !contracts || mintDone}
          className="btn-outline w-full"
        >
          {minting  ? <><span className="spinner inline-block" /> Minting…</> :
           mintDone ? "✓ Tokens minted" :
           "Mint Test Tokens →"}
        </button>
      </div>

      <div className="card">
        <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
          <span>💳</span> Pay an Invoice
        </h2>

        <div className="space-y-4">
          {/* Payment ID */}
          <div>
            <label className="label">Payment ID</label>
            <input
              type="text" value={paymentId}
              onChange={e => { setPaymentId(e.target.value.trim()); setStatus("idle"); setTxError(null); }}
              className="field font-mono text-xs" placeholder="0x…" disabled={busy}
            />
            {payInfo && (
              <div className="mt-2 p-2.5 rounded-lg bg-green-900/20 border border-green-700/30 text-xs animate-fade-in">
                <span className="text-green-400 font-semibold">✓ Valid </span>
                <span className="text-gray-400">· Merchant: </span>
                <span className="font-mono text-gray-200">{trunc(payInfo.merchant)}</span>
                <span className="text-gray-400"> · </span>
                <span className="text-white font-medium">${payInfo.amountUSDC} USDC</span>
                {payInfo.settled && <span className="ml-2 text-yellow-400">(already settled)</span>}
              </div>
            )}
          </div>

          {/* Token selector */}
          <div>
            <label className="label">Payment Token</label>
            <div className="grid grid-cols-2 gap-2">
              {(["USDC", "DOT"] as Token[]).map(t => (
                <button
                  key={t} onClick={() => setToken(t)} disabled={busy}
                  className={[
                    "py-2.5 rounded-xl border text-sm font-semibold transition-all",
                    token === t
                      ? "bg-pk-pink/15 border-pk-pink text-pk-pink"
                      : "bg-pk-deep border-pk-purple/25 text-gray-400 hover:border-pk-purple",
                  ].join(" ")}
                >
                  {t === "USDC" ? "💵 USDC (direct)" : "🔴 DOT (via swap)"}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          {token === "USDC" ? (
            <div>
              <label className="label">Amount (USDC)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                <input
                  type="number" value={payInfo?.amountUSDC ?? ""} readOnly={!!payInfo}
                  onChange={e => !payInfo && e}
                  className="field pl-7" placeholder="20.00"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="label">DOT Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">◎</span>
                <input
                  type="number" min="0.01" step="0.1"
                  value={dotAmount} onChange={e => setDotAmount(e.target.value)}
                  className="field pl-7" placeholder="3" disabled={busy}
                />
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                DOT locked in router → relayer swaps via SimpleDEX → USDC to merchant
              </p>
            </div>
          )}

          {/* Status banner */}
          {status !== "idle" && banner.text && (
            <div className={`text-xs rounded-xl border px-3.5 py-2.5 ${banner.cls} animate-fade-in`}>
              {banner.text}
            </div>
          )}

          {txError && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl px-3.5 py-2.5 animate-slide-up">
              {txError}
            </div>
          )}

          {/* Pay button */}
          {status !== "done" && status !== "awaiting-settle" && (
            <button onClick={pay} disabled={busy || !contracts || !paymentId} className="btn-pk w-full">
              {busy
                ? <><span className="spinner inline-block" /> Processing…</>
                : token === "DOT"
                ? `Pay ${dotAmount} DOT →`
                : `Pay $${payInfo?.amountUSDC ?? "—"} USDC →`}
            </button>
          )}

          {/* Relayer settling state */}
          {status === "awaiting-settle" && (
            <div className="p-3.5 rounded-xl bg-pk-purple/10 border border-pk-purple/30 animate-slide-up">
              <p className="text-xs font-semibold text-pk-purple mb-1">
                🔄 {dotAmount} DOT locked — relayer settling…
              </p>
              <p className="text-[11px] text-gray-400">
                The PolkaFlow relayer detected your payment and is calling{" "}
                <code className="text-pk-pink">swapAndSettle()</code> on-chain.
                This page will update automatically when the merchant is paid.
              </p>
            </div>
          )}

          {/* Done state */}
          {status === "done" && txHash && (
            <div className="p-4 rounded-xl bg-green-900/15 border border-green-700/25 text-center animate-slide-up">
              <p className="text-green-400 font-semibold mb-1.5">Payment Complete ✅</p>
              <p className="text-[10px] text-gray-500 mb-1">Transaction hash:</p>
              <code className="font-mono text-[10px] text-gray-400 break-all leading-relaxed">
                {txHash}
              </code>
              <button
                onClick={() => { setStatus("idle"); setPaymentId(""); setPayInfo(null); setTxHash(null); setTxError(null); }}
                className="mt-3 btn-outline w-full text-xs py-2"
              >
                Pay Another →
              </button>
            </div>
          )}

          {!contracts && (
            <p className="text-xs text-gray-600 text-center">Connect wallet to make payments</p>
          )}
        </div>
      </div>
    </div>
  );
}
