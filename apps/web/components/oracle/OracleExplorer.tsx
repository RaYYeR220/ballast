"use client";
/* /oracle: the Session Oracle explorer. Prices come from the Binance Web3 API through this app's routes, the
   oracle's state from BNB Chain; each panel names its source and says so when that source does not answer. */
import { tickers } from "@ballast/risk";
import { useMemo, useState } from "react";
import { CLOSURE_NAME, closureHours } from "@/lib/closures";
import { nyWeekdayClock } from "@/lib/format";
import type { CandlesBody, ClosureChart, PricesBody } from "@/lib/market-view";
import { freshVenues, oracleRows, type RwaStatusView } from "@/lib/oracle-rows";
import type { OracleView } from "@/lib/oracle-view";
import a from "@/components/app/app.module.css";
import { BandChart } from "./BandChart";
import { BandWeek, ChainPanel, HowSized, ReadingNow, SymbolsTable } from "./panels";
import { ClockTag, SiteBar, SiteTabs, StatusPill, useJson, useNow } from "./SiteBar";
import s from "./oracle.module.css";

export interface OracleInitial {
  now: number;
  oracle: OracleView | null;
  prices: PricesBody | null;
  rwa: RwaStatusView | null;
  candles: CandlesBody | null;
}

/** SessionOracle convergence tolerance set by the deployment script, used until the contract is read. */
const DEFAULT_TOLERANCE_BPS = 60;
/** Full hours a closure in progress needs before the chart opens on it. */
const MIN_HOURS_TO_LEAD = 4;
const CLOSURE_LABEL = { overnight: "Last night", weekend: "Last weekend", holiday: "Last holiday" } as const;

function closureSentence(symbol: string, c: ClosureChart, source: string): string {
  const hours = closureHours(c);
  return `${symbol}B hourly candles from ${source} since ${nyWeekdayClock(c.closedAt)}, against the band the feed enforces. ${c.kind === "overnight" ? "An" : "A"} ${CLOSURE_NAME[c.kind]} closure, ${hours.toFixed(1)} hours in all${c.inProgress ? ", still in progress" : ""}.`;
}

function ChartPanel({ symbol, body, loading, error, now }: { symbol: string; body: CandlesBody | null; loading: boolean; error: string | null; now: number }) {
  const [picked, setPick] = useState<number | null>(null);
  const closures = body?.status === "ok" && body.symbol === symbol ? body.closures : [];
  // a closure that has barely begun has little to show: open on the last long one until a few hours have traded
  const first = closures.length > 1 && closures[0]!.inProgress && closures[0]!.judged < MIN_HOURS_TO_LEAD ? 1 : 0;
  const pick = Math.min(picked ?? first, Math.max(0, closures.length - 1));
  const chart = closures[pick] ?? null;
  const source = body?.status === "ok" ? (body.source === "market-api" ? "the Binance Web3 Market API" : "Binance's public RWA klines") : "Binance";
  return (
    <section className={`${a.panel} ${s.span8}`} aria-label={`${symbol} across the last closure`}>
      <div className={`${a.ph} ${s.phWrap}`}>
        <div>
          <h2>{symbol} across {chart ? (chart.inProgress ? "the closure in progress" : `the last ${CLOSURE_NAME[chart.kind]} closure`) : "the last closure"}</h2>
          <p className={a.sub}>{chart ? closureSentence(symbol, chart, source) : "Real hourly candles against the band the feed enforces while New York is closed."}</p>
        </div>
        {closures.length > 1 ? (
          <div className={`${a.switch} ${s.closures}`} role="group" aria-label="Closure">
            {closures.map((c, i) => (
              <button key={c.closedAt} type="button" aria-pressed={i === pick} onClick={() => setPick(i)}>
                {c.inProgress ? "In progress" : CLOSURE_LABEL[c.kind]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {chart ? (
        <>
          <BandChart chart={chart} symbol={symbol} now={now} dim={loading} />
          {chart.bandNote && chart.judged > 0 ? <p className={a.offline}>{chart.bandNote}</p> : null}
          {body?.status === "ok" && body.sourceNote ? <p className={a.offline}>{body.sourceNote}.</p> : null}
          {body?.status === "ok" && body.referenceNote ? <p className={a.offline}>{body.referenceNote}</p> : null}
          <p className={s.method}>
            The band is drawn as the contract computes it: the last Chainlink print at each hour times the token&apos;s share multiplier, plus and minus {symbol}&apos;s worst-1% gap for this kind of closure, widening by one more of it
            every 24 hours up to three.{chart.inProgress ? " The dashed part projects it to the open from the reference as it stands." : ""}
          </p>
        </>
      ) : (
        <div className={a.empty}>
          {body === null && !error ? (
            <p>Loading {symbol}B candles from Binance.</p>
          ) : (
            <>
              <h3>No candles to draw</h3>
              <p>{body && body.status !== "ok" ? body.detail : (error ?? `Binance returned no closure for ${symbol}.`)}</p>
              <p>The chart stays empty until Binance answers; nothing is drawn in its place.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function OracleExplorer({ initial }: { initial: OracleInitial }) {
  const now = useNow(initial.now);
  const [symbol, setSymbol] = useState("NVDA");
  const oracle = useJson<OracleView>("/api/oracle", initial.oracle, 30_000);
  const prices = useJson<PricesBody>("/api/market/prices", initial.prices, 30_000);
  const rwa = useJson<RwaStatusView>("/api/rwa-status", initial.rwa, 60_000);
  const candles = useJson<CandlesBody>(`/api/market/candles?symbol=${symbol}`, symbol === "NVDA" ? initial.candles : null, 120_000);

  const rows = useMemo(() => oracleRows(prices.data, oracle.data, rwa.data, now), [prices.data, oracle.data, rwa.data, now]);
  const row = rows.find((r) => r.symbol === symbol) ?? rows[0]!;
  const tolerance = useMemo(() => {
    const first = oracle.data?.status === "ok" ? oracle.data.symbols.find((x) => !("error" in x)) : undefined;
    return first && !("error" in first) ? first.params.convergenceBps : DEFAULT_TOLERANCE_BPS;
  }, [oracle.data]);
  const fresh = freshVenues(row).length;
  const listed = Object.values(row.venues).filter(Boolean).length;
  const candlesBody = candles.data?.status === "ok" && candles.data.symbol !== symbol ? null : candles.data;

  return (
    <div className={a.shell}>
      <SiteBar
        current="/oracle"
        right={
          prices.data?.status === "ok" ? (
            <StatusPill tone={fresh > 0 ? "on" : "off"}>
              {fresh} of {listed} venues fresh for {symbol}
            </StatusPill>
          ) : (
            <StatusPill tone={prices.data ? "off" : "idle"} title={prices.data?.detail}>
              {prices.data ? "Binance prices unavailable" : "Reading Binance"}
            </StatusPill>
          )
        }
      />
      <main className={a.page}>
        <SiteTabs current="/oracle" />
        <div className={a.head}>
          <div>
            <h1>Session Oracle</h1>
            <p>Reference prices for tokenized US stocks, with an error band that says how stale New York&apos;s last price has become.</p>
          </div>
          <ClockTag now={now} />
        </div>
        <div className={a.switch} role="group" aria-label="Symbol">
          {tickers.map((t) => (
            <button key={t.symbol} type="button" aria-pressed={t.symbol === symbol} onClick={() => setSymbol(t.symbol)}>
              {t.symbol}
            </button>
          ))}
        </div>
        <div className={a.grid}>
          <ChartPanel key={symbol} symbol={symbol} body={candlesBody} loading={candles.loading} error={candles.error} now={now} />
          <ReadingNow row={row} now={now} rwa={rwa.data} oracle={oracle.data} />
          <SymbolsTable rows={rows} now={now} selected={symbol} onSelect={setSymbol} prices={prices.data} tolerance={tolerance} />
          <BandWeek symbol={symbol} now={now} />
          <HowSized symbol={symbol} />
          <ChainPanel oracle={oracle.data} now={now} />
        </div>
        <div className={a.foot}>
          <span>
            Venue prices: Binance Web3 RWA API. Candles: Binance Web3 Market API. Reference, multipliers and oracle state: BNB Chain. Session and asset status: Binance&apos;s public RWA endpoints
            {rwa.data?.status === "ok" && rwa.data.market?.marketStatus ? ` (Binance reports the US session as ${rwa.data.market.marketStatus})` : ""}.
          </span>
          <span>Ballast</span>
        </div>
      </main>
    </div>
  );
}
