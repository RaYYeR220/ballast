/* Desk feed events and the account's plan as watch-log rows, refusal rows and wheel marks. Pure functions. */
import { formatUnits } from "viem";
import type { DeskEvent } from "./desk";
import type { AccountView } from "./views";

/** The keeper shields this long before a regular close (the desk's lead time). */
export const KEEPER_LEAD_SEC = 3600;

export type RowKind = "shield" | "restore" | "refused" | "alert" | "noop" | "publish" | "other";

export interface LogRow {
  key: string;
  ts: number;
  kind: RowKind;
  planned: boolean;
  title: string;
  text: string;
  txHash?: string;
  /** right-hand status when there is no transaction: "planned", "dry run", "not sent" */
  status?: string;
}

export interface Units {
  decimals: number;
  symbol: string;
}

const DEFAULT_UNITS: Units = { decimals: 18, symbol: "" };

function amount(raw: unknown, u: Units): string | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const n = Number(formatUnits(BigInt(raw), u.decimals));
  const txt = n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });
  return u.symbol ? `${txt} ${u.symbol}` : txt;
}

function stepOf(e: DeskEvent): Record<string, unknown> | null {
  const st = e.plan?.step;
  return st && typeof st === "object" ? (st as Record<string, unknown>) : null;
}

const ACTION: Record<string, string> = {
  shieldRepay: "Shield",
  shieldDeleverage: "Shield",
  shieldFor: "Cover shield",
  restore: "Restore",
};

/** desk events that are not shields or restores: guardian jobs, paid data, findings */
const OTHER_TITLE: Record<string, string> = {
  submit: "Guard evidence submitted",
  settle: "Guard job settled",
  payment: "Paid for data",
  finding: "Finding",
  pending: "Pending",
};

export function windowWord(kind: string | undefined): string {
  switch (kind) {
    case "OVERNIGHT":
      return "tonight";
    case "WEEKEND":
      return "the weekend";
    case "HOLIDAY":
      return "the holiday";
    case "EARNINGS":
      return "the earnings gap";
    default:
      return "the close";
  }
}

export function eventRow(e: DeskEvent, u: Units = DEFAULT_UNITS): LogRow {
  const st = stepOf(e);
  const fn = typeof st?.fn === "string" ? st.fn : "";
  const repaid = amount(st?.assets ?? st?.repayAssets ?? st?.amount, u);
  const base = { key: `e${e.seq}-${e.ts}`, ts: e.ts, planned: false, txHash: e.txHash };
  const notSent = e.txHash ? undefined : e.dryRun ? "dry run" : "not sent";
  const forWindow = e.window ? ` for ${windowWord(e.window.kind)}` : "";
  switch (e.kind) {
    case "shield": {
      const sale = fn === "shieldDeleverage" && typeof st?.collateralToSell === "string" ? ", sold collateral through the fixed route" : "";
      const what = repaid ? `repaid ${repaid}${u.symbol ? "" : " of the loan"}${sale}` : "repaid from the cushion";
      const who = e.cover ? "Cover shield" : "Shield";
      if (e.txHash) return { ...base, kind: "shield", title: `${who}ed${forWindow}`, text: what };
      return { ...base, kind: "shield", title: e.dryRun ? `${who} simulated${forWindow}` : `${who} attempted${forWindow}`, text: e.dryRun ? `would have ${what}` : e.reason ?? what, status: notSent };
    }
    case "restore": {
      const what = repaid ? `borrowed ${repaid} back` : "borrowed back toward the day size";
      if (e.txHash) return { ...base, kind: "restore", title: "Restored", text: what };
      return { ...base, kind: "restore", title: e.dryRun ? "Restore simulated" : "Restore attempted", text: e.dryRun ? `would have ${what}` : e.reason ?? what, status: notSent };
    }
    case "refused": {
      const action = ACTION[fn] ?? "Call";
      const why = e.error?.message ?? e.reason ?? "the contract refused it";
      return { ...base, kind: "refused", title: `${action} refused`, text: why, status: notSent };
    }
    case "alert":
      return { ...base, kind: "alert", title: "Alert", text: e.reason ?? e.error?.message ?? "the desk raised an alert", status: e.txHash ? undefined : "" };
    case "noop":
      return { ...base, kind: "noop", title: "Checked", text: e.reason ?? "nothing to do", status: "" };
    case "publish": {
      const n = e.symbols?.length ?? 0;
      return { ...base, kind: "publish", title: "Session Oracle overlays posted", text: n > 0 ? `for ${n} ${n === 1 ? "stock" : "stocks"}` : "", status: notSent };
    }
    default: {
      const title = OTHER_TITLE[e.kind] ?? e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
      return { ...base, kind: "other", title, text: e.reason ?? e.error?.message ?? "", status: e.txHash ? undefined : "" };
    }
  }
}

const big = (s: string) => BigInt(s);

/** Collateral value in the venue's unit of account (USD), or null when unpriced. */
export function collateralValue(v: Pick<AccountView, "collateral" | "collateralDecimals" | "priceUsd">): number | null {
  if (v.priceUsd === null) return null;
  return Number(formatUnits(big(v.collateral), v.collateralDecimals)) * v.priceUsd;
}

/** What the desk will do next for this account, from its plan and the calendar. */
export function plannedRows(v: AccountView, now: number, events: readonly DeskEvent[]): LogRow[] {
  const rows: LogRow[] = [];
  const c = v.coming;
  if (!c || v.liquidated) return rows;
  const units = { decimals: v.loanDecimals, symbol: v.loanSymbol };
  const word = windowWord(c.window);
  const gapPct = `${(c.gapBps / 100).toFixed(1)}%`;
  if (!c.inProgress && big(v.debt) > 0n && v.plan && v.plan.mode === "shield") {
    const at = Math.max(now, c.startsAt - KEEPER_LEAD_SEC);
    const p = v.plan;
    if (p.kind === "noop") {
      rows.push({ key: "plan-shield", ts: at, kind: "shield", planned: true, title: `No shield needed for ${word}`, text: `the loan survives a ${gapPct} gap`, status: "planned" });
    } else {
      const repay = p.steps.find((s) => s.fn === "shieldRepay" || s.fn === "shieldDeleverage");
      const raw = repay?.assets ?? repay?.repayAssets;
      const repayTxt = amount(raw, units);
      const value = collateralValue(v);
      let target = "";
      if (raw && value && value > 0) {
        const debtAfter = Number(formatUnits(big(v.debt) - BigInt(raw) > 0n ? big(v.debt) - BigInt(raw) : 0n, v.loanDecimals)) * (v.loanPriceUsd ?? 1);
        target = ` to reach ${((debtAfter / value) * 100).toFixed(1)}%`;
      }
      const text =
        p.kind === "insufficient"
          ? `the cushion is short of what a ${gapPct} gap needs${repayTxt ? `: repay ${repayTxt} and top it up` : ": top it up"}`
          : `${repayTxt ? `repay about ${repayTxt}` : "repay from the cushion"}${target}${p.kind === "repay+deleverage" ? ", then sell collateral through the fixed route" : ""}`;
      rows.push({ key: "plan-shield", ts: at, kind: "shield", planned: true, title: `Shield for ${word}`, text, status: "planned" });
    }
  }
  const lastSent = events.find((e) => e.txHash && (e.kind === "shield" || e.kind === "restore"));
  if (v.mandate.autoRestore && lastSent?.kind === "shield" && v.oracle) {
    rows.push({
      key: "plan-restore",
      ts: c.endsAt + v.oracle.restoreDelay,
      kind: "restore",
      planned: true,
      title: "Restore",
      text: "toward the day size once the market is open and the oracle allows it",
      status: "planned",
    });
  }
  return rows.sort((a, b) => b.ts - a.ts);
}

export interface RefusalRow {
  key: string;
  ts: number;
  call: string;
  from: string;
  reason: string;
  message: string;
  txHash?: string;
}

export function refusalRows(events: readonly DeskEvent[], u: Units = DEFAULT_UNITS): RefusalRow[] {
  return events
    .filter((e) => e.kind === "refused")
    .map((e) => {
      const st = stepOf(e);
      const fn = typeof st?.fn === "string" ? st.fn : "call";
      const amt = amount(st?.assets ?? st?.repayAssets ?? st?.amount, u);
      return {
        key: `r${e.seq}-${e.ts}`,
        ts: e.ts,
        call: `${fn}(${amt ?? ""})`,
        from: e.source === "keeper" ? "from the desk agent" : e.source ? `from the ${e.source}` : "",
        reason: e.error?.reason ? `${e.error.name}(${e.error.reason})` : (e.error?.name ?? "Refused"),
        message: e.error?.message ?? e.reason ?? "",
        txHash: e.txHash,
      };
    });
}
