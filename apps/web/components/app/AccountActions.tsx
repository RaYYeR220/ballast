"use client";
/* The owner's actions on one account. Each builds calldata with the SDK, adds an exact approval when one is
   needed, and goes through the simulate-then-send steps. */
import { useState } from "react";
import { keccak256, type Address } from "viem";
import { parseAmount } from "@/lib/amount";
import { mandateProblems } from "@/lib/mandate";
import { deleveragePathFor } from "@/lib/markets";
import { accountSteps, type AccountAction, type TxStep } from "@/lib/steps";
import type { AccountView } from "@/lib/views";
import { toMandate } from "./CreateAccount";
import { fetchToken, useToken } from "./data";
import { AmountField, mandateInputs, MandateFields, type MandateInputs } from "./fields";
import { TxFlow } from "./TxFlow";
import s from "./app.module.css";

interface ActionDef {
  id: AccountAction;
  label: string;
  amount?: "collateral" | "loan";
  help: (v: AccountView) => string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(0)}%`;

const ACTIONS: ActionDef[] = [
  { id: "deposit-collateral", label: "Deposit collateral", amount: "collateral", help: (v) => `Moves ${v.collateralSymbol} from your wallet into the account: an exact approval first, then the deposit.` },
  {
    id: "borrow",
    label: "Borrow",
    amount: "loan",
    help: (v) => `Borrows ${v.loanSymbol} to your wallet. The venue liquidates at ${pct(v.lltvBps)}; the agent's restores stop at your max LTV of ${pct(v.mandate.maxLtvBps)}.`,
  },
  {
    id: "deposit-cushion",
    label: "Add to cushion",
    amount: "loan",
    help: (v) => `The cushion is the ${v.loanSymbol} the agent repays from before a close. An exact approval first, then the deposit.`,
  },
  { id: "withdraw-cushion", label: "Withdraw cushion", amount: "loan", help: () => "Takes cushion back to your wallet. The agent then has less to repay with before the next close." },
  { id: "repay-all", label: "Repay all", help: () => "Repays the whole loan from the cushion. When the cushion is smaller than the debt, add to it first." },
  { id: "withdraw-collateral", label: "Withdraw collateral", amount: "collateral", help: () => "Takes collateral back to your wallet. The venue refuses it when the loan would become unhealthy." },
  { id: "set-mandate", label: "Mandate", help: () => "The limits the contract enforces on you and on the agent." },
  { id: "set-path", label: "Sale route", help: () => "The one PancakeSwap route the keeper may sell collateral through, fixed by you." },
];

export function AccountActions({ view, owner, onDone }: { view: AccountView; owner: Address; onDone: () => void }) {
  const actions = ACTIONS.filter((a) => a.id !== "set-path" || view.venue === "lista");
  const [action, setAction] = useState<AccountAction>("deposit-collateral");
  const [amount, setAmount] = useState("");
  const [mandate, setMandate] = useState<MandateInputs>(() => mandateInputs(view.mandate));
  const [flow, setFlow] = useState<TxStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const def = actions.find((a) => a.id === action) ?? actions[0]!;

  const token = def.amount === "collateral" ? view.collateralToken : def.amount === "loan" ? view.loanToken : null;
  const decimals = def.amount === "collateral" ? view.collateralDecimals : view.loanDecimals;
  const unit = def.amount === "collateral" ? view.collateralSymbol : view.loanSymbol;
  const deposit = action === "deposit-collateral" || action === "deposit-cushion";
  const wallet = useToken(deposit ? token : null, owner, view.address);
  const path = view.venue === "lista" ? deleveragePathFor(view) : null;
  const pathFixed = !!path && !!view.lista && keccak256(path.hex) === view.lista.deleveragePathHash;

  const max =
    action === "withdraw-cushion"
      ? { raw: BigInt(view.cushion), decimals, label: "In the cushion" }
      : action === "withdraw-collateral"
        ? { raw: BigInt(view.collateral), decimals, label: "In the account" }
        : deposit && wallet.data
          ? { raw: BigInt(wallet.data.balance), decimals, label: "In your wallet" }
          : null;

  const m = toMandate(mandate);
  const mandateIssues = action === "set-mandate" ? mandateProblems(m, view.lltvBps, view.venue) : [];

  function choose(id: AccountAction) {
    setAction(id);
    setAmount("");
    setError(null);
  }

  async function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let x: bigint | undefined;
    if (def.amount) {
      const parsed = parseAmount(amount, decimals);
      if (parsed === null) return setError(`Enter an amount of ${unit}, up to ${decimals} decimals.`);
      if (max && parsed > max.raw) return setError(`That is more than ${max.label.toLowerCase()}.`);
      x = parsed;
    }
    if (action === "set-mandate" && mandateIssues.length > 0) return;
    setBusy(true);
    try {
      let allowance: bigint | undefined;
      if (deposit && token && x !== undefined) {
        const t = await fetchToken(token, owner, view.address);
        if (BigInt(t.balance) < x) throw new Error(`Your wallet holds ${t.balance === "0" ? "no" : "less"} ${unit} than that.`);
        allowance = BigInt(t.allowance ?? "0");
      }
      setFlow(accountSteps(view, { action, owner, amount: x, allowance, mandate: m, path: path ?? undefined }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (flow) {
    return (
      <TxFlow
        steps={flow}
        from={owner}
        onComplete={() => onDone()}
        onCancel={() => {
          setFlow(null);
          onDone();
        }}
        cancelLabel="Back to the actions"
        onClose={() => {
          setFlow(null);
          setAmount("");
        }}
        closeLabel="Back to the actions"
      />
    );
  }

  const blocked = action === "set-path" && (!path || pathFixed);
  return (
    <form className={s.form} onSubmit={review} aria-label={def.label}>
      <div className={s.actionsBar} role="group" aria-label="Action">
        {actions.map((a) => (
          <button key={a.id} type="button" aria-pressed={a.id === action} onClick={() => choose(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      <p className={s.muted}>{def.help(view)}</p>
      {def.amount ? <AmountField label="Amount" value={amount} onChange={setAmount} unit={unit} max={max} /> : null}
      {action === "set-mandate" ? <MandateFields value={mandate} onChange={setMandate} /> : null}
      {action === "set-path" ? (
        <p className={s.keeper}>
          {path ? (pathFixed ? `Fixed: ${path.label}.` : `From the configuration: ${path.label}.`) : "No PancakeSwap route is configured for this collateral. The agent can only repay from the cushion."}
        </p>
      ) : null}
      {action === "repay-all" && BigInt(view.cushion) < BigInt(view.debt) ? (
        <p className={s.problems}>The cushion holds less than the debt, so a full repay will be refused. Add to the cushion first.</p>
      ) : null}
      {mandateIssues.length > 0 ? (
        <ul className={s.problems}>
          {mandateIssues.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className={s.problems} role="alert">
          {error}
        </p>
      ) : null}
      <div className={s.formFoot}>
        <p>A simulation runs first. Nothing is sent until it passes and you confirm in your wallet.</p>
        <button type="submit" className={s.btn} disabled={busy || blocked || mandateIssues.length > 0}>
          {busy ? "Preparing..." : "Review and simulate"}
        </button>
      </div>
    </form>
  );
}
