/* /evidence: the measurement behind Ballast. The wheel of every liquidation first, the tables below it, then
   how it was measured, what it does not show, the backtest with its assumptions, and how to reproduce it all.
   Every number is computed from the files in data/ and config/ (lib/evidence.ts, lib/liquidations.ts). */
import { EvidenceSky } from "@/components/landing/EvidenceSky";
import { SessionLegend, SessionShares } from "@/components/landing/charts";
import { SiteBar, SiteTabs, StatusPill } from "@/components/oracle/SiteBar";
import { SAMPLE, SAMPLE_CLOCK, WEEK } from "@/lib/clock";
import { BACKTEST, BACKTEST_TYPES, GAP_TABLE, largestOrganic, sessionRows, timingRows } from "@/lib/evidence";
import { pctBps } from "@/lib/format";
import { scanAddress, scanTx } from "@/lib/identity";
import { FACTS, kUsd, pct, pct1 } from "@/lib/liquidations";
import { bscConfig } from "@ballast/risk";
import a from "@/components/app/app.module.css";
import s from "./evidence.module.css";

const usd0 = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const share = (x: number) => `${pct1(x)}%`;
/** a unix time as its New York date, "18 June 2026" */
const longDate = (ts: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "America/New_York" }).format(new Date(ts * 1000));
const MOOLAH = bscConfig.lista.moolah;
const SEED_ADDRESS = "0x05e3a7a66945ca9af73f66660f22ffb36332fa54";

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Evidence() {
  const sessions = sessionRows();
  const timing = timingRows();
  const largest = largestOrganic(8);
  const closedRows = sessions.filter((r) => r.key !== "regular" && r.key !== "total");
  const closedCount = closedRows.reduce((n, r) => n + r.count, 0);
  const closedUsd = closedRows.reduce((n, r) => n + r.usdShare, 0);
  const worst = BACKTEST.results[BACKTEST.results.length - 1]!;
  // the sample window the site states everywhere: whole New York days, the last one included
  const first = longDate(SAMPLE.from);
  const last = longDate(SAMPLE.to - 86_400);
  return (
    <div className={a.shell}>
      <SiteBar current="/evidence" right={<StatusPill tone="idle">{FACTS.total} liquidations read on BNB Chain</StatusPill>} />
      <main className={a.page}>
        <SiteTabs current="/evidence" />
        <div className={a.head}>
          <div>
            <h1>Evidence</h1>
            <p>
              Every liquidation of a tokenized stock on Lista Lending from {first} to {last}, placed on the New York week. The risk builds while the market is closed; the money is lost when it opens.
            </p>
          </div>
        </div>

        <section className={`${a.panel} ${s.hero}`} aria-label="The measurement">
          <div className={s.claims}>
            <h2>Where the money is lost</h2>
            <p className={s.claim}>
              <b>{pct(FACTS.firstWindowShare)}</b>
              <span>
                of the dollars real borrowers lost were repaid in the first 90 minutes after an open: {kUsd(FACTS.firstWindowUsd)} of {kUsd(FACTS.organicUsd)}, across {FACTS.organic} liquidations.
              </span>
            </p>
            <p className={s.claim}>
              <b>
                {FACTS.weekend} of {FACTS.bStockCollateral}
              </b>
              <span>
                liquidations of bStock collateral happened on a weekend, although Friday 8 PM to Sunday 8 PM is {pct(WEEK.weekendShare)} of the clock.
              </span>
            </p>
            <p className={s.claim}>
              <b>{pct(WEEK.closedShare)}</b>
              <span>of an ordinary week New York&apos;s regular session is closed. Prices that move then are settled in the first minutes of the next session.</span>
            </p>
            <p className={a.faint}>
              Each star is one liquidation; its distance from the centre is the dollars repaid. Hollow rings are {FACTS.seeds} tiny positions of one test address. Every star links to its transaction.
            </p>
          </div>
          <div className={s.skyBox}>
            <EvidenceSky className={s.sky} />
          </div>
        </section>

        <div className={`${a.grid} ${s.below}`}>
          <section className={`${a.panel} ${a.span7}`} aria-label="By session">
            <div className={a.ph}>
              <div>
                <h2>By session</h2>
                <p className={a.sub}>
                  The {FACTS.bStockCollateral} liquidations with a bStock as collateral. Clock share is the part of the sample period each session takes, read from the NYSE calendar.
                </p>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={`${a.table} ${s.nums}`}>
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Clock</th>
                    <th scope="col">Liquidations</th>
                    <th scope="col">Real borrowers</th>
                    <th scope="col">Their dollars</th>
                    <th scope="col">All dollars</th>
                    <th scope="col">Dollar share</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((r) => (
                    <tr key={r.key} data-total={r.key === "total" || undefined}>
                      <th scope="row">{r.name}</th>
                      <td>{share(r.clockShare)}</td>
                      <td>{r.count}</td>
                      <td>{r.organic}</td>
                      <td>{usd0(r.organicUsd)}</td>
                      <td>{usd0(r.usd)}</td>
                      <td>{share(r.usdShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.reading}>
              {closedCount} of {FACTS.bStockCollateral} liquidations ({pct(closedCount / FACTS.bStockCollateral)}) happened outside the regular session, but they carried {share(closedUsd)} of the dollars. Most of them are the test address&apos;s
              small positions crossing the line at night.
            </p>
          </section>
          <section className={`${a.panel} ${a.span5}`} aria-label="Clock against dollars">
            <div className={a.ph}>
              <div>
                <h2>Clock against dollars</h2>
                <p className={a.sub}>The same table as two bars: how the clock divides, and how the dollars do.</p>
              </div>
            </div>
            <SessionLegend className={s.legend} />
            <div className={s.bars}>
              <SessionShares clock={SAMPLE_CLOCK} dollars={FACTS.dollarShares} />
            </div>
          </section>

          <section className={`${a.panel} ${a.span5}`} aria-label="Inside the day">
            <div className={a.ph}>
              <div>
                <h2>Inside the day</h2>
                <p className={a.sub}>The {FACTS.organic} liquidations of real borrowers, by when they landed.</p>
              </div>
            </div>
            <table className={`${a.table} ${s.nums}`}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Count</th>
                  <th scope="col">Dollars</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {timing.map((r, i) => (
                  <tr key={r.name} data-total={i === timing.length - 1 || undefined}>
                    <th scope="row">{r.name}</th>
                    <td>{r.count}</td>
                    <td>{usd0(r.usd)}</td>
                    <td>{share(r.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className={`${a.panel} ${a.span7}`} aria-label="Largest liquidations">
            <div className={a.ph}>
              <div>
                <h2>The largest</h2>
                <p className={a.sub}>The eight largest liquidations of real borrowers, each with its transaction on BNB Chain.</p>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={`${a.table} ${s.nums}`}>
                <thead>
                  <tr>
                    <th scope="col">New York time</th>
                    <th scope="col">Collateral</th>
                    <th scope="col">Repaid</th>
                    <th scope="col" className={s.left}>
                      Timing
                    </th>
                    <th scope="col" className={s.left}>
                      Transaction
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {largest.map((r) => (
                    <tr key={r.tx}>
                      <th scope="row">{r.et.replace(" ET", "")}</th>
                      <td>{r.c}</td>
                      <td>{usd0(r.usd)}</td>
                      <td className={s.left}>{r.t.replace("regular: ", "")}</td>
                      <td className={s.left}>
                        <Ext href={scanTx(r.tx)}>
                          {r.tx.slice(0, 10)}...{r.tx.slice(-6)}
                        </Ext>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={`${a.panel} ${s.span6} ${s.prose}`} aria-label="Method">
            <div className={a.ph}>
              <div>
                <h2>Method</h2>
              </div>
            </div>
            <ol>
              <li>
                Every <code>Liquidate</code> event of Lista&apos;s Moolah contract (<Ext href={scanAddress(MOOLAH)}>{MOOLAH.slice(0, 10)}...</Ext>) in a market that involves a bStock was read with <code>eth_getLogs</code>, from {first} to{" "}
                {last}: {FACTS.total} events.
              </li>
              <li>Each was placed on the New York week by its block time, with the session read from the same NYSE calendar the contracts carry (holidays, early closes and daylight saving included).</li>
              <li>The repaid amount is valued in dollars with the Binance hourly close of the collateral at that hour; the loans themselves are dollar stablecoins.</li>
              <li>
                Rows are grouped by borrower: {FACTS.organic} from real borrowers, {FACTS.seeds} from one test address (<Ext href={scanAddress(SEED_ADDRESS)}>{SEED_ADDRESS.slice(0, 10)}...</Ext>) that opened positions of ${Math.round(FACTS.seedMinUsd)}{" "}
                to ${Math.round(FACTS.seedMaxUsd)} across many markets, and {FACTS.loans} in the one market where a bStock was the loan and not the collateral.
              </li>
              <li>&quot;First 90 minutes&quot; means 9:30 to 11:00 AM New York time on a trading day; &quot;weekend&quot; means Friday 8:00 PM to Sunday 8:00 PM.</li>
            </ol>
          </section>
          <section className={`${a.panel} ${s.span6} ${s.prose}`} aria-label="Caveats">
            <div className={a.ph}>
              <div>
                <h2>What this does not show</h2>
              </div>
            </div>
            <ul>
              <li>
                The sample is young: about three months of one lending market, {FACTS.organic} liquidations of real borrowers worth {kUsd(FACTS.organicUsd)}. A handful of large ones carry most of the dollars.
              </li>
              <li>The {FACTS.seeds} test positions mark when prices crossed the line, not losses. They are counted in the session table and drawn as hollow rings, and left out of every statement about real borrowers.</li>
              <li>No weekend liquidation in this sample is not a promise of none. The same liquidators did act on weekends in markets without stocks.</li>
              <li>Dollar values use an hourly close, so a single liquidation can be off by that hour&apos;s move.</li>
              <li>Timing says when a loan was liquidated, not when its price first crossed the line: a closed market defers the bill, it does not cancel it.</li>
            </ul>
          </section>

          <section className={`${a.panel} ${a.span12}`} aria-label="Backtest">
            <div className={a.ph}>
              <div>
                <h2>Backtest: the same closures, with and without a shield</h2>
                <p className={a.sub}>
                  {worst.windows} closures of the twelve listed stocks replayed on a market with a {pct(BACKTEST.lltv)} liquidation LTV. With the shield, the keeper repays before each close until the loan survives that stock&apos;s worst-1% gap at a
                  health factor of {BACKTEST.targetHfAfterGap}.
                </p>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={`${a.table} ${s.nums}`}>
                <thead>
                  <tr>
                    <th scope="col">Starting LTV</th>
                    <th scope="col">Closures</th>
                    <th scope="col">Liquidated, no shield</th>
                    <th scope="col">Liquidated, shielded</th>
                    <th scope="col">Shield acted in</th>
                    <th scope="col">Average repay</th>
                    {BACKTEST_TYPES.map(([k, name]) => (
                      <th key={k} scope="col">
                        {name}: no shield / shielded
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {BACKTEST.results.map((r) => (
                    <tr key={r.startLtv}>
                      <th scope="row">{pct(r.startLtv)}</th>
                      <td>{r.windows}</td>
                      <td>{r.unprotectedLiquidations}</td>
                      <td>{r.protectedLiquidations}</td>
                      <td>
                        {r.shieldsTriggered} of {r.windows}
                      </td>
                      <td>{r.shieldsTriggered ? `${share(r.avgRepayShareOfDebt)} of the debt` : "none"}</td>
                      {BACKTEST_TYPES.map(([k]) => (
                        <td key={k}>{r.byType[k] ? `${r.byType[k].unprotected} / ${r.byType[k].protected} of ${r.byType[k].windows}` : "none"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.prose}>
              <h3>Assumptions to read before quoting it</h3>
              <ul>
                <li>The cushion is assumed large enough to fund every shield, and collateral is never sold.</li>
                <li>No venue minimum loan is applied.</li>
                <li>The data has no earnings flag, so earnings nights are tested against the smaller ordinary buffer. The liquidations that remain with the shield are moves beyond that buffer.</li>
                <li>The bStock&apos;s premium to its underlying and any oracle lag are ignored: the worst move is taken straight from the closure&apos;s gap and its lowest hourly print.</li>
                <li>One sample of about three months, twelve stocks. A buffer set at the worst 1% is, by construction, exceeded about one time in a hundred.</li>
              </ul>
            </div>
          </section>

          <section className={`${a.panel} ${a.span12}`} aria-label="Gap buffers">
            <div className={a.ph}>
              <div>
                <h2>The gap each stock is sized for</h2>
                <p className={a.sub}>The worst 1% of close-to-open down-gaps per stock and kind of closure, as set on the Session Oracle. Shields are sized against them and the feed&apos;s band starts from them.</p>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={`${a.table} ${s.nums}`}>
                <thead>
                  <tr>
                    <th scope="col">Stock</th>
                    <th scope="col">Overnight</th>
                    <th scope="col">Weekend</th>
                    <th scope="col">Holiday</th>
                    <th scope="col">Earnings</th>
                  </tr>
                </thead>
                <tbody>
                  {GAP_TABLE.map((g) => (
                    <tr key={g.symbol}>
                      <th scope="row">{g.symbol}</th>
                      <td>{pctBps(g.overnight, 2)}</td>
                      <td>{pctBps(g.weekend, 2)}</td>
                      <td>{pctBps(g.holiday, 2)}</td>
                      <td>{g.earnings > 0 ? pctBps(g.earnings, 2) : "no earnings"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={`${a.panel} ${a.span12} ${s.prose}`} aria-label="Reproduce">
            <div className={a.ph}>
              <div>
                <h2>Reproduce it</h2>
                <p className={a.sub}>The data files are in the repository. Nothing below needs a key.</p>
              </div>
            </div>
            <dl className={s.cmds}>
              <div>
                <dt>
                  <code>python research/check_figures.py</code>
                </dt>
                <dd>Recomputes every published figure from the raw data and reports how many match. The study, its scripts and its method are described in research/README.md.</dd>
              </div>
              <div>
                <dt>
                  <code>pnpm backtest</code>
                </dt>
                <dd>Replays data/closure-windows.json through the same planner the keeper runs and rewrites data/backtest-lltv75.json, the table above.</dd>
              </div>
              <div>
                <dt>
                  <code>pnpm --filter @ballast/web test</code>
                </dt>
                <dd>Checks that every figure on this page and on the front page is the one computed from data/liquidations-week.json and the calendar.</dd>
              </div>
            </dl>
            <p className={a.faint}>Files: data/liquidations-week.json, data/closure-windows.json, data/backtest-lltv75.json, config/bsc-mainnet.json, config/nyse-calendar.json. Their fields and sources are listed in data/README.md.</p>
          </section>
        </div>
        <div className={a.foot}>
          <span>
            Liquidations: Lista Moolah on BNB Chain, {first} to {last}. Closures: Binance hourly bars and daily bars of the underlying stocks.
          </span>
          <span>Ballast</span>
        </div>
      </main>
    </div>
  );
}
