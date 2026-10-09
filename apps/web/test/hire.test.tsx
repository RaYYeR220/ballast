// @vitest-environment jsdom
/* Hiring a guardian: the window comes from the calendar, the contract's own checks are applied before anything
   is simulated, the four calls decode back to what the guardian contract expects, and the form sends nothing
   that did not pass a simulation. */
import { kernelAbi } from "@ballast/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type Log } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HireForm } from "../components/guardians/Hire";
import { TxRunnerContext, type TxRunner } from "../components/app/TxFlow";
import { createJobStep, fundSteps, guardWindow, hireProblems, jobIdFromLogs, windowText } from "../lib/guardian-steps";
import { DESK_ADDRESS, DESK_AGENT_ID } from "../lib/identity";
import type { SimResult } from "../lib/sim";
import type { AccountView } from "../lib/views";
import { OWNER, VIEW } from "./fixtures";
import { addr, DEPLOYMENT } from "./helpers";

afterEach(cleanup);

const THU_1400 = 1_791_482_400; // Thu 8 Oct 2026 14:00 New York, regular session
const THU_CLOSE = 1_791_489_600;
const THU_1800 = 1_791_496_800;
const FRI_OPEN = 1_791_552_600;
const FRI_1400 = THU_1400 + 86_400;
const MON_OPEN = 1_791_811_800;
const TUE_OPEN = MON_OPEN + 86_400;
const E18 = 10n ** 18n;
const FEE = E18 / 20n;
const KERNEL = DEPLOYMENT.external.kernel;
const ACCOUNT: AccountView = { ...VIEW, keeper: DESK_ADDRESS };

describe("the window of a job", () => {
  it("runs from the next close to the restore delay after the following open", () => {
    expect(guardWindow(THU_1400)).toEqual({ start: THU_CLOSE, end: FRI_OPEN + 5400, expiredAt: MON_OPEN + 7200, closedAt: THU_CLOSE, opensAt: FRI_OPEN });
    expect(windowText(guardWindow(THU_1400)!)).toBe("Thu 16:00 to Fri 11:00 New York");
  });

  it("covers the weekend when posted on a Friday", () => {
    const w = guardWindow(FRI_1400)!;
    expect(w).toMatchObject({ start: FRI_1400 + 2 * 3600, end: MON_OPEN + 5400, expiredAt: TUE_OPEN + 7200 });
    expect((w.end - w.start) / 3600).toBe(67);
  });

  it("starts a few minutes ahead when New York is already closed, so funding lands before it", () => {
    const w = guardWindow(THU_1800)!;
    expect(w.start).toBe(THU_1800 + 600);
    expect(w.end).toBe(FRI_OPEN + 5400);
    expect(w.closedAt).toBe(THU_1800);
  });

  it("takes the oracle's own restore delay and answers nothing outside the calendar", () => {
    expect(guardWindow(THU_1400, 3600)!.end).toBe(FRI_OPEN + 3600);
    expect(guardWindow(1_500_000_000)).toBeNull();
  });
});

describe("checks before anything is simulated", () => {
  const ok = { account: ACCOUNT, wallet: OWNER, provider: DESK_ADDRESS, fee: FEE, minBudget: E18 / 100n, window: guardWindow(THU_1400) };

  it("passes a job the guardian contract would bind", () => {
    expect(hireProblems(ok)).toEqual([]);
  });

  it("names each thing the contract would refuse", () => {
    expect(hireProblems({ ...ok, wallet: addr(0x99) })).toEqual(["Only the owner of the credit line can post a job for it."]);
    expect(hireProblems({ ...ok, account: { ...ACCOUNT, debt: "0" } })).toEqual(["This credit line has no debt: there is nothing to guard."]);
    expect(hireProblems({ ...ok, account: { ...ACCOUNT, liquidated: true } })[0]).toContain("liquidated");
    expect(hireProblems({ ...ok, wallet: DESK_ADDRESS, account: { ...ACCOUNT, owner: DESK_ADDRESS } })).toEqual(["A borrower cannot hire itself: the guardian must be another address."]);
    expect(hireProblems({ ...ok, fee: E18 / 1000n })).toEqual(["The fee is below the guardian's minimum of 0.01 USD1."]);
    expect(hireProblems({ ...ok, balance: FEE - 1n })).toEqual(["The wallet holds less than the fee."]);
    expect(hireProblems({ ...ok, window: { ...ok.window!, end: ok.window!.start + 1800 } })[0]).toContain("shorter than the one hour");
    expect(hireProblems({ account: null, wallet: null, provider: null, fee: null, minBudget: null, window: null })).toHaveLength(5);
  });
});

describe("the four calls", () => {
  const w = guardWindow(THU_1400)!;

  it("posts the job with the guardian contract as evaluator and hook", () => {
    const step = createJobStep(DEPLOYMENT, { provider: DESK_ADDRESS, token: ACCOUNT.loanToken, tokenSymbol: "USD1", window: w, symbol: "NVDA" });
    expect(step.tx.to).toBe(KERNEL);
    const call = decodeFunctionData({ abi: kernelAbi, data: step.tx.data });
    expect(call.functionName).toBe("createJobWithToken");
    expect(call.args).toEqual([DESK_ADDRESS, DEPLOYMENT.guardian, BigInt(w.expiredAt), "guard my NVDA loan through the coming closure", DEPLOYMENT.guardian, ACCOUNT.loanToken]);
  });

  it("sets the fee, approves exactly it, and funds with the terms the guardian decodes", () => {
    const steps = fundSteps(DEPLOYMENT, { jobId: 56_940n, fee: FEE, token: ACCOUNT.loanToken, tokenSymbol: "USD1", tokenDecimals: 18, allowance: 0n, account: ACCOUNT.address, agentId: DESK_AGENT_ID, window: w });
    expect(steps.map((s) => s.key)).toEqual(["set-budget", `approve-${ACCOUNT.loanToken}`, "fund"]);
    expect(decodeFunctionData({ abi: kernelAbi, data: steps[0]!.tx.data })).toMatchObject({ functionName: "setBudget", args: [56_940n, FEE, "0x"] });
    expect(steps[1]!.tx.to).toBe(ACCOUNT.loanToken);
    expect(decodeFunctionData({ abi: erc20Abi, data: steps[1]!.tx.data })).toMatchObject({ functionName: "approve", args: [KERNEL, FEE] });
    const fund = decodeFunctionData({ abi: kernelAbi, data: steps[2]!.tx.data });
    expect(fund.functionName).toBe("fund");
    expect(fund.args!.slice(0, 2)).toEqual([56_940n, FEE]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }], fund.args![2] as Hex)).toEqual([ACCOUNT.address, BigInt(w.start), BigInt(w.end), DESK_AGENT_ID]);
  });

  it("leaves the approval out when the escrow may already take the fee", () => {
    const steps = fundSteps(DEPLOYMENT, { jobId: 1n, fee: FEE, token: ACCOUNT.loanToken, tokenSymbol: "USD1", tokenDecimals: 18, allowance: FEE, account: ACCOUNT.address, agentId: DESK_AGENT_ID, window: w });
    expect(steps.map((s) => s.key)).toEqual(["set-budget", "fund"]);
  });
});

const jobCreated = (jobId: bigint, address: Address = KERNEL): Log => ({
  address,
  topics: encodeEventTopics({ abi: kernelAbi, eventName: "JobCreated", args: { jobId, client: OWNER, provider: DESK_ADDRESS } }) as Log["topics"],
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [DEPLOYMENT.guardian, 1n, DEPLOYMENT.guardian]),
  blockHash: `0x${"00".repeat(32)}`,
  blockNumber: 1n,
  logIndex: 0,
  transactionHash: `0x${"a1".repeat(32)}`,
  transactionIndex: 0,
  removed: false,
});

describe("the job id", () => {
  it("is read from the kernel's JobCreated event and from nothing else", () => {
    expect(jobIdFromLogs([jobCreated(56_940n)], KERNEL)).toBe(56_940n);
    expect(jobIdFromLogs([jobCreated(7n, addr(0x66))], KERNEL)).toBeNull();
    expect(jobIdFromLogs([], KERNEL)).toBeNull();
  });
});

function harness(o: { refuseFund?: boolean } = {}) {
  const sent: string[] = [];
  const simulated: string[] = [];
  const nameOf = (data: Hex) => {
    try {
      return decodeFunctionData({ abi: kernelAbi, data }).functionName;
    } catch {
      return decodeFunctionData({ abi: erc20Abi, data }).functionName;
    }
  };
  const runner: TxRunner = {
    chainId: 31337,
    simulate: async (tx): Promise<SimResult> => {
      const fn = nameOf(tx.data);
      simulated.push(fn);
      if (fn === "fund" && o.refuseFund) {
        return { via: "rpc", ok: false, error: { name: "BadTerms", message: "guard terms are invalid for this job" } };
      }
      return { via: "rpc", ok: true };
    },
    send: async (tx) => {
      sent.push(nameOf(tx.data));
      return `0x${String(sent.length).padStart(2, "0").repeat(32)}` as Hex;
    },
    wait: async (hash) => ({ hash, status: "success", logs: hash.startsWith("0x01") ? [jobCreated(56_940n)] : [] }),
  };
  const loadToken = vi.fn(async () => ({ balance: 10n * E18, allowance: 0n }));
  return { runner, sent, simulated, loadToken };
}

const form = (h: ReturnType<typeof harness>, accounts: AccountView[] = [ACCOUNT], extra: Partial<React.ComponentProps<typeof HireForm>> = {}) =>
  render(
    <TxRunnerContext.Provider value={h.runner}>
      <HireForm deployment={DEPLOYMENT} wallet={OWNER} accounts={accounts} provider={DESK_ADDRESS} minBudget={E18 / 100n} now={THU_1400} loadToken={h.loadToken} {...extra} />
    </TxRunnerContext.Provider>,
  );

const sendCurrent = async (title: RegExp | string) => {
  await screen.findByText(title);
  fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));
};

describe("the hiring form", () => {
  it("says what is missing when the wallet has no credit line, or none with a loan", () => {
    const h = harness();
    const { unmount } = form(h, []);
    expect(screen.getByText("This wallet has no Ballast credit line")).toBeTruthy();
    unmount();
    form(h, [{ ...ACCOUNT, debt: "0" }]);
    expect(screen.getByText("None of your credit lines has a loan to guard")).toBeTruthy();
    expect(h.simulated).toEqual([]);
  });

  it("shows the window and the guardian, and blocks a fee under the minimum before any request", () => {
    const h = harness();
    form(h);
    expect(screen.getByText("Thu 16:00 to Fri 11:00 New York")).toBeTruthy();
    expect(screen.getByText(/ERC-8004 agent 368122/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "0.001" } });
    expect(screen.getByText("The fee is below the guardian's minimum of 0.01 USD1.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Simulate the first step" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.loadToken).not.toHaveBeenCalled();
    expect(h.simulated).toEqual([]);
  });

  it("stops before simulating when the wallet cannot pay the fee", async () => {
    const h = harness();
    h.loadToken.mockResolvedValueOnce({ balance: FEE - 1n, allowance: 0n });
    form(h);
    fireEvent.click(screen.getByRole("button", { name: "Simulate the first step" }));
    expect(await screen.findByText("The wallet holds less than the fee.")).toBeTruthy();
    expect(h.simulated).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("posts, prices, approves and funds, each only after its simulation passed", async () => {
    const h = harness();
    const onFunded = vi.fn();
    form(h, [ACCOUNT], { onFunded });
    fireEvent.click(screen.getByRole("button", { name: "Simulate the first step" }));
    await sendCurrent("Post the job");
    expect(await screen.findByText(/Job 56940 is posted/)).toBeTruthy();
    await sendCurrent(/Set the fee to 0\.05 USD1/);
    await waitFor(() => expect(h.sent).toEqual(["createJobWithToken", "setBudget"]));
    await sendCurrent(/Approve 0\.05 USD1 for the job escrow/);
    await waitFor(() => expect(h.sent).toHaveLength(3));
    await sendCurrent("Fund the job with its terms");
    expect(await screen.findByText("Job 56940 is funded")).toBeTruthy();
    expect(h.sent).toEqual(["createJobWithToken", "setBudget", "approve", "fund"]);
    // every send was preceded by its own simulation, in order
    expect(h.simulated).toEqual(["createJobWithToken", "setBudget", "approve", "fund"]);
    expect(onFunded).toHaveBeenCalledWith(56_940n);
  });

  it("shows the guardian contract's refusal and does not send the funding", async () => {
    const h = harness({ refuseFund: true });
    form(h);
    fireEvent.click(screen.getByRole("button", { name: "Simulate the first step" }));
    await sendCurrent("Post the job");
    await sendCurrent(/Set the fee/);
    await waitFor(() => expect(h.sent).toHaveLength(2));
    await sendCurrent(/Approve 0\.05 USD1/);
    expect(await screen.findByText("Reverted: BadTerms")).toBeTruthy();
    expect(screen.getByText("guard terms are invalid for this job")).toBeTruthy();
    expect(screen.getByText("Nothing was sent, so no gas was spent.")).toBeTruthy();
    expect(h.sent).toEqual(["createJobWithToken", "setBudget", "approve"]);
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
  });
});
