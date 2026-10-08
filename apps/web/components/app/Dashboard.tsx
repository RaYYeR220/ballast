"use client";
/* /app: the user's week (v09 dashboard). Loan figures come from the chain through the app's routes, the
   watch log, refusals and notes from the desk agent's feed, the clock and countdown from the NYSE calendar.
   When a source is missing the panel says so; nothing is filled in. */
import { session } from "@ballast/risk";
import { parseDeployment } from "@ballast/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { CHAIN_NAME, checksum, type AppConfig } from "@/lib/app-config";
import { sameAddr, type DeskEvent } from "@/lib/desk";
import { eventRow, plannedRows } from "@/lib/feed-rows";
import { shortHex } from "@/lib/format";
import { hourLabel } from "@/lib/planisphere/geometry";
import { hourOfWeek } from "@/lib/planisphere/sessions";
import { AccountActions } from "./AccountActions";
import { AppBar, MobileTabs } from "./AppBar";
import { CoversPanel } from "./CoversPanel";
import { CreateAccountForm } from "./CreateAccount";
import { useAccounts, useDeskFeed, useDeskHealth, useMarkets, useMinuteClock } from "./data";
import { DeskNotes, RefusalLog, WatchLog } from "./DeskPanels";
import { HealthPanel, type HealthContent } from "./HealthPanel";
import { WeekPanel } from "./WeekPanel";
import s from "./app.module.css";

const VENUE = { lista: "Lista", venus: "Venus" } as const;
const NO_EVENTS: DeskEvent[] = [];

export function Dashboard({ config }: { config: AppConfig }) {
  const { address, isConnected, chainId: walletChain } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const queries = useQueryClient();
  const now = useMinuteClock();
  const chainName = CHAIN_NAME[config.chainId];
  const deployment = useMemo(() => (config.deployment.status === "ok" ? parseDeployment(config.chainId, config.deployment.json) : null), [config]);

  const health = useDeskHealth();
  const deskAgent = config.deskAgent ?? (health.data?.status === "online" ? checksum(health.data.data.agent) : null);
  const onChain = isConnected && walletChain === config.chainId;
  const accounts = useAccounts(address, onChain && !!deployment);
  const body = accounts.data;
  const list = body?.status === "ok" ? body.accounts : [];
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const view = list.find((a) => sameAddr(a.address, selected)) ?? list[0] ?? null;
  const feed = useDeskFeed(view ? view.address : null);
  const markets = useMarkets(onChain && !!deployment && (creating || (body?.status === "ok" && list.length === 0)));

  const events = feed.data?.status === "online" ? feed.data.data.events : NO_EVENTS;
  const loanDecimals = view?.loanDecimals;
  const loanSymbol = view?.loanSymbol;
  const units = useMemo(() => (loanDecimals === undefined || !loanSymbol ? undefined : { decimals: loanDecimals, symbol: loanSymbol }), [loanDecimals, loanSymbol]);
  const planned = useMemo(() => (view && now !== null ? plannedRows(view, now, events) : []), [view, now, events]);
  const wheelRows = useMemo(() => (view ? [...planned, ...events.map((e) => eventRow(e, units))] : []), [view, planned, events, units]);

  let content: HealthContent;
  if (!isConnected) content = { kind: "disconnected" };
  else if (!onChain) content = { kind: "wrong-chain", chainName };
  else if (config.deployment.status !== "ok") content = { kind: "not-deployed", detail: config.deployment.detail };
  else if (accounts.isLoading) content = { kind: "loading" };
  else if (accounts.isError) content = { kind: "unavailable", detail: (accounts.error as Error).message };
  else if (body && body.status !== "ok") content = body.status === "not-deployed" ? { kind: "not-deployed", detail: body.detail } : { kind: "unavailable", detail: body.detail };
  else if (view) content = { kind: "account", view, deskAgent };
  else content = { kind: "none" };

  const refresh = () => {
    void accounts.refetch();
    void queries.invalidateQueries({ queryKey: ["token"] });
    void queries.invalidateQueries({ queryKey: ["desk"] });
  };

  const clock = now === null ? "" : `${hourLabel(hourOfWeek(now))} New York, ${session(now) === "REGULAR" ? "market open" : "market closed"}`;

  return (
    <div className={s.shell}>
      <AppBar health={health.data} />
      <main className={s.page}>
        <MobileTabs />
        <div className={s.head}>
          <div>
            <h1>Your week</h1>
            <p>
              {view ? `${view.collateralSymbol} credit line on ${VENUE[view.venue]}. ` : ""}Every time on this page is New York time.
            </p>
          </div>
          <span className={`${s.tag} ${s.live}`} aria-live="off">
            {clock || "New York"}
          </span>
        </div>

        {config.deployment.status !== "ok" ? (
          <div className={s.banner} role="status">
            <span>
              <b>Contracts not deployed yet.</b> Credit lines and covers open here once Ballast is live on {chainName}.
            </span>
          </div>
        ) : null}
        {isConnected && !onChain ? (
          <div className={s.banner} role="status">
            <span>
              <b>Your wallet is on another network.</b> Switch to {chainName} to read and manage your loans.
            </span>
            <button type="button" className={s.btnGhost} disabled={switching} onClick={() => switchChain({ chainId: config.chainId })}>
              {switching ? "Switching..." : `Switch to ${chainName}`}
            </button>
          </div>
        ) : null}

        {list.length > 1 ? (
          <div className={s.switch} role="group" aria-label="Your credit lines">
            {list.map((a) => (
              <button key={a.address} type="button" aria-pressed={a === view} onClick={() => setSelected(a.address)}>
                {a.collateralSymbol} on {VENUE[a.venue]}, {shortHex(a.address)}
              </button>
            ))}
          </div>
        ) : null}

        <div className={s.grid}>
          <WeekPanel now={now} rows={wheelRows} />
          <HealthPanel content={content} chainName={chainName} now={now} />
          <WatchLog feed={feed.data} planned={planned} units={units} chainId={config.chainId} scope={view ? "account" : "desk"} />
          <RefusalLog feed={feed.data} units={units} chainId={config.chainId} />
          <DeskNotes feed={feed.data} />

          <section className={`${s.panel} ${s.span7}`} aria-label="Manage" id="manage">
            <div className={s.ph}>
              <div>
                <h2>{view && !creating ? "Manage the credit line" : "Open a credit line"}</h2>
                <p className={s.sub}>Every action is simulated first, then sent from your wallet.</p>
              </div>
              {view && !creating ? (
                <button type="button" className={s.linkBtn} onClick={() => setCreating(true)}>
                  Open another
                </button>
              ) : null}
            </div>
            {!isConnected ? (
              <p className={s.offline}>Connect a wallet to open or manage a credit line.</p>
            ) : !onChain ? (
              <p className={s.offline}>Switch your wallet to {chainName} first.</p>
            ) : !deployment ? (
              <p className={s.offline}>The Ballast contracts are not deployed yet, so nothing can be opened.</p>
            ) : view && !creating && address && sameAddr(view.owner, address) ? (
              <AccountActions key={view.address} view={view} owner={address} onDone={refresh} />
            ) : creating || (body?.status === "ok" && list.length === 0) ? (
              markets.data?.status === "ok" && address ? (
                <CreateAccountForm
                  deployment={deployment}
                  owner={address}
                  deskAgent={deskAgent}
                  markets={markets.data.markets}
                  onCreated={(account) => {
                    setCreating(false);
                    if (account) setSelected(account);
                    refresh();
                  }}
                  onCancel={list.length > 0 ? () => setCreating(false) : undefined}
                />
              ) : markets.data?.status === "unavailable" || markets.isError ? (
                <p className={s.offline}>The markets could not be read right now, so no credit line can be opened.</p>
              ) : (
                <p className={s.offline}>Reading the markets...</p>
              )
            ) : (
              <p className={s.offline}>Reading your accounts...</p>
            )}
          </section>
          <CoversPanel
            deployment={deployment}
            owner={address}
            covers={body?.status === "ok" ? body.covers : null}
            deskAgent={deskAgent}
            enabled={onChain}
            onChanged={refresh}
          />
        </div>

        <div className={s.foot}>
          <span>
            {body?.status === "ok" ? `Loan figures read from ${chainName} at block ${body.blockNumber}. ` : ""}
            The faint stars on the wheel are the real Lista bStock liquidations since June.
          </span>
          <span>{chainName}</span>
        </div>
      </main>
    </div>
  );
}
