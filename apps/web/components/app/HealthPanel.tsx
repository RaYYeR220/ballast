/* Loan health, now and after the coming gap: LTV now, LTV if the stock opens a worst-1% gap lower, the room left
   before liquidation, the load gauge and the position facts. Every figure is read from the chain. */
import { nextWindow, tickers } from "@ballast/risk";
import type { Address } from "viem";
import { sameAddr } from "@/lib/desk";
import { collateralValue, windowWord } from "@/lib/feed-rows";
import { nyWeekdayClock, shortHex, units, usd } from "@/lib/format";
import type { AccountView } from "@/lib/views";
import { WalletControl } from "./WalletControl";
import { Gauge, type GaugeMark } from "./Gauge";
import s from "./app.module.css";

export type HealthContent =
  | { kind: "disconnected" }
  | { kind: "wrong-chain"; chainName: string }
  | { kind: "not-deployed"; broken: boolean }
  | { kind: "loading" }
  | { kind: "unavailable"; detail: string }
  | { kind: "none" }
  | { kind: "account"; view: AccountView; deskAgent: Address | null; shielded: boolean };

const after = (ltv: number, gapBps: number) => ltv / (1 - gapBps / 10_000);

/**
 * `shielded`: the desk's last transaction on this loan was a shield (and no restore since). Only then does the
 * tag say "Shielded"; a loan that survives the gap without one is "Ready for the gap".
 */
export function healthStatus(v: AccountView, shielded = false): { text: string; tone: "ok" | "no" | "" } {
  if (v.liquidated) return { text: "Liquidated", tone: "no" };
  if (BigInt(v.debt) === 0n) return { text: "No debt", tone: "" };
  if (v.ltvBps === null) return { text: v.ltvUnbounded ? "Collateral worthless" : "Price unavailable", tone: "no" };
  if (!v.plan) return { text: "No plan", tone: "" };
  if (v.plan.kind === "noop") {
    if (!v.plan.reason?.startsWith("survives")) return { text: "Watching", tone: "" };
    return { text: shielded ? "Shielded" : "Ready for the gap", tone: "ok" };
  }
  if (v.plan.kind === "insufficient") return { text: "Cushion too small", tone: "no" };
  return { text: v.coming?.inProgress ? "Under target" : "Shield due", tone: "no" };
}

export function comingSentence(v: AccountView): string {
  const c = v.coming;
  if (!c) return v.oracleError ? "The Session Oracle could not be read, so the coming gap is unknown." : "No closure is known ahead, so there is no gap to size for.";
  const gap = `${(c.gapBps / 100).toFixed(1)}%`;
  if (c.inProgress) {
    const closed: Record<string, string> = {
      OVERNIGHT: "New York is closed overnight.",
      WEEKEND: "New York is closed for the weekend.",
      HOLIDAY: "New York is closed for a holiday.",
      EARNINGS: "New York is closed and an earnings report lands before the open.",
    };
    return `${closed[c.window] ?? "New York is closed."} Ballast sizes the loan for the worst 1% gap at the open: ${gap}.`;
  }
  const lead: Record<string, string> = {
    OVERNIGHT: "Tonight is an overnight window.",
    WEEKEND: "The next closure is the weekend.",
    HOLIDAY: "The next closure is a holiday.",
    EARNINGS: "The next closure carries an earnings report.",
  };
  return `${lead[c.window] ?? "A closure is ahead."} Ballast sizes the loan for its worst 1% gap: ${gap}.`;
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={s.empty}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

const WINDOW_NAME: Record<string, string> = { OVERNIGHT: "an overnight window", WEEKEND: "the weekend", HOLIDAY: "a holiday closure" };
const GAP_KEY = { OVERNIGHT: "overnight", WEEKEND: "weekend", HOLIDAY: "holiday" } as const;

/** The next closure from the NYSE calendar and each listed stock's measured worst-1% gap for it (config). */
export function ComingClosure({ now }: { now: number | null }) {
  if (now === null) return null;
  const w = nextWindow(now);
  if (w.type === "NONE") return null;
  const hours = (w.endsAt - w.startsAt) / 3600;
  const key = GAP_KEY[w.type];
  return (
    <div className={s.empty}>
      <h3>The coming closure</h3>
      <p>
        {nyWeekdayClock(w.startsAt)} to {nyWeekdayClock(w.endsAt)}, {WINDOW_NAME[w.type]} of {hours.toFixed(1)} hours. Ballast sizes each loan for its stock&apos;s worst 1% gap over
        such a window:
      </p>
      <p className={s.gaps}>
        {tickers.map((t) => (
          <span key={t.symbol} className={s.tag}>
            {t.symbol} {(t.gapBps[key] / 100).toFixed(1)}%
          </span>
        ))}
      </p>
      <p>An earnings report inside the window raises that stock&apos;s gap; the Session Oracle applies it on chain.</p>
    </div>
  );
}

function AccountHealth({ v, deskAgent, shielded }: { v: AccountView; deskAgent: Address | null; shielded: boolean }) {
  const st = healthStatus(v, shielded);
  const ltv = v.ltvBps === null ? null : v.ltvBps / 100;
  const lltv = v.lltvBps / 100;
  const c = v.coming;
  const afterGap = v.ltvAfterGapBps === null ? null : v.ltvAfterGapBps / 100;
  const room = afterGap === null ? null : lltv - afterGap;
  const value = collateralValue(v);
  const word = c ? windowWord(c.window) : "";
  // without debt no gap moves the loan: the gauge shows the empty bar and "now" only
  const noDebt = BigInt(v.debt) === 0n;
  const scenarios: GaugeMark[] = [];
  if (ltv !== null && v.gaps && !noDebt) {
    if (c?.window !== "WEEKEND") scenarios.push({ value: after(ltv, v.gaps.weekend), label: "weekend gap", short: "weekend" });
    if (v.gaps.earnings > 0 && c?.window !== "EARNINGS") scenarios.push({ value: after(ltv, v.gaps.earnings), label: "earnings gap", short: "earnings" });
  }
  const keptByDesk = sameAddr(v.keeper, deskAgent);
  const aria =
    ltv === null
      ? "Load gauge unavailable: the venue cannot price the collateral right now."
      : `Load gauge of loan to value. Now ${ltv.toFixed(1)}%.${afterGap !== null && !noDebt ? ` After a ${((c?.gapBps ?? 0) / 100).toFixed(1)}% gap ${afterGap.toFixed(1)}%.` : ""}${scenarios
          .map((m) => ` After the ${m.label} ${m.value.toFixed(1)}%.`)
          .join("")} Shield LTV ${(v.mandate.shieldLtvBps / 100).toFixed(0)}%. Liquidation at ${lltv.toFixed(0)}%.`;
  return (
    <>
      <div className={s.ph}>
        <div>
          <h2>Loan health, now and after the coming gap</h2>
          <p className={s.sub}>{comingSentence(v)}</p>
        </div>
        <span className={`${s.tag} ${st.tone === "ok" ? s.ok : st.tone === "no" ? s.no : ""}`}>{st.text}</span>
      </div>
      <div className={s.nums}>
        <div>
          <small>Loan to value now</small>
          <span className={s.big}>{ltv === null ? "n/a" : `${ltv.toFixed(1)}%`}</span>
        </div>
        <div>
          <small>{c ? `If ${v.collateralSymbol} opens ${(c.gapBps / 100).toFixed(1)}% lower` : "After the coming gap"}</small>
          <span className={`${s.big} ${s.ghost}`}>{afterGap === null ? "n/a" : `${afterGap.toFixed(1)}%`}</span>
        </div>
        <div>
          <small>Room left after that gap</small>
          <span className={s.big} style={room !== null && room <= 0 ? { color: "var(--ember)" } : undefined}>
            {room === null ? "n/a" : `${room.toFixed(1)} pts`}
          </span>
        </div>
      </div>
      {ltv === null ? (
        <p className={s.muted}>The venue cannot price the collateral right now, so the gauge is not drawn. Nothing on this page guesses the price.</p>
      ) : (
        <Gauge
          now={ltv}
          after={afterGap === null || noDebt ? null : { value: afterGap, label: c?.inProgress ? "at the open" : `after ${word}`, short: c?.inProgress ? "at open" : word }}
          scenarios={scenarios}
          shield={v.mandate.shieldLtvBps / 100}
          lltv={lltv}
          label={aria}
        />
      )}
      <div className={s.facts}>
        <div>
          <small>Collateral</small>
          <b>
            {units(v.collateral, v.collateralDecimals, 4)} {v.collateralSymbol}
          </b>
          <br />
          <span className={s.muted}>{value !== null && v.priceUsd !== null ? `${usd(value)} at ${usd(v.priceUsd, 2)}` : "price unavailable"}</span>
        </div>
        <div>
          <small>Borrowed</small>
          <b>
            {units(v.debt, v.loanDecimals)} {v.loanSymbol}
          </b>
          <br />
          <span className={s.muted}>
            cushion {units(v.cushion, v.loanDecimals)} {v.loanSymbol}
          </span>
        </div>
        <div>
          <small>Market</small>
          <b>
            {v.venue === "lista" ? "Lista" : "Venus"} {v.collateralSymbol} / {v.loanSymbol}
          </b>
          <br />
          <span className={s.muted}>liquidation at {lltv.toFixed(0)}%</span>
        </div>
        <div>
          <small>Mandate</small>
          <b>
            max {(v.mandate.maxLtvBps / 100).toFixed(0)}%, shield {(v.mandate.shieldLtvBps / 100).toFixed(0)}%
          </b>
          <br />
          <span className={s.muted}>
            keeper {keptByDesk ? "Ballast desk" : shortHex(v.keeper)}, auto-restore {v.mandate.autoRestore ? "on" : "off"}
            {v.lista && !v.lista.deleveragePathSet ? ", no sale route" : ""}
          </span>
        </div>
      </div>
    </>
  );
}

export function HealthPanel({ content, chainName, now }: { content: HealthContent; chainName: string; now: number | null }) {
  return (
    <section className={`${s.panel} ${s.span7}`} aria-label="Loan health">
      {content.kind === "account" ? (
        <AccountHealth v={content.view} deskAgent={content.deskAgent} shielded={content.shielded} />
      ) : (
        <>
          <div className={s.ph}>
            <div>
              <h2>Loan health, now and after the coming gap</h2>
              <p className={s.sub}>Loan to value now, and what the next closure could do to it.</p>
            </div>
          </div>
          {content.kind === "disconnected" && (
            <Empty title="Connect a wallet to see your loan">
              <p>Your credit lines and covers are read from {chainName} for the connected address. Nothing is sent without a simulation first and your confirmation in the wallet.</p>
              <div className={s.actions}>
                <WalletControl align="left" look="button" />
              </div>
            </Empty>
          )}
          {content.kind === "wrong-chain" && (
            <Empty title={`Switch your wallet to ${content.chainName}`}>
              <p>Ballast runs on {content.chainName}. Your wallet is on another network, so nothing can be read or sent for it here.</p>
            </Empty>
          )}
          {content.kind === "not-deployed" && (
            <Empty title={content.broken ? "The deployment record could not be read" : "Ballast contracts are not deployed yet"}>
              <p>
                {content.broken
                  ? `This site cannot tell which Ballast contracts to use on ${chainName}, so it reads and sends nothing for them.`
                  : `Credit lines and covers open here once the contracts are live on ${chainName}.`}
              </p>
              <p>The wheel, the market calendar and the desk log work without them.</p>
            </Empty>
          )}
          {content.kind === "loading" && (
            <Empty title="Reading your accounts">
              <p>Loading your credit lines and covers from {chainName}.</p>
            </Empty>
          )}
          {content.kind === "unavailable" && (
            <Empty title="Your accounts could not be read">
              <p>{content.detail}. Nothing is shown until the chain answers again.</p>
            </Empty>
          )}
          {content.kind === "none" && (
            <Empty title="No credit line yet">
              <p>Open one below: pick a market, keep the default mandate or adjust it, and the desk agent keeps watch before every close.</p>
              <div className={s.actions}>
                <a className={s.btnGhost} href="#manage">
                  Open a credit line
                </a>
              </div>
            </Empty>
          )}
          <ComingClosure now={now} />
        </>
      )}
    </section>
  );
}
