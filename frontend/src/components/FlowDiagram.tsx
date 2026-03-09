import React from "react"; // needed for React.Fragment

interface Props {
  /** 0 = idle · 1 = customer · 2 = router · 3 = dex · 4 = merchant · 5 = vault */
  activeStep: number;
}

const NODES = [
  { icon: "👤", label: "Customer",   sub: "DOT holder" },
  { icon: "🔀", label: "Router",     sub: "Smart contract" },
  { icon: "⚡", label: "DEX Swap",   sub: "DOT → USDC" },
  { icon: "🏪", label: "Merchant",   sub: "USDC receiver" },
  { icon: "📈", label: "Vault",      sub: "5% APY" },
] as const;

const ARROWS = ["XCM", "Swap", "Settle", "Deposit"] as const;

export function FlowDiagram({ activeStep }: Props) {
  return (
    <div className="card mb-6">
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-4">
        Payment Flow
      </p>

      <div className="flex items-center justify-center gap-1 overflow-x-auto pb-1">
        {NODES.map((node, i) => {
          const isActive  = activeStep === i + 1;
          const isDone    = activeStep >  i + 1;

          return (
            <React.Fragment key={i}>
              {/* Node */}
              <div
                className={[
                  "flex flex-col items-center p-3 rounded-2xl border w-[90px] flex-shrink-0",
                  "transition-all duration-500",
                  isActive
                    ? "border-pk-pink bg-pk-pink/10 animate-pulse-pk"
                    : isDone
                    ? "border-pk-purple/60 bg-pk-purple/10"
                    : "border-pk-purple/15 bg-pk-deep/50",
                ].join(" ")}
              >
                <span className={`text-xl mb-1 transition-all duration-300 ${isActive ? "scale-110" : ""}`}>
                  {node.icon}
                </span>
                <span className="text-[11px] font-semibold text-center text-white leading-tight">
                  {node.label}
                </span>
                <span className="text-[9px] text-gray-500 mt-0.5 text-center">{node.sub}</span>
              </div>

              {/* Arrow */}
              {i < NODES.length - 1 && (
                <div className="flex flex-col items-center gap-0.5 mx-0.5 flex-shrink-0">
                  {/* Line with shimmer */}
                  <div className="relative overflow-hidden h-px w-12 rounded-full">
                    <div
                      className={`absolute inset-0 ${
                        activeStep > i + 1 ? "bg-pk-pink" : "bg-pk-purple/25"
                      }`}
                    />
                    {activeStep === i + 2 && (
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-pk-pink to-transparent animate-flow-line" />
                    )}
                  </div>
                  {/* Arrow head */}
                  <div
                    className={`text-[8px] font-bold tracking-wider ${
                      activeStep > i + 1 ? "text-pk-pink" : "text-gray-700"
                    }`}
                  >
                    {ARROWS[i]}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Step legend */}
      {activeStep > 0 && (
        <div className="mt-3 text-center text-xs text-pk-pink animate-fade-in">
          {activeStep === 1 && "Step 1 — Payment request created"}
          {activeStep === 2 && "Step 2 — Customer initiating payment…"}
          {activeStep === 3 && "Step 3 — Simulating XCM + DEX swap…"}
          {activeStep === 4 && "Step 4 — USDC settled to merchant ✅"}
          {activeStep === 5 && "Step 5 — Earning yield in PolkaFlowVault 📈"}
        </div>
      )}
    </div>
  );
}
