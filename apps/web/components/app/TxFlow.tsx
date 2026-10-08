"use client";
/* One or more transactions sent in order. Each step is simulated first (/api/simulate); a refusal stops there
   and shows the decoded error; only a passing simulation can be sent from the wallet. Approvals are steps of
   their own, so the next step is simulated only after the approval is on chain. */
import type { TxRequest } from "@ballast/sdk";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Address, Hex, Log } from "viem";
import { txUrl } from "@/lib/app-config";
import { shortHex } from "@/lib/format";
import { SIMULATOR_NAME, type SimResult } from "@/lib/sim";
import type { TxStep } from "@/lib/steps";
import { RefusalCard } from "./RefusalCard";
import s from "./app.module.css";

export interface TxReceiptLite {
  hash: Hex;
  status: "success" | "reverted";
  logs: readonly Log[];
}

export interface TxRunner {
  chainId: number;
  simulate(tx: TxRequest, from: Address): Promise<SimResult>;
  send(tx: TxRequest): Promise<Hex>;
  wait(hash: Hex): Promise<TxReceiptLite>;
}

export type { TxStep };

export const TxRunnerContext = createContext<TxRunner | null>(null);

type Phase =
  | { kind: "simulating" }
  | { kind: "sim-error"; message: string }
  | { kind: "refused"; sim: SimResult; at: number }
  | { kind: "ready"; sim: SimResult }
  | { kind: "signing"; sim: SimResult }
  | { kind: "confirming"; sim: SimResult; hash: Hex }
  | { kind: "reverted"; hash: Hex; at: number }
  | { kind: "send-error"; sim: SimResult; message: string }
  | { kind: "done" };

function walletMessage(err: unknown): string {
  const e = err as { name?: string; shortMessage?: string; message?: string; cause?: { name?: string } };
  if (e?.name === "UserRejectedRequestError" || e?.cause?.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(e?.message ?? "")) {
    return "You declined the request in your wallet.";
  }
  return e?.shortMessage ?? e?.message ?? String(err);
}

export interface TxFlowProps {
  steps: TxStep[];
  from: Address;
  onComplete?: (receipts: TxReceiptLite[]) => void;
  onCancel?: () => void;
  /** label of the cancel button */
  cancelLabel?: string;
  /** shown once every step is confirmed, to leave the finished flow */
  onClose?: () => void;
  closeLabel?: string;
}

export function TxFlow({ steps, from, onComplete, onCancel, cancelLabel = "Back to the form", onClose, closeLabel = "Close" }: TxFlowProps) {
  const runner = useContext(TxRunnerContext);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "simulating" });
  const receipts = useRef<TxReceiptLite[]>([]);
  const started = useRef(false);
  const alive = useRef(true);

  async function simulate(i: number) {
    const step = steps[i];
    if (!runner || !step) return;
    setIndex(i);
    setPhase({ kind: "simulating" });
    try {
      const sim = await runner.simulate(step.tx, from);
      if (!alive.current) return;
      setPhase(sim.ok ? { kind: "ready", sim } : { kind: "refused", sim, at: Math.floor(Date.now() / 1000) });
    } catch (err) {
      if (alive.current) setPhase({ kind: "sim-error", message: (err as Error).message });
    }
  }

  async function send(sim: SimResult) {
    const step = steps[index];
    if (!runner || !step) return;
    setPhase({ kind: "signing", sim });
    let hash: Hex;
    try {
      hash = await runner.send(step.tx);
    } catch (err) {
      if (alive.current) setPhase({ kind: "send-error", sim, message: walletMessage(err) });
      return;
    }
    if (!alive.current) return;
    setPhase({ kind: "confirming", sim, hash });
    let receipt: TxReceiptLite;
    try {
      receipt = await runner.wait(hash);
    } catch (err) {
      if (alive.current) setPhase({ kind: "send-error", sim, message: `Sent as ${shortHex(hash)}, but no receipt arrived: ${walletMessage(err)}` });
      return;
    }
    if (!alive.current) return;
    if (receipt.status !== "success") {
      setPhase({ kind: "reverted", hash, at: Math.floor(Date.now() / 1000) });
      return;
    }
    receipts.current = [...receipts.current, receipt];
    if (index + 1 < steps.length) {
      await simulate(index + 1);
      return;
    }
    setPhase({ kind: "done" });
    onComplete?.(receipts.current);
  }

  // the first step is checked as soon as the flow opens
  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      void simulate(0);
    }
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!runner) return <p className={s.muted}>Connect a wallet to send transactions.</p>;
  const chainId = runner.chainId;
  const link = (h: string) => {
    const url = txUrl(chainId, h);
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {shortHex(h)}
      </a>
    ) : (
      <span>{shortHex(h)} (local fork)</span>
    );
  };
  const current = steps[index];
  const cancel = onCancel ? (
    <button type="button" className={s.btnGhost} onClick={onCancel}>
      {cancelLabel}
    </button>
  ) : null;

  return (
    <ol className={s.steps} aria-label="Transaction steps">
      {steps.map((st, i) => {
        const state = phase.kind === "done" || i < index ? "done" : i === index ? (phase.kind === "refused" || phase.kind === "reverted" ? "failed" : "current") : "pending";
        const done = receipts.current[i];
        return (
          <li key={st.key} className={s.step} data-state={state}>
            <span className={s.n} aria-hidden="true">
              {state === "done" ? "\u2713" : i + 1}
            </span>
            <div>
              <b>{st.title}</b>
              {st.detail ? <p className={s.detail}>{st.detail}</p> : null}
              {done ? <p className={s.detail}>Confirmed in {link(done.hash)}</p> : null}
              {i === index && phase.kind !== "done" && current ? (
                <div className={s.stepStatus} aria-live="polite">
                  {phase.kind === "simulating" && <p className={s.muted}>Checking {current.call} with a simulation...</p>}
                  {phase.kind === "sim-error" && (
                    <>
                      <p className={s.muted}>The simulator did not answer: {phase.message}. Nothing was sent.</p>
                      <div className={s.stepButtons}>
                        <button type="button" className={s.btnGhost} onClick={() => void simulate(index)}>
                          Simulate again
                        </button>
                        {cancel}
                      </div>
                    </>
                  )}
                  {phase.kind === "refused" && (
                    <RefusalCard
                      call={current.call}
                      at={phase.at}
                      sim={phase.sim}
                      actions={
                        <>
                          <span>Change the inputs, or wait for the condition the contract names.</span>
                          <span className={s.stepButtons}>
                            <button type="button" className={s.btnGhost} onClick={() => void simulate(index)}>
                              Simulate again
                            </button>
                            {cancel}
                          </span>
                        </>
                      }
                    />
                  )}
                  {(phase.kind === "ready" || phase.kind === "send-error") && (
                    <>
                      <p className={s.simOk}>
                        <b>Simulation passed</b>, checked by {phase.sim.via === "binance" ? "the " : ""}
                        {SIMULATOR_NAME[phase.sim.via]}.{phase.sim.note ? ` ${phase.sim.note}.` : ""}
                      </p>
                      {phase.kind === "send-error" && <p className={s.muted}>{phase.message}</p>}
                      <div className={s.stepButtons}>
                        <button type="button" className={s.btn} onClick={() => void send(phase.sim)}>
                          Send from wallet
                        </button>
                        {cancel}
                      </div>
                    </>
                  )}
                  {phase.kind === "signing" && <p className={s.muted}>Confirm the transaction in your wallet.</p>}
                  {phase.kind === "confirming" && <p className={s.muted}>Sent as {link(phase.hash)}. Waiting for BNB Chain to include it...</p>}
                  {phase.kind === "reverted" && (
                    <RefusalCard
                      call={current.call}
                      at={phase.at}
                      sim={{ via: "rpc", ok: false, error: { name: "Reverted", message: "the transaction reverted when it was mined (state changed after the simulation)" } }}
                      sent={{ hash: phase.hash, url: txUrl(chainId, phase.hash) }}
                      actions={
                        <>
                          <span>Check the state again before retrying.</span>
                          {cancel}
                        </>
                      }
                    />
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
      {phase.kind === "done" ? (
        <li className={s.simOk} aria-live="polite">
          <b>Done.</b> {steps.length === 1 ? "The transaction is confirmed." : `All ${steps.length} transactions are confirmed.`}
          {onClose ? (
            <div className={s.stepButtons} style={{ marginTop: 10 }}>
              <button type="button" className={s.btnGhost} onClick={onClose}>
                {closeLabel}
              </button>
            </div>
          ) : null}
        </li>
      ) : null}
    </ol>
  );
}
