/* The guardian board's data as the page reads it: ERC-8183 jobs whose evaluator is the Ballast guardian, the
   desk's ERC-8004 identity and what the reputation registry holds for it. Pure and client-safe. */
import type { IdentityView } from "./identity";

export type JobStatus = "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";

export interface JobView {
  id: string;
  client: string;
  provider: string;
  description: string;
  /** escrowed amount in the payment token's smallest unit */
  budget: string;
  /** the job's payment token; null when it could not be read */
  token: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  status: JobStatus;
  expiredAt: number;
  submittedAt: number;
  deliverable: string;
  /** bound when the job was funded; null while it is not */
  terms: { account: string; start: number; end: number; agentId: string; settled: boolean } | null;
}

export interface ReputationView {
  /** addresses that have rated the agent, as the registry lists them; null when unreadable */
  clients: number | null;
  /** feedback the Ballast guardian wrote under its own tags; null before it wrote any or when unreadable */
  guard: { count: number; average: number } | null;
  error?: string;
}

export type GuardiansBody =
  | {
      status: "ok";
      chainId: number;
      blockNumber: string;
      /** unix seconds of that block */
      at: number;
      guardian: string;
      kernel: string;
      /** smallest escrow the guardian accepts, in 18-decimal token units; null when unreadable */
      minBudget: string | null;
      /** job ids looked at so far and the kernel's newest id: the scan walks forward a bounded number per answer */
      scan: { from: string; cursor: string; head: string; complete: boolean };
      jobs: JobView[];
      identity: IdentityView;
      reputation: ReputationView;
    }
  | { status: "not-deployed"; detail: string; identity?: IdentityView; reputation?: ReputationView }
  | { status: "unavailable"; detail: string };

export type JobTone = "live" | "ok" | "no" | "idle";

/** What a job is doing at `now`, in the board's words. */
export function jobState(j: Pick<JobView, "status" | "terms" | "expiredAt">, now: number): { label: string; tone: JobTone } {
  switch (j.status) {
    case "Open":
      return { label: "Posted, not funded", tone: "idle" };
    case "Funded":
      if (!j.terms) return { label: "Funded", tone: "idle" };
      if (now >= j.expiredAt) return { label: "Expired, refund claimable", tone: "no" };
      if (now < j.terms.start) return { label: "Funded, window ahead", tone: "idle" };
      if (now < j.terms.end) return { label: "In window", tone: "live" };
      return { label: "Window over, evidence due", tone: "idle" };
    case "Submitted":
      return { label: "Evidence in, awaiting settle", tone: "idle" };
    case "Completed":
      return { label: "Survived, paid", tone: "ok" };
    case "Rejected":
      return { label: "Not survived, refunded", tone: "no" };
    case "Expired":
      return { label: "Expired, refunded", tone: "no" };
  }
}

export interface BoardTotals {
  inWindow: number;
  /** escrow still held (funded or submitted), by token symbol, in whole tokens */
  held: { symbol: string; amount: number }[];
  survived: number;
  /** jobs the guardian contract has settled either way */
  settled: number;
  refunded: number;
}

const whole = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

export function boardTotals(jobs: readonly JobView[], now: number): BoardTotals {
  const held = new Map<string, number>();
  let inWindow = 0;
  let survived = 0;
  let refunded = 0;
  for (const j of jobs) {
    if (j.status === "Funded" || j.status === "Submitted") {
      const symbol = j.tokenSymbol ?? "unknown token";
      held.set(symbol, (held.get(symbol) ?? 0) + whole(j.budget, j.tokenDecimals ?? 18));
    }
    if (jobState(j, now).label === "In window") inWindow++;
    if (j.status === "Completed") survived++;
    if (j.status === "Rejected") refunded++;
  }
  return { inWindow, held: [...held].map(([symbol, amount]) => ({ symbol, amount })), survived, settled: survived + refunded, refunded };
}

/** "0.05 USD1" */
export function budgetText(j: Pick<JobView, "budget" | "tokenSymbol" | "tokenDecimals">): string {
  const n = whole(j.budget, j.tokenDecimals ?? 18);
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${j.tokenSymbol ?? "(token unread)"}`;
}
