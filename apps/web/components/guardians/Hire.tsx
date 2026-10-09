"use client";
/* Hire a guardian: the owner of a credit line posts an ERC-8183 job for the coming closure, sets the fee,
   approves it and funds the job with its terms. Every call is simulated before the wallet is asked; a refusal
   stops there with the decoded reason. Loaded only when the form is opened. */
import { parseDeployment } from "@ballast/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { createConfig, http, injected, useAccount, useConfig, useSwitchChain, WagmiProvider } from "wagmi";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { WalletControl } from "@/components/app/AppBar";
import { fetchToken, useAccounts } from "@/components/app/data";
import { AmountField } from "@/components/app/fields";
import { TxFlow, TxRunnerContext, type TxReceiptLite, type TxRunner } from "@/components/app/TxFlow";
import { parseAmount } from "@/lib/amount";
import { CHAIN_NAME, type AppConfig } from "@/lib/app-config";
import { bsc, bscFork } from "@/lib/chains";
import { shortHex, units } from "@/lib/format";
import { createJobStep, fundSteps, guardWindow, hireProblems, jobIdFromLogs, windowText } from "@/lib/guardian-steps";
import { DESK_AGENT_ID } from "@/lib/identity";
import { requestSimulation } from "@/lib/sim";
import type { TxStep } from "@/lib/steps";
import type { AccountView } from "@/lib/views";
import a from "@/components/app/app.module.css";
import s from "./guardians.module.css";

const VENUE = { lista: "Lista", venus: "Venus" } as const;

export interface HireFormProps {
  deployment: ReturnType<typeof parseDeployment>;
  wallet: Address;
  accounts: readonly AccountView[];
  /** the guardian's address, as the ERC-8004 registry gives it */
  provider: Address | null;
  /** BallastGuardian.minBudget in token units; null when unread */
  minBudget: bigint | null;
  now: number;
  /** balance and kernel allowance of the fee token for the wallet */
  loadToken: (token: Address, owner: Address, spender: Address) => Promise<{ balance: bigint; allowance: bigint }>;
  onFunded?: (jobId: bigint) => void;
}

type Stage = { kind: "form" } | { kind: "create"; steps: TxStep[] } | { kind: "fund"; jobId: bigint; steps: TxStep[] } | { kind: "done"; jobId: bigint };

/** The form and its two transaction flows. The wallet, the accounts and the token read are handed in. */
export function HireForm({ deployment: d, wallet, accounts, provider, minBudget, now, loadToken, onFunded }: HireFormProps) {
  const guardable = accounts.filter((x) => BigInt(x.debt) > 0n && !x.liquidated);
  const [picked, setPicked] = useState<string | null>(null);
  const [feeText, setFeeText] = useState("0.05");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const account = guardable.find((x) => x.address === picked) ?? guardable[0] ?? null;
  const window = useMemo(() => guardWindow(now, account?.oracle?.restoreDelay ?? undefined), [now, account?.oracle?.restoreDelay]);
  const fee = account ? parseAmount(feeText, account.loanDecimals) : null;
  const problems = hireProblems({ account, wallet, provider, fee, minBudget, window });

  if (accounts.length === 0) {
    return (
      <div className={a.empty}>
        <h3>This wallet has no Ballast credit line</h3>
        <p>A guardian job guards one credit line. Open one on the dashboard first, borrow against it, then come back to hire a guardian for it.</p>
      </div>
    );
  }
  if (guardable.length === 0) {
    return (
      <div className={a.empty}>
        <h3>None of your credit lines has a loan to guard</h3>
        <p>The guardian contract binds a job only to a credit line that has debt and has not been liquidated.</p>
      </div>
    );
  }

  const start = async () => {
    if (!account || !provider || fee === null || !window || problems.length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const t = await loadToken(account.loanToken, wallet, d.external.kernel);
      const late = hireProblems({ account, wallet, provider, fee, minBudget, window, balance: t.balance });
      if (late.length > 0) {
        setFailure(late[0]!);
        return;
      }
      setStage({ kind: "create", steps: [createJobStep(d, { provider, token: account.loanToken, tokenSymbol: account.loanSymbol, window, symbol: account.symbol })] });
    } catch (err) {
      setFailure(`The fee token could not be read: ${(err as Error).message}. Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  };

  const created = async (receipts: TxReceiptLite[]) => {
    if (!account || fee === null || !window) return;
    const jobId = jobIdFromLogs(receipts[0]?.logs ?? [], d.external.kernel);
    if (jobId === null) {
      setFailure("The job was created but its id was not found in the receipt. Find it on the board above before funding anything.");
      setStage({ kind: "form" });
      return;
    }
    let allowance = 0n;
    try {
      allowance = (await loadToken(account.loanToken, wallet, d.external.kernel)).allowance;
    } catch {
      // an unread allowance only means the approval step is kept
    }
    // the window is read again now: funding must land within five minutes of a start that is "now"
    const fresh = guardWindow(Math.floor(Date.now() / 1000), account.oracle?.restoreDelay ?? undefined) ?? window;
    setStage({ kind: "fund", jobId, steps: fundSteps(d, { jobId, fee, token: account.loanToken, tokenSymbol: account.loanSymbol, tokenDecimals: account.loanDecimals, allowance, account: account.address, agentId: DESK_AGENT_ID, window: fresh }) });
  };

  if (stage.kind === "create") return <TxFlow key="create" steps={stage.steps} from={wallet} onComplete={(r) => void created(r)} onCancel={() => setStage({ kind: "form" })} />;
  if (stage.kind === "fund") {
    return (
      <>
        <p className={a.simOk}>
          <b>Job {stage.jobId.toString()} is posted.</b> It holds nothing yet: the next steps set its fee and fund it.
        </p>
        <TxFlow
          key="fund"
          steps={stage.steps}
          from={wallet}
          onComplete={() => {
            setStage({ kind: "done", jobId: stage.jobId });
            onFunded?.(stage.jobId);
          }}
          onCancel={() => setStage({ kind: "form" })}
          cancelLabel="Stop here"
        />
      </>
    );
  }
  if (stage.kind === "done") {
    return (
      <div className={a.empty}>
        <h3>Job {stage.jobId.toString()} is funded</h3>
        <p>The fee is in escrow and the terms are bound. The job appears on the board within a minute; when the window ends the guardian submits its evidence and anyone can settle.</p>
        <div className={a.actions}>
          <button type="button" className={a.btnGhost} onClick={() => setStage({ kind: "form" })}>
            Hire for another credit line
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={a.form}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className={a.fields}>
        <div className={a.field}>
          <label htmlFor="hire-account">Credit line to guard</label>
          <select id="hire-account" value={account?.address ?? ""} onChange={(e) => setPicked(e.target.value)}>
            {guardable.map((x) => (
              <option key={x.address} value={x.address}>
                {VENUE[x.venue]} {x.collateralSymbol} / {x.loanSymbol}, {units(x.debt, x.loanDecimals)} {x.loanSymbol} borrowed ({shortHex(x.address)})
              </option>
            ))}
          </select>
          <span className={a.help}>The guardian contract checks that this wallet owns it and that it has debt.</span>
        </div>
        <AmountField
          label="Fee"
          value={feeText}
          onChange={setFeeText}
          unit={account?.loanSymbol ?? ""}
          decimals={account?.loanDecimals ?? 18}
          help={`Held in escrow by the ERC-8183 kernel. Paid to the guardian only if the loan survives the window; returned to you otherwise.${minBudget !== null && account ? ` Minimum ${units(minBudget, account.loanDecimals, 4)} ${account.loanSymbol}.` : ""}`}
        />
      </div>
      <dl className={s.terms}>
        <div>
          <dt>Window</dt>
          <dd>{window ? windowText(window) : "The calendar does not cover the coming closure"}</dd>
        </div>
        <div>
          <dt>Guardian</dt>
          <dd>{provider ? `ERC-8004 agent ${DESK_AGENT_ID.toString()}, ${shortHex(provider, 6, 4)}` : "not known"}</dd>
        </div>
        <div>
          <dt>What the job grants</dt>
          <dd>
            No power over the credit line. Only the keeper your credit line names can shield it; the job decides whether the guardian is paid.
            {account && provider && account.keeper.toLowerCase() !== provider.toLowerCase() ? " This credit line's keeper is another address, so this guardian cannot act on it." : ""}
          </dd>
        </div>
      </dl>
      {problems.length > 0 ? (
        <ul className={a.problems} aria-label="What stops this job">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {failure ? <p className={a.problems}>{failure}</p> : null}
      <div className={a.formFoot}>
        <p>Four transactions: post the job, set the fee, approve it, fund the job. Each is simulated first and nothing is sent unless its simulation passes.</p>
        <button type="submit" className={a.btn} disabled={problems.length > 0 || busy}>
          {busy ? "Checking..." : "Simulate the first step"}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ wallet wiring

function Connected({ config, provider, minBudget, now, onFunded }: { config: AppConfig; provider: Address | null; minBudget: bigint | null; now: number; onFunded?: () => void }) {
  const { address, isConnected, chainId: walletChain } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const deployment = useMemo(() => (config.deployment.status === "ok" ? parseDeployment(config.chainId, config.deployment.json) : null), [config]);
  const onChain = isConnected && walletChain === config.chainId;
  const accounts = useAccounts(address, onChain && !!deployment);

  if (!deployment) return <p className={a.offline}>The contracts are not deployed on this chain yet, so no job can be posted.</p>;
  if (!isConnected || !address) {
    return (
      <div className={a.empty}>
        <h3>Connect the wallet that owns the credit line</h3>
        <p>Only the owner of a Ballast credit line can post a guardian job for it.</p>
        <div className={a.actions}>
          <WalletControl align="left" look="button" />
        </div>
      </div>
    );
  }
  if (!onChain) {
    return (
      <div className={a.empty}>
        <h3>Your wallet is on another network</h3>
        <p>Guardian jobs live on {CHAIN_NAME[config.chainId]}.</p>
        <div className={a.actions}>
          <button type="button" className={a.btn} disabled={isPending} onClick={() => switchChain({ chainId: config.chainId })}>
            Switch to {CHAIN_NAME[config.chainId]}
          </button>
        </div>
      </div>
    );
  }
  if (accounts.isLoading) return <p className={a.muted}>Reading your credit lines.</p>;
  const body = accounts.data;
  if (accounts.isError || !body || body.status !== "ok") {
    return <p className={a.offline}>Your credit lines could not be read: {accounts.isError ? (accounts.error as Error).message : body && body.status !== "ok" ? body.detail : "no answer"}. Nothing is assumed in their place.</p>;
  }
  return (
    <HireForm
      deployment={deployment}
      wallet={address}
      accounts={body.accounts}
      provider={provider}
      minBudget={minBudget}
      now={now}
      loadToken={async (token, owner, spender) => {
        const t = await fetchToken(token, owner, spender);
        return { balance: BigInt(t.balance), allowance: BigInt(t.allowance ?? "0") };
      }}
      onFunded={onFunded}
    />
  );
}

function Runner({ chainId, children }: { chainId: number; children: React.ReactNode }) {
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

export default function Hire({ config, provider, minBudget, now, onFunded }: { config: AppConfig; provider: Address | null; minBudget: string | null; now: number; onFunded?: () => void }) {
  const [wagmi] = useState(() => {
    const fork = config.chainId === 31337 ? bscFork(config.localRpcUrl ?? "http://127.0.0.1:8545") : null;
    return fork
      ? createConfig({ chains: [fork, bsc], connectors: [injected()], transports: { [fork.id]: http(config.localRpcUrl ?? undefined), [bsc.id]: http() }, ssr: true })
      : createConfig({ chains: [bsc], connectors: [injected()], transports: { [bsc.id]: http() }, ssr: true });
  });
  const [queries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmi}>
      <QueryClientProvider client={queries}>
        <Runner chainId={config.chainId}>
          <Connected config={config} provider={provider} minBudget={minBudget === null ? null : BigInt(minBudget)} now={now} onFunded={onFunded} />
        </Runner>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
