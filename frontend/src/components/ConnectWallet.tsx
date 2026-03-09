
interface Props {
  account:    string | null;
  chainId:    number | null;
  connecting: boolean;
  onConnect:  () => void;
}

const HUB_PASEO_ID = 420420417;
const LOCALHOST_ID = 31337;

function trunc(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectWallet({ account, chainId, connecting, onConnect }: Props) {
  const networkName =
    chainId === HUB_PASEO_ID ? "Polkadot Hub Paseo" :
    chainId === LOCALHOST_ID  ? "Localhost (Dev)"     :
    chainId                   ? `Chain ${chainId}`    : null;

  const isKnownNetwork = chainId === HUB_PASEO_ID || chainId === LOCALHOST_ID;
  const dotColor       = isKnownNetwork ? "bg-pk-pink animate-pulse" : "bg-yellow-400 animate-pulse";

  if (account) {
    return (
      <div className="flex items-center gap-3 flex-wrap justify-end">
        {networkName && (
          <span className="badge-network">
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            {networkName}
          </span>
        )}
        <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl
                         bg-pk-deep border border-pk-purple/40 text-sm text-gray-300">
          <span className="w-2 h-2 rounded-full bg-green-400" />
          {trunc(account)}
        </span>
      </div>
    );
  }

  return (
    <button onClick={onConnect} disabled={connecting} className="btn-pk flex items-center gap-2">
      {connecting ? (
        <>
          <span className="spinner" />
          Connecting…
        </>
      ) : (
        <>
          <span>🦊</span>
          Connect MetaMask
        </>
      )}
    </button>
  );
}
