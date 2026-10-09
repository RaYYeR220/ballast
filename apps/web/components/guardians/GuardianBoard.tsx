"use client";
/* /guardians: ERC-8183 jobs guarded by the Ballast guardian contract, read from BNB Chain, and the desk's
   ERC-8004 identity and record. With no jobs the board says so; nothing is listed that is not on chain. */
import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useMemo, useState } from "react";
import type { Address } from "viem";
import { Wheel } from "@/components/planisphere/Wheel";
import { ClockTag, SiteBar, SiteTabs, StatusPill, useJson, useNow } from "@/components/oracle/SiteBar";
import type { AppConfig } from "@/lib/app-config";
import { nyDayTime, shortHex } from "@/lib/format";
import { boardTotals, budgetText, jobState, type GuardiansBody, type JobTone, type JobView, type ReputationView } from "@/lib/guardians";
import { DESK_ADDRESS, DESK_AGENT_ID, identityUrl, scanAddress, type IdentityView } from "@/lib/identity";
import { LIQUIDATIONS } from "@/lib/liquidations";
import { angleOf, polar, r2, rotationFor } from "@/lib/planisphere/geometry";
import { hourOfWeek, mondayOf, tsOfHour, weekSectors } from "@/lib/planisphere/sessions";
import a from "@/components/app/app.module.css";
import s from "./guardians.module.css";

/* the hiring form brings the wallet stack with it: fetched only when someone opens it */
const Hire = dynamic(() => import("./Hire"), { ssr: false, loading: () => <p className={a.muted}>Loading the hiring form.</p> });

const TONE: Record<JobTone, string> = { live: a.live ?? "", ok: a.ok ?? "", no: a.no ?? "", idle: "" };
const ARC: Record<JobTone, { color: string; opacity: number }> = { live: { color: "#3ef0b5", opacity: 1 }, ok: { color: "#3ef0b5", opacity: 0.45 }, no: { color: "#ff9f80", opacity: 1 }, idle: { color: "#bac7df", opacity: 0.9 } };
const WEEK_SEC = 7 * 86_400;

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A guardian's seal: its id inside a ring of ticks, mint for windows survived and ember for the rest. */
export function Seal({ id, rate }: { id: string; rate: number | null }) {
  const n = 42;
  const ok = rate === null ? 0 : Math.round(rate * n);
  return (
    <svg viewBox="0 0 84 84" className={s.seal} aria-hidden="true">
      <circle cx={42} cy={42} r={40} fill="none" stroke="#d8ccab" strokeWidth={1.5} />
      <circle cx={42} cy={42} r={32} fill="#12244a" />
      {Array.from({ length: n }, (_, i) => {
        const t = (i / n) * Math.PI * 2 - Math.PI / 2;
        return <line key={i} x1={r2(42 + Math.cos(t) * 34)} y1={r2(42 + Math.sin(t) * 34)} x2={r2(42 + Math.cos(t) * 39)} y2={r2(42 + Math.sin(t) * 39)} stroke={rate === null ? "#3d5a94" : i < ok ? "#3ef0b5" : "#ff9f80"} strokeWidth={2.2} />;
      })}
      <text className="f-display" x={42} y={id.length > 4 ? 47 : 50} textAnchor="middle" fontSize={id.length > 4 ? 15 : 24} fontWeight={600} fill="#f3ecd9">
        {id}
      </text>
    </svg>
  );
}

const StaticWheel = memo(Wheel);

function arcPath(h0: number, h1: number, r: number): string {
  const [x0, y0] = polar(angleOf(h0), r);
  const [x1, y1] = polar(angleOf(h1), r);
  return `M${r2(x0)} ${r2(y0)}A${r} ${r} 0 ${angleOf(h1) - angleOf(h0) > 180 ? 1 : 0} 1 ${r2(x1)} ${r2(y1)}`;
}

function WindowsWheel({ jobs, now }: { jobs: readonly JobView[]; now: number }) {
  const week = useMemo(() => weekSectors(now), [now]);
  const monday = mondayOf(now);
  const from = tsOfHour(monday, 0);
  const arcs = jobs
    .filter((j) => j.terms && j.terms.end > from && j.terms.start < from + WEEK_SEC)
    .slice(0, 24)
    .map((j, i) => {
      const t = j.terms!;
      const h0 = Math.max(0, (t.start - from) / 3600);
      const h1 = Math.min(167.9, (t.end - from) / 3600);
      const tone = ARC[jobState(j, now).tone];
      return <path key={j.id} d={arcPath(h0, Math.max(h0 + 0.5, h1), 150 + 18 + (i % 3) * 9)} fill="none" stroke={tone.color} strokeWidth={5} strokeLinecap="round" opacity={tone.opacity} />;
    });
  return (
    <section className={`${a.panel} ${s.span4}`} aria-label="Job windows on the wheel">
      <div className={a.ph}>
        <div>
          <h2>This week&apos;s windows</h2>
          <p className={a.sub}>Each arc is one job, drawn over the hours it covers.</p>
        </div>
      </div>
      <svg className={s.jobwheel} viewBox="0 0 440 440" role="img" aria-label={arcs.length ? `Week wheel with ${arcs.length} guardian job ${arcs.length === 1 ? "window" : "windows"} drawn outside the rim.` : "Week wheel. No guardian job covers any hour of this week."}>
        <StaticWheel id="gw" cx={220} cy={220} R={150} rotation={rotationFor(hourOfWeek(now))} sectors={week.sectors} liquidations={LIQUIDATIONS} compact money={false} wedges={false} fontScale={1.1} starOpacity={0.25}>
          {arcs}
        </StaticWheel>
        <line x1={220} x2={220} y1={220 - 150 - 46} y2={220 - 150 * 0.6} stroke="#3ef0b5" strokeWidth={1.5} />
      </svg>
      {arcs.length === 0 ? <p className={s.wheelNote}>No job window falls in this week.</p> : null}
    </section>
  );
}

function Kpis({ body, now }: { body: GuardiansBody | null; now: number }) {
  const jobs = body?.status === "ok" ? body.jobs : [];
  const t = boardTotals(jobs, now);
  const why = body === null ? "reading BNB Chain" : body.status === "not-deployed" ? "the guardian is not deployed yet" : body.status === "unavailable" ? "the chain read failed" : jobs.length === 0 ? "no job has been posted yet" : null;
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="Summary">
      <div className={s.kpis}>
        <div className={s.kpi}>
          <small>Jobs in a window now</small>
          <b>{why && body?.status !== "ok" ? "n/a" : t.inWindow}</b>
          <span>{why ?? `${jobs.length} guardian ${jobs.length === 1 ? "job" : "jobs"} found on the kernel`}</span>
        </div>
        <div className={s.kpi}>
          <small>Held in escrow</small>
          <b>{why && body?.status !== "ok" ? "n/a" : t.held.length ? t.held.map((h) => `${h.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${h.symbol}`).join(", ") : "0"}</b>
          <span>released to the guardian only if the loan survives</span>
        </div>
        <div className={s.kpi}>
          <small>Loans that survived their window</small>
          <b>{why && body?.status !== "ok" ? "n/a" : `${t.survived} of ${t.settled}`}</b>
          <span>{t.settled ? "of the jobs settled so far" : (why ?? "no job has settled yet")}</span>
        </div>
        <div className={s.kpi}>
          <small>Fees refunded to borrowers</small>
          <b>{why && body?.status !== "ok" ? "n/a" : `${t.refunded} ${t.refunded === 1 ? "job" : "jobs"}`}</b>
          <span>a liquidated loan sends the fee back</span>
        </div>
      </div>
    </section>
  );
}

function Jobs({ body, now }: { body: GuardiansBody | null; now: number }) {
  const jobs = body?.status === "ok" ? body.jobs : [];
  return (
    <section className={`${a.panel} ${s.span8}`} aria-label="Jobs">
      <div className={a.ph}>
        <div>
          <h2>Jobs</h2>
          <p className={a.sub}>Each job covers one loan for one window. When it ends, the guardian contract checks the loan and settles the escrow.</p>
        </div>
        {body?.status === "ok" ? <span className={`${a.tag} ${a.live}`}>Block {Number(body.blockNumber).toLocaleString("en-US")}</span> : null}
      </div>
      {body?.status === "ok" && !body.scan.complete ? (
        <p className={a.offline}>
          Still reading the kernel: job ids {body.scan.from} to {body.scan.cursor} of {body.scan.head} checked so far.
        </p>
      ) : null}
      {jobs.length > 0 ? (
        <div className={s.scroll}>
          <table className={a.table}>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Loan</th>
                <th scope="col">Window (New York)</th>
                <th scope="col" className={a.r}>
                  Escrow
                </th>
                <th scope="col">Guardian</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const st = jobState(j, now);
                return (
                  <tr key={j.id}>
                    <td>{j.id}</td>
                    <td>{j.terms ? <Ext href={scanAddress(j.terms.account)}>{shortHex(j.terms.account, 6, 4)}</Ext> : <span className={a.faint}>not bound yet</span>}</td>
                    <td>{j.terms ? `${nyDayTime(j.terms.start)} to ${nyDayTime(j.terms.end)}` : <span className={a.faint}>set when funded</span>}</td>
                    <td className={a.r}>{budgetText(j)}</td>
                    <td>{j.terms ? <Ext href={identityUrl(j.terms.agentId)}>{j.terms.agentId}</Ext> : <Ext href={scanAddress(j.provider)}>{shortHex(j.provider, 6, 4)}</Ext>}</td>
                    <td>
                      <span className={`${a.tag} ${TONE[st.tone]}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={a.empty}>
          {body === null ? (
            <p>Reading the ERC-8183 kernel on BNB Chain.</p>
          ) : body.status === "not-deployed" ? (
            <>
              <h3>The guardian contract is not deployed on this chain yet</h3>
              <p>Jobs appear here once it is. {body.detail}.</p>
            </>
          ) : body.status === "unavailable" ? (
            <>
              <h3>The kernel could not be read</h3>
              <p>{body.detail}. No job is listed in its place.</p>
            </>
          ) : (
            <>
              <h3>No guardian job has been posted yet</h3>
              <p>
                The kernel&apos;s jobs {body.scan.from} to {body.scan.head} were checked: none names the Ballast guardian as its evaluator. The first job a borrower funds will appear here with its window, its escrow and its outcome.
              </p>
              <p>
                To see one job funded, guarded and settled against these same contracts, play the <Link href="/judge">recorded cycle</Link>.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Roster({ identity, reputation, jobs }: { identity: IdentityView | null; reputation: ReputationView | null; jobs: readonly JobView[] }) {
  const mine = jobs.filter((j) => j.terms?.agentId === DESK_AGENT_ID.toString());
  const survived = mine.filter((j) => j.status === "Completed").length;
  const refunded = mine.filter((j) => j.status === "Rejected").length;
  const settled = survived + refunded;
  const guard = reputation?.guard ?? null;
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="Guardian roster">
      <div className={a.ph}>
        <div>
          <h2>Roster</h2>
          <p className={a.sub}>A guardian is an ERC-8004 identity. Its record is written by the guardian contract: one entry per settled window, 100 for a loan that survived, 0 for one that did not.</p>
        </div>
      </div>
      <div className={s.scroll}>
        <table className={a.table}>
          <thead>
            <tr>
              <th scope="col">Guardian</th>
              <th scope="col">Windows settled</th>
              <th scope="col">Survived</th>
              <th scope="col" className={a.r}>
                Refunds
              </th>
              <th scope="col">ERC-8004 reputation</th>
              <th scope="col" className={a.r}>
                Record
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div className={s.who}>
                  <Seal id={DESK_AGENT_ID.toString()} rate={settled ? survived / settled : null} />
                  <div>
                    <b>Guardian {DESK_AGENT_ID.toString()}</b>
                    <small>
                      The Ballast desk,{" "}
                      {identity?.owner ? (
                        <>
                          registered to <Ext href={scanAddress(identity.owner)}>{shortHex(identity.owner, 6, 4)}</Ext>
                          {identity.matchesDesk === false ? " (not the desk key this site knows)" : ""}
                        </>
                      ) : (
                        (identity?.error ?? `key ${shortHex(DESK_ADDRESS, 6, 4)}, registry not read`)
                      )}
                    </small>
                  </div>
                </div>
              </td>
              <td>{settled}</td>
              <td>
                {settled ? (
                  <>
                    <span className={s.bar2}>
                      <i style={{ width: `${(survived / settled) * 100}%` }} />
                    </span>
                    {survived} of {settled}
                  </>
                ) : (
                  <span className={a.faint}>none settled yet</span>
                )}
              </td>
              <td className={a.r}>{refunded}</td>
              <td>
                {reputation === null ? (
                  <span className={a.faint}>not read</span>
                ) : reputation.error ? (
                  <span className={a.faint}>{reputation.error}</span>
                ) : guard ? (
                  `${guard.count} ${guard.count === 1 ? "entry" : "entries"} from the guardian contract, average ${guard.average.toFixed(0)}`
                ) : (
                  <span className={a.faint}>No entry from the guardian contract yet{reputation.clients ? `; ${reputation.clients} other ${reputation.clients === 1 ? "rater" : "raters"}` : ""}</span>
                )}
              </td>
              <td className={a.r}>
                <Ext href={identityUrl(DESK_AGENT_ID)}>ERC-8004 record</Ext>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HirePanel({ config, body, now }: { config: AppConfig; body: GuardiansBody | null; now: number }) {
  const [open, setOpen] = useState(false);
  const ok = body?.status === "ok" ? body : null;
  const provider = ok ? ((ok.identity.wallet ?? ok.identity.owner) as Address | null) : null;
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="Hire a guardian">
      <div className={a.ph}>
        <div>
          <h2>Hire a guardian</h2>
          <p className={a.sub}>For the owner of a Ballast credit line: post a job for the coming closure and escrow the fee. Every step is simulated before your wallet is asked.</p>
        </div>
      </div>
      {open && ok ? (
        <Hire config={config} provider={provider} minBudget={ok.minBudget} now={now} />
      ) : (
        <div className={a.empty}>
          {ok ? (
            <>
              <p>
                The guardian on offer is the Ballast desk, ERC-8004 agent {DESK_AGENT_ID.toString()}. It is paid only if your loan is not liquidated and is healthy when the window ends; otherwise the fee comes back to you.
              </p>
              <div className={a.actions}>
                <button type="button" className={a.btn} onClick={() => setOpen(true)}>
                  Open the hiring form
                </button>
              </div>
            </>
          ) : (
            <p>{body === null ? "Reading BNB Chain." : body.status === "not-deployed" ? "Jobs can be posted once the guardian contract is deployed on this chain." : "The chain could not be read, so no job can be prepared right now."}</p>
          )}
        </div>
      )}
    </section>
  );
}

function HowItSettles({ minBudget }: { minBudget: string | null }) {
  const xs = [22, 322, 622, 922];
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="How a job settles">
      <div className={a.ph}>
        <div>
          <h2>How a job settles</h2>
          <p className={a.sub}>Four steps, all on BNB Chain.</p>
        </div>
      </div>
      <svg className={s.flow} viewBox="0 0 1200 70" aria-hidden="true">
        <line x1={22} x2={1180} y1={30} y2={30} stroke="#3d5a94" strokeWidth={2} />
        {xs.map((x, i) => (
          <g key={x}>
            <circle cx={x} cy={30} r={14} fill="#0b1733" stroke={i === 3 ? "#3ef0b5" : "#d8ccab"} strokeWidth={2} />
            <text className="f-ui" x={x} y={35} textAnchor="middle" fontSize={14} fill="#f3ecd9">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className={s.flowtext}>
        <p>
          <b>1. Job posted</b>The borrower posts an ERC-8183 job that names a guardian and an expiry, sets the fee{minBudget ? ` (at least ${Number(BigInt(minBudget)) / 1e18} of the payment token)` : ""} and funds it into escrow with the terms: the
          account, the window, the guardian&apos;s ERC-8004 id.
        </p>
        <p>
          <b>2. Terms bound</b>The guardian contract checks that the borrower owns the account, that the loan has debt and is not liquidated, and that the provider is the identity the terms name. A borrower cannot hire itself.
        </p>
        <p>
          <b>3. Window ends</b>The guardian submits the hash of its evidence: what it did for the loan during the window. Before the window ends the submission is refused.
        </p>
        <p>
          <b>4. Escrow settles</b>Anyone may call settle. Not liquidated and healthy: the fee goes to the guardian. Otherwise it goes back to the borrower. Either way the outcome joins the guardian&apos;s ERC-8004 record.
        </p>
      </div>
    </section>
  );
}

export function GuardianBoard({ initial, serverNow, config }: { initial: GuardiansBody | null; serverNow: number; config?: AppConfig }) {
  const now = useNow(serverNow);
  const first = useJson<GuardiansBody>("/api/guardians", initial, 20_000);
  const body = first.data;
  const jobs = body?.status === "ok" ? body.jobs : [];
  const totals = boardTotals(jobs, now);
  const identity = body && body.status !== "unavailable" ? (body.identity ?? null) : null;
  const reputation = body && body.status !== "unavailable" ? (body.reputation ?? null) : null;
  return (
    <div className={a.shell}>
      <SiteBar
        current="/guardians"
        right={
          body?.status === "ok" ? (
            <StatusPill tone={totals.inWindow > 0 ? "on" : "idle"}>{totals.inWindow === 0 ? "No job in a window" : `${totals.inWindow} ${totals.inWindow === 1 ? "job" : "jobs"} in a window`}</StatusPill>
          ) : (
            <StatusPill tone={body ? "off" : "idle"} title={body?.detail}>
              {body === null ? "Reading BNB Chain" : body.status === "not-deployed" ? "Guardian not deployed" : "Chain read failed"}
            </StatusPill>
          )
        }
      />
      <main className={a.page}>
        <SiteTabs current="/guardians" />
        <div className={a.head}>
          <div>
            <h1>Guardians</h1>
            <p>Agents take on the job of keeping a loan alive through a closed window. They are paid from ERC-8183 escrow only if the loan survives, and they are known by an ERC-8004 identity.</p>
          </div>
          <ClockTag now={now} />
        </div>
        <div className={a.grid}>
          <Kpis body={body} now={now} />
          <Jobs body={body} now={now} />
          <WindowsWheel jobs={jobs} now={now} />
          <Roster identity={identity} reputation={reputation} jobs={jobs} />
          {config ? <HirePanel config={config} body={body} now={now} /> : null}
          <HowItSettles minBudget={body?.status === "ok" ? body.minBudget : null} />
        </div>
        <div className={a.foot}>
          <span>
            Jobs: the ERC-8183 kernel on BNB Chain{body?.status === "ok" ? `, guardian ${shortHex(body.guardian, 6, 4)}` : ""}. Identity and reputation: the ERC-8004 registries.
          </span>
          <span>Ballast</span>
        </div>
      </main>
    </div>
  );
}
