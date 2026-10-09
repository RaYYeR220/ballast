"use client";
/* /judge: one recorded cycle, played back on the wheel. Every figure on this page comes from the recording
   (public/replay/cycle.json): real transactions on a fork of BNB Chain, their decoded results and the
   account's state after each. Nothing here needs a wallet or a key. */
import { nextWindow } from "@ballast/risk";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Planisphere, type DialGeometry } from "@/components/planisphere/Planisphere";
import { SKY } from "@/components/planisphere/Wheel";
import { ClockTag, SiteBar, SiteTabs, StatusPill, useNow } from "@/components/oracle/SiteBar";
import { nyDayTime, nyDate, pctBps, shortHex } from "@/lib/format";
import { scanAddress, scanTx } from "@/lib/identity";
import { LIQUIDATIONS } from "@/lib/liquidations";
import { angleOf, hourLabel, polar, r2 } from "@/lib/planisphere/geometry";
import { hourOfWeek } from "@/lib/planisphere/sessions";
import { proofsFor, type Proofs, type Replay, type ReplayStep, type StepKind } from "@/lib/replay";
import a from "@/components/app/app.module.css";
import s from "./judge.module.css";

const STEP_MS = 4200;
const TURN_MS = 900;

const SESSION_TEXT: Record<string, string> = {
  REGULAR: "regular session",
  PRE: "pre-market",
  POST: "after hours",
  OVERNIGHT: "overnight, closed",
  CLOSED_WEEKEND: "weekend, closed",
  CLOSED_HOLIDAY: "holiday, closed",
  UNKNOWN: "outside the calendar",
};
const KIND_TEXT: Record<StepKind, string> = { setup: "On chain", publish: "Publish", open: "Owner", job: "Guardian job", shield: "Shield", refused: "Refused", restore: "Restore", settle: "Settle" };
const RESULT_LABEL: Record<string, string> = {
  sessionOracle: "Session Oracle",
  sessionAwareFeed: "Session-aware feed",
  factory: "Account factory",
  cushionVault: "Cushion vault",
  guardian: "Guardian",
  publisher: "Publisher",
  publisherAgentId: "Publisher's ERC-8004 id",
  restoreDelaySec: "Restore delay",
  maxOverlayTtlSec: "Longest overlay life",
  symbol: "Symbol",
  flags: "Flags",
  validForSec: "Valid for",
  account: "Account",
  collateral: "Collateral",
  borrowed: "Borrowed",
  cushion: "Cushion",
  maxLtvBps: "Mandate: max LTV",
  shieldLtvBps: "Mandate: shield LTV",
  autoRestore: "Keeper may restore",
  route: "Route",
  pathHash: "Route hash",
  jobId: "Job",
  budget: "Escrow",
  windowStart: "Window starts",
  windowEnd: "Window ends",
  expiresAt: "Job expires",
  agentId: "Agent",
  provider: "Provider",
  plan: "Plan",
  window: "Closure ahead",
  gapBps: "Gap sized for",
  targetHfAfterGap: "Health factor kept after the gap",
  repaid: "Repaid from the cushion",
  debtBefore: "Debt before",
  debtAfter: "Debt after",
  collateralSold: "Collateral sold",
  ltvBeforeBps: "LTV before",
  call: "Call",
  reverted: "Reverted",
  cushionAfter: "Cushion after",
  canAddRisk: "Oracle: may risk be added",
  restored: "Borrowed back into the cushion",
  ltvAfterBps: "LTV after",
  deliverable: "Evidence hash",
  survived: "Loan survived",
  paid: "Escrow released to the desk",
  payout: "Paid to the desk",
  reputationValue: "Reputation entry",
  reputationTag: "Reputation tag",
  feedbackWritten: "Written to ERC-8004",
};

function resultValue(key: string, v: string | number | boolean | null): React.ReactNode {
  if (v === null) return "not recorded";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (key.endsWith("Bps")) return key === "gapBps" ? pctBps(v, 2) : pctBps(v);
    if (key.endsWith("Sec")) return `${Math.round(v / 60)} min`;
    if (key === "windowStart" || key === "windowEnd" || key === "expiresAt") return `${nyDayTime(v)} New York, ${nyDate(v)}`;
    return String(v);
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return <a href={scanAddress(v)} target="_blank" rel="noopener noreferrer">{shortHex(v, 6, 4)}</a>;
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return <span title={v}>{shortHex(v, 8, 6)}</span>;
  // enum names from the contracts read as words
  return /^[A-Z_]+$/.test(v) ? v.toLowerCase().replace(/_/g, " ") : v;
}

const Marks = memo(function Marks({ steps, R, upTo }: { steps: readonly ReplayStep[]; R: number; upTo: number }) {
  const r = R * 0.72;
  return (
    <g aria-hidden="true">
      {steps.map((st, i) => {
        if (!["open", "shield", "refused", "restore", "settle"].includes(st.kind) || st.id === "path") return null;
        const deg = angleOf(hourOfWeek(st.at));
        const [x0, y0] = polar(deg, r);
        const x = r2(x0);
        const y = r2(y0);
        const opacity = i <= upTo ? 1 : 0.22;
        const ring = i === upTo ? <circle cx={x} cy={y} r={13} fill="none" stroke={SKY.cream} strokeWidth={1} opacity={0.7} /> : null;
        let mark: React.ReactNode;
        if (st.kind === "shield") mark = <path d={`M${x} ${r2(y - 7)}l7 12h-14z`} fill={SKY.mint} transform={`rotate(${r2(deg)} ${x} ${y})`} />;
        else if (st.kind === "refused") mark = <path d={`M${r2(x - 6)} ${r2(y - 6)}l12 12M${r2(x + 6)} ${r2(y - 6)}l-12 12`} stroke={SKY.ember} strokeWidth={2.5} />;
        else if (st.kind === "restore") mark = <circle cx={x} cy={y} r={5.5} fill="none" stroke={SKY.cream} strokeWidth={2} />;
        else if (st.kind === "settle") mark = <path d={`M${x} ${r2(y - 6)}l6 6l-6 6l-6 -6z`} fill={SKY.mint} />;
        else mark = <circle cx={x} cy={y} r={3.5} fill={SKY.cream} />;
        return (
          <g key={st.id} opacity={opacity}>
            {mark}
            {ring}
          </g>
        );
      })}
    </g>
  );
});

function Proof({ step, proofs }: { step: ReplayStep; proofs: Proofs }) {
  const found = proofsFor(step, proofs);
  return (
    <div className={s.proof}>
      <b>On BNB Chain</b>
      {found.length > 0 ? (
        <ul>
          {found.map((p) => (
            <li key={p.tx}>
              <a href={scanTx(p.tx)} target="_blank" rel="noopener noreferrer">
                {shortHex(p.tx, 8, 6)}
              </a>
              {p.label ? <span> {p.label}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No matching transaction on BNB Chain yet. This step is shown from the fork recording only.</p>
      )}
    </div>
  );
}

function StepDetail({ step, proofs }: { step: ReplayStep; proofs: Proofs }) {
  const acct = step.state.account;
  const st = step.state;
  return (
    <div className={s.detail}>
      <p className={s.summary}>{step.summary}</p>
      {step.error ? (
        <div className={a.slip} role="group" aria-label="The refused call">
          <div className={a.hd}>
            <b>Refused by the contract</b>
            <span className={`${a.tag} ${a.no}`}>Sent on the fork, reverted</span>
          </div>
          <dl>
            <dt>When</dt>
            <dd>
              {nyDayTime(step.at)} New York, {SESSION_TEXT[st.session] ?? st.session.toLowerCase()}
            </dd>
            <dt>Call</dt>
            <dd>{String(step.result.call ?? step.txs[0]?.call ?? "")}</dd>
            <dt>Result</dt>
            <dd>
              <span className={a.rev}>
                Reverted: {step.error.name}
                {step.error.reason ? `(${step.error.reason})` : ""}
              </span>
              <span className={a.ctx}>{step.error.message}</span>
            </dd>
            <dt>Moved</dt>
            <dd>Nothing. Debt {String(step.result.debtBefore)} USD1 before and {String(step.result.debtAfter)} USD1 after.</dd>
          </dl>
        </div>
      ) : null}
      {step.txs.length > 0 ? (
        <div className={s.block}>
          <h4>Transactions on the fork</h4>
          <ul className={s.txs}>
            {step.txs.map((t) => (
              <li key={t.hash}>
                <code title={t.hash}>{shortHex(t.hash, 8, 6)}</code>
                <span>{t.call}</span>
                <span className={`${a.tag} ${t.status === "success" ? a.ok : a.no}`}>{t.status === "success" ? "Mined" : "Reverted"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={s.block}>
          <h4>Transactions on the fork</h4>
          <p className={a.muted}>None: the fork already carries these contracts.</p>
        </div>
      )}
      {!step.error && Object.keys(step.result).length > 0 ? (
        <div className={s.block}>
          <h4>Decoded result</h4>
          <dl className={s.kv}>
            {Object.entries(step.result).map(([k, v]) => (
              <div key={k}>
                <dt>{RESULT_LABEL[k] ?? k}</dt>
                <dd>{resultValue(k, v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      <div className={s.block}>
        <h4>State after this step</h4>
        <dl className={s.kv}>
          <div>
            <dt>New York</dt>
            <dd>{SESSION_TEXT[st.session] ?? st.session.toLowerCase()}</dd>
          </div>
          <div>
            <dt>Oracle: may risk be added</dt>
            <dd>{st.canAddRisk ? "Yes" : `No: ${st.reason.toLowerCase().replace(/_/g, " ")}`}</dd>
          </div>
          <div>
            <dt>Feed band</dt>
            <dd>{st.bandBps === null ? "none, the feed passes the price through" : `plus or minus ${pctBps(st.bandBps)}`}</dd>
          </div>
          {acct ? (
            <>
              <div>
                <dt>Loan to value</dt>
                <dd>{acct.ltvBps === null ? "not priced" : pctBps(acct.ltvBps, 2)}</dd>
              </div>
              <div>
                <dt>Debt</dt>
                <dd>{acct.debt} USD1</dd>
              </div>
              <div>
                <dt>Cushion</dt>
                <dd>{acct.cushion} USD1</dd>
              </div>
              <div>
                <dt>Health after the gap ahead</dt>
                <dd>{acct.hfAfterGap === null ? "not priced" : acct.hfAfterGap.toFixed(3)}</dd>
              </div>
            </>
          ) : null}
          {st.job ? (
            <div>
              <dt>Guardian job {st.job.id}</dt>
              <dd>{st.job.status.toLowerCase()}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      {step.forkOnly?.length ? (
        <div className={s.block}>
          <h4>Only possible on a fork</h4>
          <ul className={s.notes}>
            {step.forkOnly.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={s.block}>
        <h4>Reproduce it</h4>
        <pre className={s.cmd}>
          <code>{step.reproduce.command}</code>
        </pre>
        {step.reproduce.test ? <p className={a.faint}>{step.reproduce.test}</p> : null}
      </div>
      <Proof step={step} proofs={proofs} />
    </div>
  );
}

export function ReplayPage({ replay, proofs, serverNow }: { replay: Replay; proofs: Proofs; serverNow: number }) {
  const steps = replay.steps;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(steps[0]!.at);
  const shownRef = useRef(steps[0]!.at);
  const now = useNow(serverNow);
  const step = steps[index]!;

  // the sky turns to the step's moment; with reduced motion it is simply there
  useEffect(() => {
    const target = step.at;
    const from = shownRef.current;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from === target) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / TURN_MS);
      const v = Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step.at]);

  useEffect(() => {
    if (!playing) return;
    if (index >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex((i) => Math.min(steps.length - 1, i + 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, index, steps.length]);

  const closure = useMemo(() => {
    const shield = steps.find((x) => x.kind === "shield");
    if (!shield) return null;
    const w = nextWindow(shield.at);
    return w.type === "NONE" ? null : { startsAt: w.startsAt, endsAt: w.endsAt };
  }, [steps]);
  const marks = useCallback((geo: DialGeometry) => <Marks steps={steps} R={geo.R} upTo={index} />, [steps, index]);
  const go = (i: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(steps.length - 1, i)));
  };
  const onChain = steps.filter((x) => proofsFor(x, proofs).length > 0).length;

  return (
    <div className={a.shell}>
      <SiteBar current="/judge" right={<StatusPill tone="idle">Recorded on a fork, no wallet needed</StatusPill>} />
      <main className={a.page}>
        <SiteTabs current="/judge" />
        <div className={a.head}>
          <div>
            <h1>Replay: one closure, start to finish</h1>
            <p>
              A loan is opened, shielded before Friday&apos;s close, refused a restore over the weekend, restored on Monday, and its guardian is paid. Recorded on a fork of BSC mainnet at block {replay.fork.block.toLocaleString("en-US")}, against the
              contracts deployed there.
            </p>
          </div>
          <ClockTag now={now} />
        </div>
        <p className={s.label} role="note">
          <span className={`${a.tag} ${a.live}`}>Demo recording</span>
          <span>
            Recorded on a fork of BSC mainnet at block {replay.fork.block.toLocaleString("en-US")} ({nyDate(replay.fork.blockTime)}). {steps.reduce((n, x) => n + x.txs.length, 0)} real fork transactions; {onChain} of {steps.length} steps
            also have a transaction on BNB Chain itself.
          </span>
        </p>
        <div className={a.grid}>
          <section className={`${a.panel} ${a.span5} ${s.stage}`} aria-label="The cycle on the week wheel">
            <div className={a.ph}>
              <div>
                <h2>The wheel</h2>
                <p className={a.sub}>The meridian at the top is the moment of the step. The arc marks the weekend closure the loan crosses.</p>
              </div>
            </div>
            <div className={a.wheelwrap}>
              <Planisphere
                liquidations={LIQUIDATIONS}
                now={shown}
                followNow={false}
                sweep={false}
                window={closure}
                label={`The recorded cycle on the week wheel, at step ${index + 1} of ${steps.length}: ${step.title}`}
                compact
                fontScale={1.15}
                money={false}
                wedges={false}
                starOpacity={0.3}
                marks={marks}
                readoutClassName={a.hideReadout}
              />
              <div className={a.center}>
                <div>
                  <small>
                    Step {index + 1} of {steps.length}
                  </small>
                  <b>{hourLabel(hourOfWeek(step.at)).replace(/^(\w{3})\w*/, "$1")}</b>
                  <small>{SESSION_TEXT[step.state.session] ?? step.state.session.toLowerCase()}</small>
                </div>
              </div>
            </div>
            <div className={s.transport} role="group" aria-label="Playback">
              <button type="button" className={a.btnGhost} onClick={() => go(index - 1)} disabled={index === 0}>
                Previous
              </button>
              <button
                type="button"
                className={a.btn}
                onClick={() => {
                  if (!playing && index >= steps.length - 1) setIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "Pause" : index >= steps.length - 1 ? "Play again" : "Play the cycle"}
              </button>
              <button type="button" className={a.btnGhost} onClick={() => go(index + 1)} disabled={index >= steps.length - 1}>
                Next
              </button>
            </div>
            <div className={a.key}>
              <span>
                <i className={a.kSh} aria-hidden="true" />
                Shield
              </span>
              <span>
                <i className={a.kRf} aria-hidden="true" />
                Refused
              </span>
              <span>
                <i className={a.kRs} aria-hidden="true" />
                Restore
              </span>
              <span>
                <i className={s.kSettle} aria-hidden="true" />
                Job settled
              </span>
            </div>
          </section>
          <section className={`${a.panel} ${a.span7}`} aria-label="Steps">
            <div className={a.ph}>
              <div>
                <h2>The steps</h2>
                <p className={a.sub}>
                  {replay.market.label}, borrower {shortHex(replay.actors.borrower, 6, 4)}, desk agent {replay.actors.agentId}. Times are New York time on the fork&apos;s clock.
                </p>
              </div>
            </div>
            <ol className={s.steps}>
              {steps.map((x, i) => (
                <li key={x.id} data-active={i === index || undefined} data-kind={x.kind}>
                  <button type="button" className={s.stepBtn} aria-expanded={i === index} aria-controls={`step-${x.id}`} onClick={() => go(i)}>
                    <span className={s.n} aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className={s.title}>{x.title}</span>
                    <span className={s.when}>{nyDayTime(x.at)}</span>
                    <span className={`${a.tag} ${x.kind === "refused" ? a.no : x.kind === "shield" || x.kind === "restore" || x.kind === "settle" ? a.ok : ""}`}>{KIND_TEXT[x.kind]}</span>
                  </button>
                  {i === index ? (
                    <div id={`step-${x.id}`}>
                      <StepDetail step={x} proofs={proofs} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
          <section className={`${a.panel} ${a.span12}`} aria-label="What a fork changes">
            <div className={a.ph}>
              <div>
                <h2>What a fork changes, and what it does not</h2>
                <p className={a.sub}>The contracts, the calendar and every rule are the ones on BNB Chain. A fork lets the clock move and stands in for the parties that cannot be present.</p>
              </div>
            </div>
            <ul className={s.notes}>
              {replay.forkOnly.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className={s.rerun}>
              Record it again yourself: start <code>anvil --fork-url &lt;BNB Chain archive RPC&gt; --chain-id 31337 --port 8571 --auto-impersonate</code>, run <code>forge build</code> in <code>contracts</code>, then{" "}
              <code>FORK_RPC=http://127.0.0.1:8571 pnpm tsx scripts/demo/record-replay.ts</code>. The recording this page plays is at{" "}
              <a href="/replay/cycle.json" download>
                /replay/cycle.json
              </a>
              .
            </p>
          </section>
        </div>
        <div className={a.foot}>
          <span>
            Recorded {replay.recordedAt.slice(0, 10)} against {replay.deployment.source}. Session Oracle {shortHex(replay.deployment.sessionOracle, 6, 4)}, guardian {shortHex(replay.deployment.guardian, 6, 4)}.
          </span>
          <span>Ballast</span>
        </div>
      </main>
    </div>
  );
}
