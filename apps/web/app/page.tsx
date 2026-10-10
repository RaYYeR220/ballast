import Link from "next/link";
import { ClosingSky } from "@/components/landing/ClosingSky";
import { EvidenceSky } from "@/components/landing/EvidenceSky";
import { HeroDial } from "@/components/landing/HeroDial";
import { MiniSky } from "@/components/landing/MiniSky";
import { DayArc, GapBars, GuardianSeal, OracleBand, SessionLegend, SessionShares } from "@/components/landing/charts";
import { bandExamples } from "@/lib/band";
import { SAMPLE_CLOCK, WEEK } from "@/lib/clock";
import { FACTS, kUsd, pct } from "@/lib/liquidations";
import { LINKS } from "@/lib/links";
import s from "./landing.module.css";

const APP = "/app";
const BAND_SYMBOL = "NVDA";
const BAND = bandExamples(BAND_SYMBOL);

function FootLink({ href, children }: { href: string | null; children: string }) {
  return href ? (
    <a href={href}>{children}</a>
  ) : (
    <span className={s.pending} title="Published with the mainnet deployment">
      {children}
    </span>
  );
}

const JOBS = [
  { id: 4127, sym: "NVDAB", what: "through the weekend", when: "Fri 16:00 to Mon 11:00", gap: "5.5%", escrow: "6.00 USD1", check: "Mon 11:00", ok: true, out: "Survived, fee released to guardian" },
  { id: 4131, sym: "TSLAB", what: "across earnings", when: "Wed 16:00 to Thu 11:00", gap: "17.9%", escrow: "9.50 USD1", check: "Thu 11:00", ok: true, out: "Survived, fee released to guardian" },
  { id: 4134, sym: "SPYB", what: "overnight", when: "Tue 16:00 to Wed 11:00", gap: "4.4%", escrow: "2.00 USD1", check: "Wed 11:00", ok: false, out: "Liquidated at 09:41, fee refunded to borrower" },
] as const;

const LIMITS = [
  ["It sizes for the 99th percentile, not the worst case", "One closure in a hundred gaps further than the band. Earnings gaps reach 17.9%, and a loan shielded for 4.4% won't survive one if the earnings date is missed."],
  ["It doesn't stop Lista or Venus", "The contract limits what the agent can do with your loan. It does not limit you, and liquidations are still run by the lending market's own rules and prices."],
  ["Shielding has a cost", "A smaller loan overnight means less borrowed for those hours. Restoring needs a transaction after the open, and prices may have moved by then."],
  ["The evidence is young", `Three months of one lending market: ${FACTS.total} liquidations, ${FACTS.organic} of them from real borrowers. Venus seized no bStock collateral in the same period. We will keep publishing as the sample grows.`],
  ["The oracle band is a rule, not a forecast", "It starts from p99 gaps measured over 6.3 years of the underlying stocks and widens on a fixed schedule. It is not a guarantee, and it says so on every reading."],
  ["This is new code", "Ballast's contracts have not been audited yet. Start with an amount you are prepared to lose."],
] as const;

export default function Landing() {
  return (
    <div className={s.landing}>
      <header className={s.top} data-sky="day">
        <div className={s.wrap}>
          <Link className={s.mark} href="/">
            Ballast
          </Link>
          <nav aria-label="Sections">
            <a href="#evidence">Evidence</a>
            <a href="#how">How it works</a>
            <a href="#oracle">Session Oracle</a>
            <a href="#guardians">Guardians</a>
            <a href="#limits">Limits</a>
          </nav>
        </div>
      </header>

      <main>
        <section className={s.hero} data-sky="day" id="hero">
          <svg className={s.grain} aria-hidden="true">
            <filter id="pg">
              <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves={3} />
              <feColorMatrix values="0 0 0 0 .45 0 0 0 0 .4 0 0 0 0 .3 0 0 0 .22 0" />
            </filter>
            <rect width="100%" height="100%" filter="url(#pg)" />
          </svg>
          <div className={s.wrap}>
            <div className={s.copy}>
              <h1>Wall Street sleeps {pct(WEEK.closedShare)} of the week. Ballast keeps the watch.</h1>
              <p>
                A credit line on your tokenized stocks. Before every close, an agent moves your loan into a state that survives the gap. While the
                market is shut, a contract on BNB Chain lets it only reduce risk.
              </p>
              <Link className={s.cta} href={APP}>
                Open a credit line
              </Link>
              <p className={`${s.how} ${s.serifI}`}>
                Turn the wheel to any hour. Each star is a Lista liquidation between 18 June and 22 September; hollow rings are tripwire tests. The
                further out, the more dollars. The weekend sky is empty.
              </p>
            </div>
            <HeroDial className={s.finder} svgClassName={s.finderSvg} readoutClassName={s.read} hintClassName={s.finderHint} />
          </div>
        </section>

        <section className={`${s.sec} ${s.ev}`} id="evidence">
          <div className={s.wrap}>
            <h2>Where the money is actually lost</h2>
            <p className={s.lede}>
              We read every Liquidate event on Lista&apos;s bStock markets from 18 June to 22 September 2026: {FACTS.total} in all. The risk builds up
              while New York is closed. The money is lost in the first 90 minutes after it opens.
            </p>
            <div className={s.grid}>
              <div className={s.facts}>
                <div className={s.fact}>
                  <b className={s.num}>{pct(FACTS.firstWindowShare)}</b>
                  <span>
                    of the dollars lost by real borrowers were lost in the first 90 minutes after an open. That is {kUsd(FACTS.firstWindowUsd)} of{" "}
                    {kUsd(FACTS.organicUsd)}, across {FACTS.organic} liquidations.
                  </span>
                </div>
                <div className={s.fact}>
                  <b className={s.num}>
                    {FACTS.weekend} of {FACTS.bStockCollateral}
                  </b>
                  <span>
                    bStock-collateral liquidations fell on a weekend, though Friday 8 PM to Sunday 8 PM is {pct(WEEK.weekendShare)} of the clock. The
                    same bots liquidated 12% of non-stock positions on weekends.
                  </span>
                </div>
                <div className={s.fact}>
                  <b className={s.num}>{FACTS.seeds}</b>
                  <span>
                    of the {FACTS.total} came from one tripwire test address with positions of ${Math.round(FACTS.seedMinUsd)} to $
                    {Math.round(FACTS.seedMaxUsd)}. They are drawn as hollow rings: useful as a sensor of when prices crossed the line, not as losses.
                  </span>
                </div>
              </div>
              <EvidenceSky className={s.evsky} />
            </div>
            <div className={s.charts}>
              <div className={s.chart}>
                <h3>The clock and the money don&apos;t line up</h3>
                <p className={s.sub}>
                  Share of the clock each session takes, against its share of liquidated dollars. All {FACTS.bStockCollateral} bStock-collateral
                  liquidations, 18 June to 22 September.
                </p>
                <SessionLegend className={s.legend} />
                <SessionShares clock={SAMPLE_CLOCK} dollars={FACTS.dollarShares} />
              </div>
              <div className={s.chart}>
                <h3>How far prices jump at the reopen</h3>
                <p className={s.sub}>
                  Worst 1% of downward gaps from the close to the next open, 36 names, 6.3 years. Ballast sizes each loan for the gap ahead.
                </p>
                <GapBars />
              </div>
            </div>
            <p className={s.more}>
              <Link href="/evidence">See the full measurement</Link>
            </p>
          </div>
        </section>

        <section className={`${s.sec} ${s.howSec}`} data-sky="day" id="how">
          <div className={s.wrap}>
            <h2>Three moves around every close</h2>
            <p className={s.lede}>The agent works to New York&apos;s clock. The contract decides what it is allowed to do at each hour.</p>
            <DayArc mobile={false} className={`${s.dayarc} ${s.dayarcDesk}`} />
            <DayArc mobile className={`${s.dayarc} ${s.dayarcMob}`} />
            <div className={s.steps}>
              <div className={s.step}>
                <h3>
                  <i>1</i>Shield before the close
                </h3>
                <p>
                  From 3:00 PM New York time the agent repays part of the loan, until it would survive the worst 1% gap for the window ahead: 4.4%
                  overnight, 5.5% over a weekend, 17.9% before earnings.
                </p>
                <p className={s.who}>The agent acts. The contract checks that each move lowers risk.</p>
              </div>
              <div className={s.step}>
                <h3>
                  <i>2</i>Refuse while closed
                </h3>
                <p>
                  From 4:00 PM until the next open, the contract rejects every attempt by the agent to add risk: it cannot restore the loan early,
                  and it can never borrow to itself or move collateral out. Repaying from your cushion still goes through.
                </p>
                <p className={s.who}>Enforced on-chain for the agent. Your own wallet keeps full control of the loan.</p>
              </div>
              <div className={s.step}>
                <h3>
                  <i>3</i>Restore after the open settles
                </h3>
                <p>
                  At 11:00 AM, after the first 90 minutes when most of the money is lost, the agent restores the loan to its size before the
                  shield, if the reference price has caught up.
                </p>
                <p className={s.who}>Only after the session opens. Never during the dark hours.</p>
              </div>
            </div>
          </div>
        </section>

        <section className={`${s.sec} ${s.refuse}`} data-sky="day" id="refusal">
          <div className={s.wrap}>
            <div className={s.grid}>
              <div>
                <h2>What a refusal looks like</h2>
                <p className={s.lede}>
                  Say the agent, or anyone holding its key, tries to restore the full loan on a Saturday afternoon. The transaction reverts and
                  your loan stays at its weekend size; the only cost is the caller&apos;s gas.
                </p>
                <p className={`${s.lede} ${s.ledeSm}`}>
                  Refusals the agent runs into are listed in your dashboard; one that was actually sent links to its reverted transaction.
                </p>
              </div>
              <div className={s.slip} aria-label="Example of a reverted restore transaction" role="group">
                <MiniSky className={s.minisky} />
                <div className={s.hd}>
                  <b>Restore refused</b>
                  <span className={s.example}>Example</span>
                </div>
                <dl>
                  <dt>When</dt>
                  <dd>Saturday 10 Oct, 14:02 New York</dd>
                  <dt>Call</dt>
                  <dd>restore(2,400 USD1)</dd>
                  <dt>Result</dt>
                  <dd>
                    <span className={s.rev}>Reverted: RestoreRefused(NOT_REGULAR)</span>
                    <span className={s.ctx}>next open Mon 12 Oct 09:30 ET</span>
                  </dd>
                  <dt>Loan</dt>
                  <dd>Stays at 41% loan-to-value, ready for a 5.5% gap</dd>
                  <dt>Cost</dt>
                  <dd>0.00004 BNB in gas</dd>
                </dl>
                <div className={s.ft}>
                  <span>Example: no transaction yet</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={`${s.sec} ${s.oracle}`} id="oracle">
          <div className={s.wrap}>
            <h2>The Session Oracle admits what it doesn&apos;t know</h2>
            <p className={s.lede}>
              Over a weekend, the last real New York price gets older by the hour. The Session Oracle publishes a reference price together with how
              far it might be off. That band widens while the market sleeps.
            </p>
            <div className={s.grid}>
              <ol>
                <li>
                  <b>Three venues, one reference</b>Per-share prices from Binance bStocks, Ondo and xStocks, cleaned of share multipliers and blended
                  into one reference.
                </li>
                <li>
                  <b>A band that grows with the dark</b>At the close the band is the stock&apos;s measured p99 gap for the night, weekend or holiday
                  ahead. It widens by that much again for every day the market stays shut, up to three times, and goes back to zero at the open.
                </li>
                <li>
                  <b>The age is shown, never hidden</b>Every reading carries the time since New York&apos;s last close. Ballast sizes your loan for the
                  far edge of the band, not for the middle.
                </li>
                <li>
                  <b>Why it works</b>Across 597 weekends, the Saturday and Sunday bStock price says almost nothing about Monday&apos;s open
                  (R&sup2; at most 0.2) until US overnight venues reopen on Sunday evening. By 09:00 ET Monday it tracks the open with a
                  correlation of 0.97. The dark hours are mostly noise, so Ballast does not let them add risk.
                </li>
              </ol>
              <div>
                <OracleBand examples={BAND} symbol={BAND_SYMBOL} mobile={false} className={`${s.band} ${s.bandDesk}`} />
                <OracleBand examples={BAND} symbol={BAND_SYMBOL} mobile className={`${s.band} ${s.bandMob}`} />
                <p className={`${s.note} ${s.bandNote}`}>
                  The band Ballast enforces on-chain: it starts at the measured p99 gap and widens for every day the market stays shut, up to 3x. Shown
                  for {BAND_SYMBOL}; each stock carries its own measured gaps.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={s.sec} id="guardians">
          <div className={s.wrap}>
            <h2>Guardians are paid only if your loan survives</h2>
            <p className={s.lede}>
              The agent that shields your loan takes it on as a job. Its fee sits in escrow under ERC-8183 and is released only if the loan is still
              standing when the window ends. If the loan is liquidated, the fee goes back to you. Each guardian has an ERC-8004 identity, so its record
              follows it from job to job.
            </p>
            <div className={s.ledger} role="table" aria-label="Example guardian jobs">
              <div className={`${s.lr} ${s.lh}`} role="row">
                <span role="columnheader">Job</span>
                <span role="columnheader">Loan and window</span>
                <span role="columnheader">Gap to survive</span>
                <span role="columnheader">Escrow</span>
                <span role="columnheader">Checked by the Session Oracle</span>
                <span role="columnheader">Outcome</span>
              </div>
              {JOBS.map((j) => (
                <div className={s.lr} role="row" key={j.id}>
                  <span role="cell">{j.id}</span>
                  <span role="cell">
                    <b>{j.sym}</b> {j.what}
                    <br />
                    <small>{j.when}</small>
                  </span>
                  <span role="cell">{j.gap}</span>
                  <span role="cell">{j.escrow}</span>
                  <span role="cell">{j.check}</span>
                  <span role="cell">
                    <i style={{ background: j.ok ? "var(--mint)" : "var(--ember)" }} />
                    {j.out}
                  </span>
                </div>
              ))}
              <p className={`${s.note} ${s.ledgerNote}`}>Example jobs, shown to explain the flow.</p>
            </div>
            <div className={s.idcard}>
              <GuardianSeal />
              <div>
                <h3>
                  Guardian 318 <span className={s.example}>Example</span>
                </h3>
                <p>
                  Registered on the ERC-8004 identity registry. Its outcomes are written to the reputation registry after every window, so you can pick
                  a guardian by its record, not its claims.
                </p>
              </div>
              <div className={s.rep}>
                <b className={s.num}>41 of 42</b>windows survived
              </div>
            </div>
          </div>
        </section>

        <section className={`${s.sec} ${s.limits}`} data-sky="day" id="limits">
          <div className={s.wrap}>
            <h2>What Ballast can&apos;t do</h2>
            <div className={s.grid}>
              {LIMITS.map(([h, p]) => (
                <div className={s.item} key={h}>
                  <h3>{h}</h3>
                  <p>{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={s.close} id="close">
          <ClosingSky className={s.closeSky} />
          <div className={s.wrap}>
            <h2>Borrow through the dark hours</h2>
            <p>Pick a stock, open a credit line, and let the agent take the watch at every close.</p>
            <Link className={s.cta} href={APP}>
              Open a credit line
            </Link>
          </div>
        </section>
      </main>

      <footer className={s.footer}>
        <div className={s.wrap}>
          <div>
            <Link className={`${s.mark} ${s.footMark}`} href="/">
              Ballast
            </Link>
            <p className={s.about}>
              Built on BNB Chain for holders of tokenized US stocks. Data: Lista Moolah Liquidate events on BNB Chain, 18 June to 22 September 2026;
              gaps from daily prices of 36 names over 6.3 years.
            </p>
          </div>
          <div>
            <h3>Product</h3>
            <a href="#how">How it works</a>
            <a href="#oracle">Session Oracle</a>
            <a href="#guardians">Guardians</a>
          </div>
          <div>
            <h3>Proof</h3>
            <Link href="/evidence">Evidence</Link>
            <Link href="/judge">For judges: replay the cycle</Link>
            <FootLink href={LINKS.video}>Watch the demo (3.5 min)</FootLink>
            <FootLink href={LINKS.contracts}>Contracts and transactions</FootLink>
            <FootLink href={LINKS.notebook}>The study: scripts and data</FootLink>
          </div>
          <div>
            <h3>Honesty</h3>
            <a href="#limits">Limits</a>
            <a href="#limits">Audit status</a>
            <FootLink href={LINKS.source}>Source code</FootLink>
          </div>
        </div>
      </footer>
    </div>
  );
}
