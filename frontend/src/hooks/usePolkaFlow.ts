import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import deploymentsJson from "../deployments.json";

// ─── Network config ───────────────────────────────────────────────────────────

const HUB_PASEO_ID  = 420420417;
const HUB_PASEO_HEX = "0x" + HUB_PASEO_ID.toString(16); // 0x190F2DC1
const LOCALHOST_ID  = 31337;

const HUB_PASEO_PARAMS = {
  chainId:           HUB_PASEO_HEX,
  chainName:         "Polkadot Asset Hub Paseo",
  nativeCurrency:    { name: "PAS", symbol: "PAS", decimals: 18 },
  rpcUrls:           ["https://eth-rpc-testnet.polkadot.io/"],
  blockExplorerUrls: ["https://blockscout-testnet.polkadot.io/"],
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Contracts {
  router: ethers.Contract;
  vault:  ethers.Contract;
  usdc:   ethers.Contract;
  dot:    ethers.Contract;
}

export type Deployments = typeof deploymentsJson;

export interface UsePolkaFlowResult {
  account:      string | null;
  chainId:      number | null;
  provider:     ethers.BrowserProvider | null;
  contracts:    Contracts | null;
  connect:      () => Promise<void>;
  connecting:   boolean;
  error:        string | null;
  isHubPaseo:  boolean;
  isLocalhost:  boolean;
  deployments:  Deployments;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePolkaFlow(): UsePolkaFlowResult {
  const [account,    setAccount]    = useState<string | null>(null);
  const [chainId,    setChainId]    = useState<number | null>(null);
  const [provider,   setProvider]   = useState<ethers.BrowserProvider | null>(null);
  const [contracts,  setContracts]  = useState<Contracts | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Build contract instances from a signer.
  const buildContracts = (signer: ethers.JsonRpcSigner): Contracts => ({
    router: new ethers.Contract(
      deploymentsJson.PolkaFlowRouter.address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentsJson.PolkaFlowRouter.abi as any,
      signer,
    ),
    vault: new ethers.Contract(
      deploymentsJson.PolkaFlowVault.address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentsJson.PolkaFlowVault.abi as any,
      signer,
    ),
    usdc: new ethers.Contract(
      deploymentsJson.MockUSDC.address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentsJson.MockUSDC.abi as any,
      signer,
    ),
    dot: new ethers.Contract(
      deploymentsJson.MockDOT.address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentsJson.MockDOT.abi as any,
      signer,
    ),
  });

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("MetaMask not found — please install it to continue.");
      return;
    }
    setConnecting(true);
    setError(null);

    try {
      const prov = new ethers.BrowserProvider(window.ethereum);
      await prov.send("eth_requestAccounts", []);

      // Try switching to Polkadot Asset Hub Paseo; silently continue on localhost.
      try {
        await prov.send("wallet_switchEthereumChain", [{ chainId: HUB_PASEO_HEX }]);
      } catch (switchErr) {
        const code = (switchErr as { code?: number }).code;
        if (code === 4902) {
          // Chain not yet added in MetaMask — add it.
          await prov.send("wallet_addEthereumChain", [HUB_PASEO_PARAMS]);
        }
        // code 4001 = user rejected switch → allow (localhost dev mode).
      }

      const signer  = await prov.getSigner();
      const address = await signer.getAddress();
      const network = await prov.getNetwork();

      setProvider(prov);
      setAccount(address);
      setChainId(Number(network.chainId));
      setContracts(buildContracts(signer));
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (err.code !== 4001) {
        setError(err.message?.slice(0, 120) ?? "Connection failed.");
      }
    } finally {
      setConnecting(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to MetaMask account / chain changes.
  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged = (accounts: unknown) => {
      const list = accounts as string[];
      if (list.length === 0) {
        setAccount(null);
        setContracts(null);
      } else {
        setAccount(list[0]);
      }
    };

    const onChainChanged = () => window.location.reload();

    window.ethereum.on("accountsChanged", onAccountsChanged as () => void);
    window.ethereum.on("chainChanged",    onChainChanged);

    return () => {
      window.ethereum?.removeListener("accountsChanged", onAccountsChanged as () => void);
      window.ethereum?.removeListener("chainChanged",    onChainChanged);
    };
  }, []);

  return {
    account,
    chainId,
    provider,
    contracts,
    connect,
    connecting,
    error,
    isHubPaseo:  chainId === HUB_PASEO_ID,
    isLocalhost:  chainId === LOCALHOST_ID,
    deployments:  deploymentsJson,
  };
}
