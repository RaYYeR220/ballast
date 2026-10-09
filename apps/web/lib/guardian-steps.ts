/* Hiring a guardian for one closure: the window from the NYSE calendar, the checks the guardian contract will
   make (so a doomed job is caught before anything is sent), and the four calls as transaction steps built with
   the SDK. Pure: nothing here reads the chain or signs. */
import { nextClose, nextOpen, session } from "@ballast/risk";
import { kernelAbi, writes, type Deployment } from "@ballast/sdk";
import { parseEventLogs, type Address, type Log } from "viem";
import { nyDayTime } from "./format";
import { amountText, approvalStep, type TxStep } from "./steps";
import type { AccountView } from "./views";

/** BallastGuardian: the shortest window it binds, and how old a start may be when the job is funded. */
export const MIN_WINDOW_SEC = 3600;
export const START_SLACK_SEC = 300;
/** How far ahead the window starts when New York is already closed, so funding lands before it. */
const START_AHEAD_SEC = 600;
/** Time the job stays claimable after the reopen that follows the window (the guardian asks for at least one hour). */
const EXPIRY_GRACE_SEC = 2 * 3600;

export interface GuardWindow {
  start: number;
  end: number;
  expiredAt: number;
  /** the closure the window covers */
  closedAt: number;
  opensAt: number;
}

/**
 * The window a new job covers: from the next close (or from now, during a closure) until the restore delay
 * after the following open, when the keeper may restore and the loan can be judged. Null outside the calendar.
 */
export function guardWindow(now: number, restoreDelaySec = 5400): GuardWindow | null {
  const s = session(now);
  if (s === "UNKNOWN") return null;
  const open = s === "REGULAR";
  const closedAt = open ? nextClose(now) : 0;
  const start = open ? closedAt : now + START_AHEAD_SEC;
  const opensAt = nextOpen(open ? closedAt : now);
  if (!start || !opensAt) return null;
  const end = opensAt + restoreDelaySec;
  const reopen = nextOpen(end);
  if (!reopen) return null;
  return { start, end, expiredAt: reopen + EXPIRY_GRACE_SEC, closedAt: open ? closedAt : now, opensAt };
}

export const windowText = (w: GuardWindow) => `${nyDayTime(w.start)} to ${nyDayTime(w.end)} New York`;

export interface HireInput {
  account: AccountView | null;
  wallet: Address | null;
  /** the guardian's address: owner or agent wallet of its ERC-8004 identity */
  provider: Address | null;
  fee: bigint | null;
  /** BallastGuardian.minBudget, token units */
  minBudget: bigint | null;
  window: GuardWindow | null;
  /** the wallet's balance of the payment token, when known */
  balance?: bigint | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** What would make the guardian contract refuse the job, in the order a person can fix it. Empty when none. */
export function hireProblems(i: HireInput): string[] {
  const out: string[] = [];
  if (!i.wallet) out.push("Connect the wallet that owns the credit line.");
  if (!i.account) out.push("Pick the credit line to guard.");
  else {
    if (i.wallet && !same(i.account.owner, i.wallet)) out.push("Only the owner of the credit line can post a job for it.");
    if (BigInt(i.account.debt) === 0n) out.push("This credit line has no debt: there is nothing to guard.");
    if (i.account.liquidated) out.push("This credit line was liquidated; the guardian contract does not bind a job to it.");
  }
  if (!i.provider) out.push("The guardian's address is not known, so the job cannot name it.");
  else if (i.wallet && same(i.provider, i.wallet)) out.push("A borrower cannot hire itself: the guardian must be another address.");
  if (i.fee === null) out.push("Enter the fee.");
  else {
    if (i.minBudget !== null && i.fee < i.minBudget) out.push(`The fee is below the guardian's minimum of ${amountText(i.minBudget, i.account?.loanDecimals ?? 18, i.account?.loanSymbol ?? "tokens")}.`);
    if (i.balance !== undefined && i.balance !== null && i.fee > i.balance) out.push("The wallet holds less than the fee.");
  }
  if (!i.window) out.push("The calendar does not cover the coming closure.");
  else if (i.window.end < i.window.start + MIN_WINDOW_SEC) out.push("The window is shorter than the one hour the guardian contract accepts.");
  return out;
}

/** Step 1: the job on the ERC-8183 kernel, with the Ballast guardian as its evaluator and hook. */
export function createJobStep(d: Deployment, o: { provider: Address; token: Address; tokenSymbol: string; window: GuardWindow; symbol: string }): TxStep {
  return {
    key: "create-job",
    title: "Post the job",
    detail: `Creates an ERC-8183 job that names the guardian, with the Ballast guardian contract as evaluator. It expires ${nyDayTime(o.window.expiredAt)} New York if nobody settles it; an expired job refunds you.`,
    call: `createJobWithToken(guardian, evaluator BallastGuardian, ${o.tokenSymbol})`,
    tx: writes.createJobWithToken(d, { provider: o.provider, expiredAt: o.window.expiredAt, description: `guard my ${o.symbol} loan through the coming closure`, token: o.token }),
  };
}

/** Steps 2 to 4: the fee, the approval the kernel needs to take it, and funding with the terms. */
export function fundSteps(
  d: Deployment,
  o: { jobId: bigint; fee: bigint; token: Address; tokenSymbol: string; tokenDecimals: number; allowance: bigint; account: Address; agentId: bigint; window: GuardWindow },
): TxStep[] {
  const fee = amountText(o.fee, o.tokenDecimals, o.tokenSymbol);
  return [
    { key: "set-budget", title: `Set the fee to ${fee}`, call: `setBudget(job ${o.jobId}, ${fee})`, tx: writes.setBudget(d, o.jobId, o.fee) },
    ...approvalStep({ token: o.token, symbol: o.tokenSymbol, decimals: o.tokenDecimals, spender: d.external.kernel, spenderName: "the job escrow", amount: o.fee, allowance: o.allowance }),
    {
      key: "fund",
      title: "Fund the job with its terms",
      detail: `Moves ${fee} into escrow and binds the terms: this credit line, ${windowText(o.window)}, guardian ${o.agentId}. The guardian is paid only if the loan is not liquidated and is healthy when the window ends; otherwise the fee returns to you.`,
      call: `fund(job ${o.jobId}, ${fee}, terms)`,
      tx: writes.fund(d, { jobId: o.jobId, expectedBudget: o.fee, terms: { account: o.account, start: o.window.start, end: o.window.end, agentId: o.agentId } }),
    },
  ];
}

/** The id of the job a createJobWithToken receipt created, or null. */
export function jobIdFromLogs(logs: readonly Log[], kernel: Address): bigint | null {
  const own = logs.filter((l) => same(l.address, kernel));
  const ev = parseEventLogs({ abi: kernelAbi, eventName: "JobCreated", logs: own as Log[] })[0];
  return ev ? (ev.args as { jobId: bigint }).jobId : null;
}
