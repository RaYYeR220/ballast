// @vitest-environment jsdom
/* The guardian board: a bounded, cursor-driven scan of the kernel, the desk's identity and reputation, what a
   job is doing at a given time, and a page that lists only what is on chain. */
import { bscExternal } from "@ballast/sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianBoard } from "../components/guardians/GuardianBoard";
import { boardTotals, budgetText, jobState, type GuardiansBody, type JobView } from "../lib/guardians";
import { DESK_ADDRESS, DESK_AGENT_ID, IDENTITY_REGISTRY } from "../lib/identity";
import { LIMITS } from "../lib/server/limits";
import { handleGuardians, MAX_REFRESH, readGuardians, readReputation, resetGuardianScans } from "../lib/server/handlers/guardians";
import type { DeploymentStatus } from "../lib/server/deployment";
import { addr, DEPLOYMENT } from "./helpers";

const NOW = 1_791_496_800; // Thu 8 Oct 2026 18:00 New York
const E18 = 10n ** 18n;
const USD1 = bscExternal().tokens.USD1!;
const START = 56_923n;
const D = { ...DEPLOYMENT, guardianStartJobId: START };
const OK: DeploymentStatus = { ok: true, chainId: 31337, deployment: D, source: "test" };
const MISSING: DeploymentStatus = { ok: false, chainId: 56, reason: "missing", detail: "no deployment file for chain 56" };
const ZERO = "0x0000000000000000000000000000000000000000";

class RO {
  observe() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "unavailable", detail: "the test has no network" }))));
  resetGuardianScans();
  // the board reads the wall clock once mounted: pin it to the moment the fixtures describe
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface KernelJob {
  status: number;
  ours?: boolean;
  bound?: boolean;
  start?: number;
  end?: number;
  settled?: boolean;
}

/** A kernel with `head` jobs; only the ids in `jobs` name the Ballast guardian as evaluator. */
function kernel(o: { head: bigint; jobs?: Record<string, KernelJob>; clients?: string[]; summary?: [bigint, bigint, number]; failToken?: boolean }) {
  const calls = { getJob: [] as bigint[], terms: [] as bigint[], reads: [] as string[], multicalls: 0 };
  const state = { head: o.head, jobs: o.jobs ?? {} };
  const job = (id: bigint) => {
    const j = state.jobs[id.toString()];
    return { id, client: addr(0xc1), provider: DESK_ADDRESS, evaluator: j && j.ours !== false ? D.guardian : addr(0xee), description: "guard my NVDA loan", budget: E18 / 20n, expiredAt: BigInt(NOW + 5 * 86_400), status: j?.status ?? 0, hook: D.guardian, submittedAt: 0n, deliverable: `0x${"00".repeat(32)}` };
  };
  const client = {
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(NOW) }),
    multicall: async ({ contracts }: { contracts: { functionName: string; args: [bigint] }[] }) => {
      calls.multicalls++;
      return contracts.map((c) => {
        const id = c.args[0];
        if (c.functionName === "getJob") {
          calls.getJob.push(id);
          return job(id);
        }
        calls.terms.push(id);
        const j = state.jobs[id.toString()]!;
        return [addr(0xbb), BigInt(j.start ?? NOW - 3600), BigInt(j.end ?? NOW + 3600), DESK_AGENT_ID, j.bound !== false, j.settled === true];
      });
    },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      calls.reads.push(functionName);
      if (functionName === "jobCounter") return state.head;
      if (functionName === "jobPaymentToken") {
        if (o.failToken) throw new Error("rpc timeout");
        return USD1;
      }
      if (functionName === "minBudget") return E18 / 100n;
      if (functionName === "ownerOf") return DESK_ADDRESS;
      if (functionName === "getAgentWallet") return ZERO;
      if (functionName === "getClients") return o.clients ?? [];
      if (functionName === "getSummary") {
        expect(args![1]).toEqual([D.guardian]);
        expect(args!.slice(2)).toEqual(["ballast-guard", "window"]);
        return o.summary ?? [0n, 0n, 0];
      }
      throw new Error(`unmocked read ${functionName}`);
    },
  };
  return { client: client as never, calls, state };
}

describe("the job scan", () => {
  it("starts at the id recorded at deployment and reads a bounded number of ids per answer", async () => {
    const k = kernel({ head: START + 450n, jobs: { [(START + 3n).toString()]: { status: 1 }, [(START + 260n).toString()]: { status: 3 } } });
    const a = await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    if (a.status !== "ok") throw new Error("expected ok");
    expect(k.calls.getJob).toHaveLength(LIMITS.jobScan);
    expect(k.calls.getJob[0]).toBe(START + 1n);
    expect(a.scan).toEqual({ from: START.toString(), cursor: (START + BigInt(LIMITS.jobScan)).toString(), head: (START + 450n).toString(), complete: false });
    expect(a.jobs.map((j) => j.id)).toEqual([(START + 3n).toString()]);

    // the next answer continues from the cursor: no id is read twice, and the job still in flight is refreshed
    k.calls.getJob.length = 0;
    const b = await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    if (b.status !== "ok") throw new Error("expected ok");
    const fresh = k.calls.getJob.filter((id) => id > START + BigInt(LIMITS.jobScan));
    expect(fresh).toHaveLength(LIMITS.jobScan);
    expect(k.calls.getJob.filter((id) => id <= START + BigInt(LIMITS.jobScan))).toEqual([START + 3n]);
    expect(b.jobs.map((j) => j.id)).toEqual([(START + 260n).toString(), (START + 3n).toString()]);
    expect(b.scan.complete).toBe(false);

    const c = await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    if (c.status !== "ok") throw new Error("expected ok");
    expect(c.scan).toMatchObject({ cursor: (START + 450n).toString(), complete: true });
  });

  it("never re-reads a settled job, and refreshes at most a bounded number of open ones", async () => {
    const jobs: Record<string, KernelJob> = {};
    for (let i = 1; i <= 80; i++) jobs[(START + BigInt(i)).toString()] = { status: i <= 70 ? 1 : 3 };
    const k = kernel({ head: START + 80n, jobs });
    await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    k.calls.getJob.length = 0;
    await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    expect(k.calls.getJob).toHaveLength(MAX_REFRESH);
    expect(k.calls.getJob.every((id) => id <= START + 70n)).toBe(true);
  });

  it("returns jobs newest first with their token, window and status", async () => {
    const k = kernel({ head: START + 2n, jobs: { [(START + 1n).toString()]: { status: 3, settled: true }, [(START + 2n).toString()]: { status: 0, bound: false } } });
    const a = await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    if (a.status !== "ok") throw new Error("expected ok");
    expect(a.jobs[0]).toMatchObject({ id: (START + 2n).toString(), status: "Open", terms: null, tokenSymbol: "USD1", tokenDecimals: 18, budget: (E18 / 20n).toString() });
    expect(a.jobs[1]).toMatchObject({ status: "Completed", terms: { agentId: "368122", settled: true, start: NOW - 3600, end: NOW + 3600 } });
    expect(a).toMatchObject({ minBudget: (E18 / 100n).toString(), guardian: D.guardian, identity: { owner: DESK_ADDRESS, matchesDesk: true }, reputation: { clients: 0, guard: null } });
  });

  it("says a token is unread instead of guessing it", async () => {
    const k = kernel({ head: START + 1n, jobs: { [(START + 1n).toString()]: { status: 1 } }, failToken: true });
    const a = await readGuardians(k.client, OK as Extract<DeploymentStatus, { ok: true }>);
    if (a.status !== "ok") throw new Error("expected ok");
    expect(a.jobs[0]).toMatchObject({ token: null, tokenSymbol: null, tokenDecimals: null });
    expect(budgetText(a.jobs[0]!)).toBe("0.05 (token unread)");
  });
});

describe("GET /api/guardians", () => {
  it("answers not deployed with the identity it can still read, and scans nothing", async () => {
    const k = kernel({ head: START + 10n, clients: [addr(0x77)] });
    const res = await handleGuardians(MISSING, k.client, bscExternal());
    expect(await res.json()).toEqual({ status: "not-deployed", detail: MISSING.detail, identity: { agentId: "368122", registry: IDENTITY_REGISTRY, owner: DESK_ADDRESS, wallet: null, matchesDesk: true }, reputation: { clients: 1, guard: null } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(k.calls.multicalls).toBe(0);
    expect(k.calls.reads).not.toContain("jobCounter");
  });

  it("reports a failed chain read as unavailable", async () => {
    const dead = { getBlock: async () => Promise.reject(new Error("rpc down")) };
    const res = await handleGuardians({ ...OK, deployment: { ...D, guardian: addr(0xd1) } } as DeploymentStatus, dead as never, bscExternal());
    expect(await res.json()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("rpc down") });
  });

  it("is cacheable only once the scan has caught up", async () => {
    const k = kernel({ head: START + 450n });
    const partial = await handleGuardians({ ...OK, deployment: { ...D, guardian: addr(0xd2) } } as DeploymentStatus, k.client, bscExternal());
    expect(partial.headers.get("cache-control")).toBe("no-store");
    const k2 = kernel({ head: START + 5n });
    const done = await handleGuardians({ ...OK, deployment: { ...D, guardian: addr(0xd3) } } as DeploymentStatus, k2.client, bscExternal());
    expect(done.headers.get("cache-control")).toContain("s-maxage");
  });
});

describe("reputation", () => {
  it("summarises the guardian contract's own entries under its tags", async () => {
    const k = kernel({ head: START, clients: [D.guardian, addr(0x77)], summary: [4n, 75n, 0] });
    expect(await readReputation(k.client, DESK_AGENT_ID, D.guardian)).toEqual({ clients: 2, guard: { count: 4, average: 75 } });
  });

  it("says the registry could not be read", async () => {
    const dead = { readContract: async () => Promise.reject(new Error("rpc timeout")) };
    expect(await readReputation(dead as never, DESK_AGENT_ID, D.guardian)).toMatchObject({ clients: null, guard: null, error: expect.stringContaining("rpc timeout") });
  });
});

const job = (o: Partial<JobView> & { status: JobView["status"] }): JobView => ({
  id: "56930",
  client: addr(0xc1),
  provider: DESK_ADDRESS,
  description: "guard my NVDA loan",
  budget: (E18 / 20n).toString(),
  token: USD1,
  tokenSymbol: "USD1",
  tokenDecimals: 18,
  expiredAt: NOW + 5 * 86_400,
  submittedAt: 0,
  deliverable: `0x${"00".repeat(32)}`,
  terms: { account: addr(0xbb), start: NOW - 3600, end: NOW + 3600, agentId: "368122", settled: false },
  ...o,
});

describe("what a job is doing", () => {
  it("reads the status against the clock", () => {
    expect(jobState(job({ status: "Open", terms: null }), NOW)).toEqual({ label: "Posted, not funded", tone: "idle" });
    expect(jobState(job({ status: "Funded" }), NOW - 7200)).toEqual({ label: "Funded, window ahead", tone: "idle" });
    expect(jobState(job({ status: "Funded" }), NOW)).toEqual({ label: "In window", tone: "live" });
    expect(jobState(job({ status: "Funded" }), NOW + 3600)).toEqual({ label: "Window over, evidence due", tone: "idle" });
    expect(jobState(job({ status: "Funded" }), NOW + 6 * 86_400)).toEqual({ label: "Expired, refund claimable", tone: "no" });
    expect(jobState(job({ status: "Submitted" }), NOW)).toMatchObject({ label: "Evidence in, awaiting settle" });
    expect(jobState(job({ status: "Completed" }), NOW)).toEqual({ label: "Survived, paid", tone: "ok" });
    expect(jobState(job({ status: "Rejected" }), NOW)).toEqual({ label: "Not survived, refunded", tone: "no" });
  });

  it("totals the board from the jobs alone", () => {
    const jobs = [job({ status: "Funded" }), job({ id: "2", status: "Submitted" }), job({ id: "3", status: "Completed" }), job({ id: "4", status: "Completed" }), job({ id: "5", status: "Rejected" }), job({ id: "6", status: "Open", terms: null })];
    expect(boardTotals(jobs, NOW)).toEqual({ inWindow: 1, held: [{ symbol: "USD1", amount: 0.1 }], survived: 2, settled: 3, refunded: 1 });
    expect(boardTotals([], NOW)).toEqual({ inWindow: 0, held: [], survived: 0, settled: 0, refunded: 0 });
  });
});

type OkBody = Extract<GuardiansBody, { status: "ok" }>;
const body = (jobs: JobView[]): OkBody => ({
  status: "ok",
  chainId: 56,
  blockNumber: "126574946",
  at: NOW,
  guardian: D.guardian,
  kernel: addr(0xea),
  minBudget: (E18 / 100n).toString(),
  scan: { from: "56923", cursor: "56937", head: "56937", complete: true },
  jobs,
  identity: { agentId: "368122", registry: IDENTITY_REGISTRY, owner: DESK_ADDRESS, wallet: DESK_ADDRESS, matchesDesk: true },
  reputation: { clients: 0, guard: null },
});

describe("/guardians", () => {
  it("says no job has been posted, shows zeros it can stand behind, and still shows the desk's identity", () => {
    render(<GuardianBoard initial={body([])} serverNow={NOW} />);
    expect(screen.getByText("No guardian job has been posted yet")).toBeTruthy();
    expect(screen.getByText(/jobs 56923 to 56937 were checked/)).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("0 of 0")).toBeTruthy();
    expect(within(summary).getAllByText("no job has been posted yet").length).toBeGreaterThan(0);
    const roster = screen.getByRole("region", { name: "Guardian roster" });
    expect(within(roster).getByText("Guardian 368122")).toBeTruthy();
    expect(within(roster).getByText("none settled yet")).toBeTruthy();
    expect(within(roster).getByText("No entry from the guardian contract yet")).toBeTruthy();
    expect(within(roster).getByRole("link", { name: "ERC-8004 record" }).getAttribute("href")).toBe(`https://bscscan.com/nft/${IDENTITY_REGISTRY}/368122`);
    expect(screen.getByRole("status").textContent).toBe("No job in a window");
    expect(screen.getByText("No job window falls in this week.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "recorded cycle" }).getAttribute("href")).toBe("/judge");
  });

  it("lists jobs with their window, escrow, guardian and state, and totals them", () => {
    const jobs = [job({ status: "Funded" }), job({ id: "56929", status: "Completed", terms: { account: addr(0xbb), start: NOW - 90_000, end: NOW - 3600, agentId: "368122", settled: true } })];
    render(<GuardianBoard initial={{ ...body(jobs), reputation: { clients: 1, guard: { count: 1, average: 100 } } }} serverNow={NOW} />);
    const table = screen.getByRole("region", { name: "Jobs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("In window")).toBeTruthy();
    expect(within(rows[0]!).getByText("0.05 USD1")).toBeTruthy();
    expect(within(rows[0]!).getByText("Thu 17:00 to Thu 19:00")).toBeTruthy();
    expect(within(rows[1]!).getByText("Survived, paid")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("0.05 USD1")).toBeTruthy();
    expect(within(summary).getByText("1 of 1")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 job in a window");
    const roster = screen.getByRole("region", { name: "Guardian roster" });
    expect(within(roster).getByText("1 entry from the guardian contract, average 100")).toBeTruthy();
    expect(roster.textContent).toContain("1 of 1");
    expect(screen.getByRole("img", { name: /2 guardian job windows/ })).toBeTruthy();
  });

  it("says the guardian is not deployed, or that the chain read failed, without listing anything", () => {
    const { unmount } = render(<GuardianBoard initial={{ status: "not-deployed", detail: "no deployment file for chain 56", identity: body([]).identity }} serverNow={NOW} />);
    expect(screen.getByText("The guardian contract is not deployed on this chain yet")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Summary" })).getAllByText("n/a")).toHaveLength(4);
    expect(within(screen.getByRole("region", { name: "Guardian roster" })).getByText("Guardian 368122")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Guardian not deployed");
    unmount();
    render(<GuardianBoard initial={{ status: "unavailable", detail: "chain read failed: rpc down" }} serverNow={NOW} />);
    expect(screen.getByText("The kernel could not be read")).toBeTruthy();
    expect(screen.getByText(/rpc down/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: /Job/ })).toBeNull();
  });

  it("says when the scan has not caught up yet", () => {
    render(<GuardianBoard initial={{ ...body([]), scan: { from: "56923", cursor: "57123", head: "57400", complete: false } }} serverNow={NOW} />);
    expect(screen.getByText(/job ids 56923 to 57123 of 57400 checked so far/)).toBeTruthy();
  });
});
