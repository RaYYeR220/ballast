"use client";
/* The explorer's panels around the chart: the reading for one ticker, the table of all twelve, the band on
   the week wheel, how the band is sized, and the oracle's own state and publisher as read on chain. */
import { currentWindow, nextWindow, session, tickerBySymbol } from "@ballast/risk";
import { memo, useMemo } from "react";
import { Wheel } from "@/components/planisphere/Wheel";
import { bandBps } from "@/lib/band";
import { latestClosure } from "@/lib/closures";
import { countdown, nyDayTime, nyWeekdayClock, pctBps, shortHex } from "@/lib/format";
import { DESK_AGENT_ID, identityUrl, scanAddress } from "@/lib/identity";
import { LIQUIDATIONS } from "@/lib/liquidations";
import { STALE_AFTER_SEC, VENUE_NAME, VENUES, type MultiplierSource, type PricesBody, type VenuePrice } from "@/lib/market-view";
import { freshVenues, type OracleRow, type RwaStatusView } from "@/lib/oracle-rows";
import { reasonLabel, type OracleView } from "@/lib/oracle-view";
import { angleOf, polar, r2, rotationFor } from "@/lib/planisphere/geometry";
import { hourOfWeek, localToUtc, mondayOf, weekSectors } from "@/lib/planisphere/sessions";
import a from "@/components/app/app.module.css";
import s from "./oracle.module.css";

const pm = "\u00b1";
const money = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const WINDOW_WORD: Record<string, string> = { OVERNIGHT: "tonight", WEEKEND: "the weekend", HOLIDAY: "the holiday closure", EARNINGS: "the earnings night" };
const CLOSURE_WORD: Record<string, string> = { OVERNIGHT: "overnight", WEEKEND: "weekend", HOLIDAY: "holiday", EARNINGS: "earnings", NONE: "none" };
const SOURCE_TEXT: Record<MultiplierSource, string> = {
  "bstock-token": "the token's own on-chain multiplier",
  "ondo-shares-oracle": "Ondo's on-chain shares oracle",
  "session-oracle-overlay": "the live multiplier in the Session Oracle overlay",
  rebasing: "xStocks rebase, one token is one share",
};

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// ------------------------------------------------------------------ reading

function bandLine(row: OracleRow): string {
  const b = row.band;
  if (b.kind === "open") return "New York is open: the feed passes the price through, no band.";
  if (b.kind === "chain") return `band ${pm}${pctBps(b.bps)}, ${money(b.lo)} to ${money(b.hi)} per token`;
  if (b.kind === "rule") return `band ${pm}${pctBps(b.bps)} by the contract's rule`;
  if (b.kind === "no-anchor") return "Closed, but the feed has no anchor: it passes the price through.";
  return `Band unknown: ${b.why}`;
}

export function ReadingNow({ row, now, rwa, oracle }: { row: OracleRow; now: number; rwa: RwaStatusView | null; oracle: OracleView | null }) {
  const ref = row.reference;
  const fresh = freshVenues(row);
  const closure = latestClosure(now);
  const ahead = row.chain?.windowAhead ?? null;
  const next = ahead ? null : nextWindow(now);
  const gap = ahead ? ahead.gapBps : next && next.type !== "NONE" ? tickerBySymbol(row.symbol).gapBps[next.type.toLowerCase() as "overnight" | "weekend" | "holiday"] : 0;
  const aheadKind = ahead ? ahead.window : (next?.type ?? "NONE");
  const chain = row.chain;
  return (
    <section className={`${a.panel} ${s.span4} ${s.reading}`} aria-label={`Reading now for ${row.symbol}`}>
      <div className={a.ph}>
        <div>
          <h2>Reading now</h2>
          <p className={a.sub}>What a lending contract would read for {row.symbol} at this minute.</p>
        </div>
      </div>
      {ref ? (
        <>
          <div className={s.refp}>{money(ref.price)}</div>
          <p className={s.refcap}>{ref.source === "session-oracle" ? "Reference per share, from the Session Oracle" : "Reference per share, the Chainlink feed the oracle reads"}</p>
        </>
      ) : (
        <>
          <div className={`${s.refp} ${a.faint}`}>No reference</div>
          <p className={s.refcap}>{row.referenceNote ?? row.chainError ?? "The reference could not be read."}</p>
        </>
      )}
      <div className={s.bandv}>{bandLine(row)}</div>
      <dl>
        <dt>Reference age</dt>
        <dd>{ref ? countdown(Math.max(0, now - ref.updatedAt)) : "unknown"}</dd>
        <dt>Last New York close</dt>
        <dd>{closure ? nyWeekdayClock(closure.closedAt) : "unknown"}</dd>
        <dt>Venues with a fresh price</dt>
        <dd>{fresh.length ? fresh.map((v) => VENUE_NAME[v]).join(", ") : "none"}</dd>
        <dt>Spread across them</dt>
        <dd>{row.spread ? pctBps(row.spread.bps, 2) : "needs two fresh prices"}</dd>
        <dt>{closure?.inProgress ? "Band resets" : "Band starts"}</dt>
        <dd>{closure?.inProgress ? nyWeekdayClock(closure.opensAt) : ahead && ahead.startsAt ? nyWeekdayClock(ahead.startsAt) : next && next.startsAt ? nyWeekdayClock(next.startsAt) : "unknown"}</dd>
        <dt>May risk be added</dt>
        <dd>{chain ? (chain.canAddRisk ? "Yes" : `No: ${reasonLabel(chain.reason)}`) : oracle?.status === "not-deployed" ? "Not deployed yet" : "Not read"}</dd>
        <dt>bStock on Binance</dt>
        <dd>{row.asset ? `${row.asset.open ? "Open" : "Closed"}${row.asset.code ? `, ${row.asset.code.toLowerCase()}` : ""}` : rwa?.status === "unavailable" ? "Status unavailable" : "No status"}</dd>
      </dl>
      <div className={s.use}>
        {gap > 0 ? (
          <p className={a.note}>
            The keeper sizes {row.symbol}B loans to survive the worst 1% gap of {WINDOW_WORD[aheadKind] ?? "the next closure"}: {pctBps(gap)}.
          </p>
        ) : (
          <p className={a.note}>No gap is configured for {row.symbol} over the next closure.</p>
        )}
      </div>
    </section>
  );
}

// -------------------------------------------------------------------- table

function VenueCell({ v, now }: { v: VenuePrice | null; now: number }) {
  if (!v) return <td className={`${a.r} ${a.faint}`}>not listed</td>;
  if (v.perShare === null) {
    return (
      <td className={`${a.r} ${a.faint}`} title={v.note}>
        {v.tokenPrice !== null ? `${money(v.tokenPrice)} per token` : "no price"}
      </td>
    );
  }
  const age = v.updatedAt === null ? null : Math.max(0, now - v.updatedAt);
  return (
    <td className={`${a.r} ${v.stale ? a.faint : ""}`} title={`${money(v.tokenPrice ?? 0)} per token; ${v.multiplierSource ? SOURCE_TEXT[v.multiplierSource] : ""}${v.multiplier !== null && v.multiplierSource !== "rebasing" ? ` (${v.multiplier.toFixed(6)} shares per token)` : ""}`}>
      {money(v.perShare)}
      {v.stale ? <small className={s.cellNote}>{age === null ? "no time" : `${countdown(age)} old`}</small> : null}
    </td>
  );
}

function bandCell(row: OracleRow): string {
  const b = row.band;
  if (b.kind === "open") return "none, open";
  if (b.kind === "chain" || b.kind === "rule") return `${pm}${pctBps(b.bps)}`;
  if (b.kind === "no-anchor") return "no anchor";
  return "unknown";
}

function StatusTag({ row, tolerance }: { row: OracleRow; tolerance: number }) {
  const flags = row.chain?.overlay.flagNames ?? [];
  if (flags.length) return <span className={`${a.tag} ${a.no}`}>{flags.map((f) => f.toLowerCase().replace(/_/g, " ")).join(", ")}</span>;
  if (row.asset && !row.asset.open) return <span className={`${a.tag} ${a.no}`}>bStock closed{row.asset.code ? `: ${row.asset.code.toLowerCase()}` : ""}</span>;
  if (!row.spread) return <span className={a.tag}>One fresh venue</span>;
  return row.spread.bps > tolerance ? <span className={`${a.tag} ${a.no}`}>Venues disagree</span> : <span className={`${a.tag} ${a.ok}`}>Agreeing</span>;
}

export function SymbolsTable({ rows, now, selected, onSelect, prices, tolerance }: { rows: OracleRow[]; now: number; selected: string; onSelect: (s: string) => void; prices: PricesBody | null; tolerance: number }) {
  const state =
    prices === null ? "Loading Binance prices" : prices.status === "ok" ? "Live from Binance Web3" : prices.status === "not-configured" ? "Binance key not configured" : "Binance prices unavailable";
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="All symbols">
      <div className={a.ph}>
        <div>
          <h2>All symbols</h2>
          <p className={a.sub}>
            Per underlying share: the token price from the Binance Web3 RWA API, divided by the issuer&apos;s own on-chain share multiplier. A price older than {STALE_AFTER_SEC / 60} minutes is dimmed and left out of the spread.
          </p>
        </div>
        <span className={`${a.tag} ${prices?.status === "ok" ? a.live : prices === null ? "" : a.no}`}>{state}</span>
      </div>
      {prices && prices.status !== "ok" ? <p className={a.offline}>{prices.detail}. The venue columns stay empty until Binance answers.</p> : null}
      {prices?.status === "ok" && prices.chainNote ? <p className={a.offline}>{prices.chainNote}. Prices are shown per token until the chain answers.</p> : null}
      <div className={s.scroll}>
        <table className={a.table}>
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              {VENUES.map((v) => (
                <th key={v} scope="col" className={a.r}>
                  {VENUE_NAME[v]}
                </th>
              ))}
              <th scope="col" className={a.r}>
                Reference
              </th>
              <th scope="col" className={a.r}>
                Spread
              </th>
              <th scope="col" className={a.r}>
                Band now
              </th>
              <th scope="col" className={a.r}>
                Reference age
              </th>
              <th scope="col">Add risk</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} data-selected={r.symbol === selected || undefined}>
                <th scope="row">
                  <button type="button" className={s.symBtn} onClick={() => onSelect(r.symbol)} aria-pressed={r.symbol === selected}>
                    {r.symbol}
                  </button>
                </th>
                {VENUES.map((v) => (
                  <VenueCell key={v} v={r.venues[v]} now={now} />
                ))}
                <td className={`${a.r} ${s.hi}`} title={r.reference ? (r.reference.source === "session-oracle" ? "SessionOracle.referenceFor" : "Chainlink feed, read directly") : (r.referenceNote ?? undefined)}>
                  {r.reference ? money(r.reference.price) : "none"}
                </td>
                <td className={a.r}>{r.spread ? pctBps(r.spread.bps, 2) : "n/a"}</td>
                <td className={a.r} title={r.band.kind === "rule" ? "computed with the contract's rule" : r.band.kind === "chain" ? "SessionAwareFeed.band" : undefined}>
                  {bandCell(r)}
                </td>
                <td className={a.r}>{r.reference ? countdown(Math.max(0, now - r.reference.updatedAt)) : "n/a"}</td>
                <td>{r.chain ? r.chain.canAddRisk ? <span className={`${a.tag} ${a.ok}`}>Yes</span> : <span className={a.tag}>No: {reasonLabel(r.chain.reason)}</span> : <span className={a.faint}>{r.chainError ? "unreadable" : "not read"}</span>}</td>
                <td>
                  <StatusTag row={r} tolerance={tolerance} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// -------------------------------------------------------- band on the wheel

const QUARTER = 900;

/** The band's width through the current week as a ring outside the rim: one quad per quarter hour closed. */
function bandRing(symbol: string, monday: number, R: number): string {
  const g = tickerBySymbol(symbol).gapBps;
  let d = "";
  for (let q = 0; q < 672; q++) {
    const ts = localToUtc(monday + Math.floor(q / 96), (q % 96) * QUARTER) + 1;
    const w = currentWindow(ts);
    if (w.type === "NONE") continue;
    const bps = bandBps(g[w.type.toLowerCase() as "overnight" | "weekend" | "holiday"], ts - w.closedAt);
    const t = (bps / 100) * 1.25;
    if (t < 0.5) continue;
    const h = q / 4;
    const [x0, y0] = polar(angleOf(h), R + 16);
    const [x1, y1] = polar(angleOf(h), R + 16 + t);
    const [x2, y2] = polar(angleOf(h + 0.25), R + 16 + t);
    const [x3, y3] = polar(angleOf(h + 0.25), R + 16);
    d += `M${r2(x0)} ${r2(y0)}L${r2(x1)} ${r2(y1)}L${r2(x2)} ${r2(y2)}L${r2(x3)} ${r2(y3)}Z`;
  }
  return d;
}

const StaticWheel = memo(Wheel);

export function BandWeek({ symbol, now }: { symbol: string; now: number }) {
  const week = useMemo(() => weekSectors(now), [now]);
  const ring = useMemo(() => bandRing(symbol, mondayOf(now), 150), [symbol, week.monday]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = tickerBySymbol(symbol);
  return (
    <section className={`${a.panel} ${a.span5}`} aria-label="The band through the week">
      <div className={a.ph}>
        <div>
          <h2>The band through the week</h2>
          <p className={a.sub}>Ring thickness is {symbol}&apos;s band. It swells each night, swells more over the weekend, and resets at every open.</p>
        </div>
      </div>
      <svg className={s.breath} viewBox="0 0 440 440" role="img" aria-label={`Week wheel for ${symbol} with an outer band whose thickness grows through each closure and resets at each open: ${pctBps(t.gapBps.overnight)} at a weeknight's close, up to ${pctBps(Math.min(t.gapBps.weekend * 3, 9000))} late in a weekend.`}>
        <StaticWheel id="bw" cx={220} cy={220} R={150} rotation={rotationFor(hourOfWeek(now))} sectors={week.sectors} liquidations={LIQUIDATIONS} compact money={false} wedges={false} fontScale={1.1} starOpacity={0.25}>
          <path d={ring} fill="#3ef0b5" opacity={0.5} />
        </StaticWheel>
        <line x1={220} x2={220} y1={220 - 150 - 62} y2={220 - 150 * 0.6} stroke="#3ef0b5" strokeWidth={1.5} />
      </svg>
    </section>
  );
}

// ------------------------------------------------------------- how it works

const GAP_ROWS = [
  ["Overnight", "overnight"],
  ["Weekend", "weekend"],
  ["Holiday", "holiday"],
  ["Earnings", "earnings"],
] as const;

export function HowSized({ symbol }: { symbol: string }) {
  const g = tickerBySymbol(symbol).gapBps;
  const max = Math.max(...GAP_ROWS.map(([, k]) => g[k]), 1);
  return (
    <section className={`${a.panel} ${a.span7} ${s.how}`} aria-label="How the band is sized">
      <div className={a.ph}>
        <div>
          <h2>How the band is sized</h2>
        </div>
      </div>
      <p>
        While New York is closed the feed holds a bStock&apos;s price inside a band around the last reference print. The band starts at the worst 1% of that stock&apos;s gaps for the kind of closure in progress, widens by one more of
        it for every 24 hours closed, and stops at three. A thin-book wick outside it cannot move collateral value; a real move is priced at the band&apos;s edge, and in full from the first regular print.
      </p>
      <svg className={s.pbars} viewBox="0 0 640 170" role="img" aria-label={`Worst 1% down-gap for ${symbol} by window: ${GAP_ROWS.map(([n, k]) => `${n.toLowerCase()} ${g[k] ? pctBps(g[k]) : "not measured"}`).join(", ")}.`}>
        {GAP_ROWS.map(([name, k], i) => {
          const y = 10 + i * 40;
          const w = (440 * g[k]) / max;
          return (
            <g key={k}>
              <text className="f-ui" x={0} y={y + 16} fontSize={15} fill="#f3ecd9">
                {name}
              </text>
              {g[k] > 0 ? <rect x={110} y={y + 2} width={r2(Math.max(2, w))} height={20} fill="#e6ecf7" rx={2} /> : null}
              <text className="f-display" x={r2(110 + (g[k] > 0 ? w + 8 : 0))} y={y + 18} fontSize={22} fontWeight={600} fill="#f3ecd9">
                {g[k] > 0 ? pctBps(g[k]) : "no earnings"}
              </text>
            </g>
          );
        })}
      </svg>
      <p>
        These are {symbol}&apos;s own figures, measured on 6.3 years of daily bars and set on the Session Oracle at deployment. When earnings land at the next open, the band starts from the larger of the earnings gap and the
        closure&apos;s own.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ on chain

export function ChainPanel({ oracle, now }: { oracle: OracleView | null; now: number }) {
  if (oracle === null || oracle.status !== "ok") {
    return (
      <section className={`${a.panel} ${a.span12}`} aria-label="The Session Oracle on chain">
        <div className={a.ph}>
          <div>
            <h2>On chain</h2>
            <p className={a.sub}>The Session Oracle&apos;s own state and the identity allowed to publish to it.</p>
          </div>
          <span className={`${a.tag} ${oracle?.status === "unavailable" ? a.no : ""}`}>{oracle === null ? "Reading the chain" : oracle.status === "not-deployed" ? "Not deployed yet" : "Chain read failed"}</span>
        </div>
        <div className={a.empty}>
          {oracle === null ? (
            <p>Reading the Session Oracle on BNB Chain.</p>
          ) : oracle.status === "not-deployed" ? (
            <>
              <h3>The Session Oracle is not deployed on this chain yet</h3>
              <p>Once it is, this panel shows the session it reports, the closure in progress, each reference&apos;s age, the publisher&apos;s flags, whether risk may be added and why, and the band the feed enforces now.</p>
              <p className={a.faint}>{oracle.detail}</p>
            </>
          ) : (
            <>
              <h3>The Session Oracle could not be read</h3>
              <p>{oracle.detail}. Nothing is shown in its place; the Binance prices above do not depend on it.</p>
            </>
          )}
        </div>
      </section>
    );
  }
  const ss = oracle.session;
  const p = oracle.publisher;
  const id = p?.identity ?? null;
  const first = oracle.symbols.find((x) => !("error" in x)) as Extract<(typeof oracle.symbols)[number], { params: unknown }> | undefined;
  const params = first?.params;
  const overlays = oracle.symbols.filter((x) => !("error" in x)) as Extract<(typeof oracle.symbols)[number], { overlay: unknown }>[];
  const freshOverlays = overlays.filter((x) => x.overlay.fresh).length;
  const lastPost = overlays.reduce((m, x) => Math.max(m, x.overlay.postedAt), 0);
  const unreadable = oracle.symbols.length - overlays.length;
  return (
    <section className={`${a.panel} ${a.span12}`} aria-label="The Session Oracle on chain">
      <div className={a.ph}>
        <div>
          <h2>On chain</h2>
          <p className={a.sub}>
            Read from the Session Oracle at block {Number(oracle.blockNumber).toLocaleString("en-US")}, {countdown(Math.max(0, now - oracle.at))} ago.
          </p>
        </div>
        <span className={`${a.tag} ${a.live}`}>Session: {ss.session.toLowerCase().replace(/_/g, " ")}</span>
      </div>
      <div className={s.chainGrid}>
        <dl className={s.facts}>
          <dt>Closure in progress</dt>
          <dd>{ss.current.kind === "NONE" ? "None, New York is open" : `${CLOSURE_WORD[ss.current.kind] ?? ss.current.kind.toLowerCase()}, since ${nyDayTime(ss.current.closedAt)}, opens ${nyDayTime(ss.current.opensAt)}`}</dd>
          <dt>Next closure</dt>
          <dd>{ss.window.kind === "NONE" ? "Unknown to the calendar" : `${CLOSURE_WORD[ss.window.kind] ?? ss.window.kind.toLowerCase()}, ${nyDayTime(ss.window.startsAt)} to ${nyDayTime(ss.window.endsAt)}`}</dd>
          <dt>Publisher overlays</dt>
          <dd>
            {freshOverlays} of {overlays.length} valid{lastPost ? `, last posted ${countdown(Math.max(0, now - lastPost))} ago` : ""}
            {unreadable ? `; ${unreadable} unreadable` : ""}
          </dd>
          {params ? (
            <>
              <dt>Restore waits after the open</dt>
              <dd>{countdown(params.restoreDelay)}</dd>
              <dt>Closure horizon</dt>
              <dd>{countdown(params.horizon)}</dd>
              <dt>Convergence tolerance</dt>
              <dd>{pctBps(params.convergenceBps, 2)}</dd>
              <dt>Oldest reference accepted</dt>
              <dd>{countdown(params.maxRefAge)}</dd>
            </>
          ) : null}
        </dl>
        <dl className={s.facts}>
          <dt>Publisher key</dt>
          <dd>{p?.address ? <Ext href={scanAddress(p.address)}>{shortHex(p.address, 6, 4)}</Ext> : (p?.error ?? "not read")}</dd>
          <dt>ERC-8004 identity</dt>
          <dd>{p?.agentId && p.agentId !== "0" ? <Ext href={identityUrl(p.agentId)}>Agent {p.agentId}</Ext> : "none set"}</dd>
          <dt>Identity registry</dt>
          <dd>{id ? <Ext href={scanAddress(id.registry)}>{shortHex(id.registry, 6, 4)}</Ext> : "not read"}</dd>
          <dt>Registry says the id belongs to</dt>
          <dd>
            {id?.owner ? (
              <>
                <Ext href={scanAddress(id.owner)}>{shortHex(id.owner, 6, 4)}</Ext>{" "}
                {p?.address && (id.owner === p.address || id.wallet === p.address) ? <span className={`${a.tag} ${a.ok}`}>Same key as the publisher</span> : <span className={`${a.tag} ${a.no}`}>Not the publisher key</span>}
              </>
            ) : (
              (id?.error ?? "not read")
            )}
          </dd>
          {oracle.contracts ? (
            <>
              <dt>Session Oracle</dt>
              <dd>
                <Ext href={scanAddress(oracle.contracts.sessionOracle)}>{shortHex(oracle.contracts.sessionOracle, 6, 4)}</Ext>
              </dd>
              <dt>Session-aware feed</dt>
              <dd>
                <Ext href={scanAddress(oracle.contracts.sessionAwareFeed)}>{shortHex(oracle.contracts.sessionAwareFeed, 6, 4)}</Ext>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      {p?.agentId && p.agentId !== DESK_AGENT_ID.toString() ? <p className={a.offline}>The oracle names agent {p.agentId}, not the desk identity this site knows ({DESK_AGENT_ID.toString()}).</p> : null}
    </section>
  );
}

/** "market open" as the calendar sees it, for the bar's pill. */
export const isOpen = (now: number) => session(now) === "REGULAR";
