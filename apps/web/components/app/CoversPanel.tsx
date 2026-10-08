"use client";
/* Cushion covers: protection for a Lista or Venus loan that stays on your own address. You park stablecoins in
   the CushionVault; the desk agent may spend them only to repay that loan, only around a closure, at most the
   daily cap. Open, top up or withdraw here. */
import type { Deployment } from "@ballast/sdk";
import { useState } from "react";
import type { Address } from "viem";
import { parseAmount } from "@/lib/amount";
import { sameAddr } from "@/lib/desk";
import { pctBps, shortHex, units } from "@/lib/format";
import { openCoverSteps, topUpCoverSteps, withdrawCoverSteps, type TxStep } from "@/lib/steps";
import type { CoverView, LoanView } from "@/lib/views";
import { fetchToken, useLoans } from "./data";
import { AmountField } from "./fields";
import { TxFlow } from "./TxFlow";
import s from "./app.module.css";

type Form =
  | { kind: "open"; loan: LoanView }
  | { kind: "top-up"; cover: CoverView }
  | { kind: "withdraw"; cover: CoverView };

function CoverForm(p: { form: Form; deployment: Deployment; owner: Address; deskAgent: Address | null; onClose: () => void; onChanged: () => void }) {
  const { form, deployment, owner, deskAgent, onClose } = p;
  const [amount, setAmount] = useState("");
  const [cap, setCap] = useState("");
  const [flow, setFlow] = useState<TxStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decimals = form.kind === "open" ? form.loan.loanDecimals : form.cover.tokenDecimals;
  const unit = form.kind === "open" ? form.loan.loanSymbol : form.cover.tokenSymbol;
  const token = form.kind === "open" ? form.loan.loanToken : form.cover.token;

  async function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const x = parseAmount(amount, decimals);
    if (x === null) return setError(`Enter an amount of ${unit}.`);
    setBusy(true);
    try {
      if (form.kind === "withdraw") {
        if (x > BigInt(form.cover.balance)) throw new Error("That is more than the cover holds.");
        setFlow(withdrawCoverSteps(deployment, form.cover, x, owner));
        return;
      }
      const t = await fetchToken(token, owner, deployment.cushionVault);
      if (BigInt(t.balance) < x) throw new Error(`Your wallet holds less ${unit} than that.`);
      const allowance = BigInt(t.allowance ?? "0");
      if (form.kind === "top-up") {
        setFlow(topUpCoverSteps(deployment, form.cover, x, allowance));
        return;
      }
      if (!deskAgent) throw new Error("No desk agent address is known, so the cover has no keeper to name.");
      const capPerDay = cap.trim() === "" ? x : parseAmount(cap, decimals);
      if (capPerDay === null) throw new Error("Enter a daily cap, or leave it empty to use the amount.");
      setFlow(openCoverSteps(deployment, form.loan, { keeper: deskAgent, amount: x, capPerDay, allowance }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (flow) return <TxFlow steps={flow} from={owner} onComplete={p.onChanged} onCancel={() => setFlow(null)} onClose={onClose} closeLabel="Back to the covers" />;
  const title = form.kind === "open" ? `Cover your ${form.loan.label} loan` : form.kind === "top-up" ? `Top up the ${form.cover.label} cover` : `Withdraw from the ${form.cover.label} cover`;
  return (
    <form className={s.form} onSubmit={review} aria-label={title}>
      <h3>{title}</h3>
      <AmountField
        label={form.kind === "withdraw" ? "Amount to withdraw" : "Amount to park in the vault"}
        value={amount}
        onChange={setAmount}
        unit={unit}
        max={form.kind === "withdraw" ? { raw: BigInt(form.cover.balance), decimals, label: "In the cover" } : null}
      />
      {form.kind === "open" ? (
        <AmountField
          label="Daily cap"
          value={cap}
          onChange={setCap}
          unit={unit}
          help="The most the agent may repay from the cover in one day. Empty means the whole amount."
        />
      ) : null}
      {error ? (
        <p className={s.problems} role="alert">
          {error}
        </p>
      ) : null}
      <div className={s.formFoot}>
        <p>A simulation runs first. Nothing is sent until it passes and you confirm in your wallet.</p>
        <span className={s.stepButtons}>
          <button type="button" className={s.btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={s.btn} disabled={busy}>
            {busy ? "Preparing..." : "Review and simulate"}
          </button>
        </span>
      </div>
    </form>
  );
}

export function CoversPanel(p: {
  deployment: Deployment | null;
  owner: Address | undefined;
  covers: CoverView[] | null;
  deskAgent: Address | null;
  enabled: boolean;
  onChanged: () => void;
}) {
  const loans = useLoans(p.owner, p.enabled && !!p.deployment);
  const [form, setForm] = useState<Form | null>(null);
  const covered = new Set((p.covers ?? []).map((c) => c.key.toLowerCase()));
  const body = loans.data;
  const open = body?.status === "ok" ? body.loans.filter((l) => !covered.has(l.key.toLowerCase())) : [];
  const defi = body && "defi" in body ? body.defi : undefined;

  return (
    <section className={`${s.panel} ${s.span5}`} aria-label="Cushion covers" id="covers">
      <div className={s.ph}>
        <div>
          <h2>Cushion covers</h2>
          <p className={s.sub}>Protection for a loan that stays on your own address.</p>
        </div>
      </div>
      {!p.enabled || !p.owner ? (
        <p className={s.offline}>Connect a wallet to see your covers and the loans they can protect.</p>
      ) : !p.deployment ? (
        <p className={s.offline}>The cushion vault is not deployed yet, so no cover can be opened.</p>
      ) : form ? (
        <CoverForm
          form={form}
          deployment={p.deployment}
          owner={p.owner}
          deskAgent={p.deskAgent}
          onClose={() => setForm(null)}
          onChanged={() => {
            p.onChanged();
            void loans.refetch();
          }}
        />
      ) : (
        <>
          {p.covers && p.covers.length > 0 ? (
            <ul className={s.coverList}>
              {p.covers.map((c) => (
                <li key={c.key}>
                  <div>
                    <b>{c.label}</b>
                    <span className={s.muted}>
                      {units(c.balance, c.tokenDecimals)} {c.tokenSymbol} held
                    </span>
                  </div>
                  <div>
                    <span className={s.faint}>
                      cap {units(c.capPerDay, c.tokenDecimals)} a day, used {units(c.usedToday, c.tokenDecimals)} today, keeper{" "}
                      {sameAddr(c.keeper, p.deskAgent) ? "Ballast desk" : shortHex(c.keeper)}
                    </span>
                    <span className={s.stepButtons}>
                      <button type="button" className={s.linkBtn} onClick={() => setForm({ kind: "top-up", cover: c })}>
                        Top up
                      </button>
                      <button type="button" className={s.linkBtn} onClick={() => setForm({ kind: "withdraw", cover: c })}>
                        Withdraw
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>No cover is open for this wallet.</p>
          )}
          <h3 style={{ marginTop: 16 }}>Loans you can cover</h3>
          {loans.isLoading ? <p className={s.offline}>Looking for your loans on Lista and Venus...</p> : null}
          {body && body.status !== "ok" ? <p className={s.offline}>Your loans could not be read: {body.detail}.</p> : null}
          {loans.isError ? <p className={s.offline}>Your loans could not be read: {(loans.error as Error).message}.</p> : null}
          {body?.status === "ok" && open.length === 0 ? (
            <p className={s.offline}>No uncovered loan on the configured Lista markets or on Venus for this address.</p>
          ) : null}
          {open.length > 0 ? (
            <ul className={s.coverList}>
              {open.map((l) => (
                <li key={`${l.key}-${l.collateralSymbol}`}>
                  <div>
                    <b>{l.label}</b>
                    <button type="button" className={s.linkBtn} onClick={() => setForm({ kind: "open", loan: l })}>
                      Cover this loan
                    </button>
                  </div>
                  <span className={s.faint}>
                    {units(l.debt, l.loanDecimals)} {l.loanSymbol} borrowed against {units(l.collateral, l.collateralDecimals, 4)} {l.collateralSymbol}
                    {l.ltvBps !== null ? `, ${pctBps(l.ltvBps)} loan to value` : ""}
                    {l.lltvBps !== null ? `, liquidation at ${pctBps(l.lltvBps, 0)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {defi?.status === "ok" ? (
            <p className={s.hint}>
              The Binance DeFi API sees {defi.protocols.length === 0 ? "no DeFi positions" : `positions on ${defi.protocols.map((x) => x.id).join(", ")}`} for this address.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
