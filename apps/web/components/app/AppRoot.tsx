"use client";
/* Wallet and query providers for /app: wagmi 2 with injected wallets found through EIP-6963 (Binance Web3 Wallet,
   MetaMask, Rabby), BNB Chain and, when the app runs against a local fork, chain 31337. No WalletConnect. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { createConfig, http, injected, useConfig, WagmiProvider } from "wagmi";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import type { AppConfig } from "@/lib/app-config";
import { bsc, bscFork } from "@/lib/chains";
import { requestSimulation } from "@/lib/sim";
import { Dashboard } from "./Dashboard";
import { TxRunnerContext, type TxRunner } from "./TxFlow";

function wagmiConfig(c: AppConfig) {
  const fork = c.chainId === 31337 ? bscFork(c.localRpcUrl ?? "http://127.0.0.1:8545") : null;
  return fork
    ? createConfig({
        chains: [fork, bsc],
        connectors: [injected()],
        transports: { [fork.id]: http(c.localRpcUrl ?? undefined), [bsc.id]: http() },
        ssr: true,
      })
    : createConfig({ chains: [bsc], connectors: [injected()], transports: { [bsc.id]: http() }, ssr: true });
}

function WalletRunner({ chainId, children }: { chainId: number; children: React.ReactNode }) {
  const config = useConfig();
  const runner = useMemo<TxRunner>(
    () => ({
      chainId,
      simulate: (tx, from: Address) => requestSimulation({ from, to: tx.to, data: tx.data, value: tx.value.toString() }),
      send: (tx) => sendTransaction(config, { to: tx.to, data: tx.data, value: tx.value, chainId }),
      wait: async (hash) => {
        const r = await waitForTransactionReceipt(config, { hash, chainId, timeout: 180_000 });
        return { hash, status: r.status, logs: r.logs };
      },
    }),
    [config, chainId],
  );
  return <TxRunnerContext.Provider value={runner}>{children}</TxRunnerContext.Provider>;
}

export function AppRoot({ config }: { config: AppConfig }) {
  const [wagmi] = useState(() => wagmiConfig(config));
  const [queries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmi}>
      <QueryClientProvider client={queries}>
        <WalletRunner chainId={config.chainId}>
          <Dashboard config={config} />
        </WalletRunner>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
