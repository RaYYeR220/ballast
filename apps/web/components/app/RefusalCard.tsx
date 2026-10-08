/* The v09 refusal slip: what was called, what the contract answered, who checked it and what it cost. */
import type { ReactNode } from "react";
import { nyDayTime } from "@/lib/format";
import { SIMULATOR_NAME, type SimError, type SimResult } from "@/lib/sim";
import s from "./app.module.css";

/** "RestoreRefused(NOT_REGULAR)", "ExceedsMandate(6230, 6000)" */
export function errorSignature(e: SimError): string {
  if (e.reason) return `${e.name}(${e.reason})`;
  return e.args && e.args.length > 0 ? `${e.name}(${e.args.join(", ")})` : e.name;
}

export interface RefusalCardProps {
  call: string;
  /** unix seconds of the check */
  at: number;
  sim: SimResult;
  /** set when the transaction was sent and reverted on chain */
  sent?: { hash: string; url: string | null };
  actions?: ReactNode;
}

export function RefusalCard({ call, at, sim, sent, actions }: RefusalCardProps) {
  const err = sim.error ?? { name: "Reverted", message: "the call reverted" };
  // require(..., "text") in a venue or token contract: the text is the whole story
  const plain = err.name === "Error" && !sent;
  return (
    <div className={s.slip} role="group" aria-label={`Refused: ${call}`}>
      <div className={s.hd}>
        <b>{sent ? "Reverted on chain" : "Refused by the contract"}</b>
        <span className={`${s.tag} ${s.no}`}>{sent ? "Sent, reverted" : "Simulated, not sent"}</span>
      </div>
      <dl>
        <dt>When</dt>
        <dd>{nyDayTime(at)} New York</dd>
        <dt>Call</dt>
        <dd>{call}</dd>
        <dt>Result</dt>
        <dd>
          {plain ? (
            <>
              <span className={s.rev}>Reverted: {err.message}</span>
              <span className={s.ctx}>A revert from the venue or a token, not from a Ballast rule.</span>
            </>
          ) : (
            <>
              <span className={s.rev}>Reverted: {errorSignature(err)}</span>
              <span className={s.ctx}>{err.message}</span>
            </>
          )}
        </dd>
        <dt>Checked by</dt>
        <dd>
          {sent ? "BNB Chain" : SIMULATOR_NAME[sim.via]}
          {sim.note ? <span className={s.ctx}>{sim.note}</span> : null}
        </dd>
        <dt>Cost</dt>
        <dd>
          {sent ? (
            sent.url ? (
              <a href={sent.url} target="_blank" rel="noopener noreferrer">
                Gas was spent, see the transaction
              </a>
            ) : (
              <>Gas was spent (transaction {sent.hash})</>
            )
          ) : (
            "Nothing was sent, so no gas was spent."
          )}
        </dd>
      </dl>
      {actions ? <div className={s.ft}>{actions}</div> : null}
    </div>
  );
}
