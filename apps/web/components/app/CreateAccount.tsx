"use client";
/* Open a credit line: venue and market from config, the desk agent as keeper, a mandate with sane defaults.
   For Lista, fixing the deleverage route follows as a second, explicit transaction. */
import { ballastFactoryAbi, type Deployment, type Mandate } from "@ballast/sdk";
import { useId, useState } from "react";
import { parseEventLogs, type Address } from "viem";
import { defaultMandate, mandateProblems, pctToBps } from "@/lib/mandate";
import { createAccountStep, deleveragePathStep, type TxStep } from "@/lib/steps";
import type { MarketView } from "@/lib/views";
import { mandateInputs, MandateFields, type MandateInputs } from "./fields";
import { TxFlow, type TxReceiptLite } from "./TxFlow";
import s from "./app.module.css";

export function toMandate(m: MandateInputs): Mandate {
  return { maxLtvBps: pctToBps(m.maxLtv), shieldLtvBps: pctToBps(m.shieldLtv), maxSlippageBps: pctToBps(m.slippage), autoRestore: m.autoRestore };
}

export function createdAccount(receipts: readonly TxReceiptLite[]): Address | null {
  for (const r of receipts) {
    const ev = parseEventLogs({ abi: ballastFactoryAbi, eventName: "AccountCreated", logs: [...r.logs] });
    if (ev[0]) return ev[0].args.account;
  }
  return null;
}

export interface CreateAccountFormProps {
  deployment: Deployment;
  owner: Address;
  deskAgent: Address | null;
  markets: MarketView[];
  onCreated?: (account: Address | null) => void;
  onCancel?: () => void;
}

export function CreateAccountForm({ deployment, owner, deskAgent, markets, onCreated, onCancel }: CreateAccountFormProps) {
  const usable = markets.filter((m) => !m.error && m.lltvBps !== null && (m.venue === "venus" || m.marketParams));
  const [marketId, setMarketId] = useState(usable[0]?.id ?? "");
  const market = usable.find((m) => m.id === marketId) ?? null;
  const [mandate, setMandate] = useState<MandateInputs>(() => mandateInputs(defaultMandate(usable[0]?.lltvBps ?? 7500)));
  const [flow, setFlow] = useState<{ steps: TxStep[]; phase: "create" | "path" } | null>(null);
  const [created, setCreated] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();

  const m = toMandate(mandate);
  const problems = market ? mandateProblems(m, market.lltvBps, market.venue) : [];
  if (!deskAgent) problems.push("The address of the desk agent is not known right now, so there is no keeper to name. Try again when the desk is back.");

  function chooseMarket(id: string) {
    setMarketId(id);
    const next = usable.find((x) => x.id === id);
    if (next?.lltvBps) setMandate(mandateInputs(defaultMandate(next.lltvBps)));
  }

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!market || !deskAgent || problems.length > 0) return;
    try {
      setFlow({ steps: [createAccountStep(deployment, market, deskAgent, m)], phase: "create" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function afterCreate(receipts: TxReceiptLite[]) {
    const account = createdAccount(receipts);
    setCreated(account);
    if (account && market?.venue === "lista" && market.path) {
      setFlow({ steps: [deleveragePathStep(account, market.path)], phase: "path" });
      return;
    }
    onCreated?.(account);
  }

  if (usable.length === 0) {
    return <p className={s.muted}>No market can be read right now, so no credit line can be opened. Try again shortly.</p>;
  }

  if (flow) {
    return (
      <div className={s.form}>
        {flow.phase === "path" ? (
          <p className={s.muted}>
            Your account is open{created ? ` at ${created}` : ""}. Second step: fix the route the keeper may sell collateral through. Without it, the agent can only repay from the
            cushion.
          </p>
        ) : null}
        <TxFlow
          key={flow.phase}
          steps={flow.steps}
          from={owner}
          onComplete={flow.phase === "create" ? afterCreate : () => onCreated?.(created)}
          onCancel={flow.phase === "create" ? () => setFlow(null) : () => onCreated?.(created)}
          cancelLabel={flow.phase === "create" ? "Back to the form" : "Skip for now"}
        />
      </div>
    );
  }

  return (
    <form className={s.form} onSubmit={review} aria-label="Open a credit line">
      <div className={s.fields}>
        <div className={s.field}>
          <label htmlFor={selectId}>Market</label>
          <select id={selectId} value={marketId} onChange={(e) => chooseMarket(e.target.value)}>
            {usable.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}, liquidation at {((x.lltvBps ?? 0) / 100).toFixed(0)}%
              </option>
            ))}
          </select>
          <span className={s.help}>
            {market?.venue === "lista"
              ? market.path
                ? `Lista. After opening, the sale route is fixed in a second step: ${market.path.label}.`
                : "Lista. No PancakeSwap route is configured for this collateral, so the agent can only repay from the cushion."
              : "Venus. The agent shields by repaying from the cushion."}
          </span>
        </div>
        <div className={s.field}>
          <span className={s.lbl}>Keeper</span>
          <div className={s.keeper}>{deskAgent ? `The Ballast desk agent, ${deskAgent}` : "unknown"}</div>
          <span className={s.help}>The keeper may only reduce risk while New York is closed. The contract refuses anything else.</span>
        </div>
      </div>
      <MandateFields value={mandate} onChange={setMandate} />
      {problems.length > 0 ? (
        <ul className={s.problems} aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className={s.problems}>{error}</p> : null}
      <div className={s.formFoot}>
        <p>Next you see a simulation of the transaction. Nothing is sent until it passes and you confirm in your wallet.</p>
        <span className={s.stepButtons}>
          {onCancel ? (
            <button type="button" className={s.btnGhost} onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className={s.btn} disabled={!market || problems.length > 0}>
            Review and simulate
          </button>
        </span>
      </div>
    </form>
  );
}
