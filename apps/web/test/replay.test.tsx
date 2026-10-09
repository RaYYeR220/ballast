// @vitest-environment jsdom
/* The recorded cycle: the loader refuses anything that is not a whole recording, the shipped recording is one
   and tells the story it claims, proofs are read tolerantly, and the page shows each step with its fork
   transactions, how to reproduce it, and a BNB Chain transaction only where one exists. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { session } from "@ballast/risk";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayPage } from "../components/judge/Replay";
import { parseProofs, parseReplay, proofsFor } from "../lib/replay";
import cycleJson from "../public/replay/cycle.json";

const clone = () => JSON.parse(JSON.stringify(cycleJson)) as Record<string, unknown> & { steps: Record<string, unknown>[] };
const TX_A = `0x${"a1".repeat(32)}`;
const TX_B = `0x${"b2".repeat(32)}`;

class RO {
  observe() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the shipped recording", () => {
  const r = parseReplay(cycleJson);

  it("is a whole cycle on a fork of BNB Chain, in time order", () => {
    expect(r.fork).toMatchObject({ of: "BNB Chain", chainId: 56, localChainId: 31337 });
    expect(r.fork.block).toBeGreaterThan(126_000_000);
    expect(r.steps.map((s) => s.kind)).toEqual(["setup", "publish", "open", "open", "job", "shield", "refused", "restore", "settle"]);
    expect(r.steps.every((s, i) => i === 0 || s.at >= r.steps[i - 1]!.at)).toBe(true);
    expect(r.forkOnly.length).toBeGreaterThanOrEqual(4);
    expect(r.forkOnly.join(" ")).toMatch(/clock/);
    expect(r.forkOnly.join(" ")).toMatch(/impersonated/);
  });

  it("shields in the regular session, is refused while New York is closed, and restores after the open", () => {
    const by = (kind: string) => r.steps.find((s) => s.kind === kind)!;
    const shield = by("shield");
    const refused = by("refused");
    const restore = by("restore");
    // the calendar this app ships agrees with the session the fork's contracts reported
    expect(session(shield.at)).toBe("REGULAR");
    expect(session(refused.at)).toBe("CLOSED_WEEKEND");
    expect(refused.state.session).toBe("CLOSED_WEEKEND");
    expect(session(restore.at)).toBe("REGULAR");
    expect(refused.error).toMatchObject({ name: "RestoreRefused", reason: "NOT_REGULAR" });
    expect(refused.txs).toHaveLength(1);
    expect(refused.txs[0]!.status).toBe("reverted");
    // the refusal moved nothing
    expect(refused.result.debtBefore).toBe(refused.result.debtAfter);
    expect(refused.state.account!.debt).toBe(shield.state.account!.debt);
    // the shield lowered the loan, sold nothing, and left it surviving the gap it was sized for
    expect(Number(shield.result.debtAfter)).toBeLessThan(Number(shield.result.debtBefore));
    expect(shield.result.collateralSold).toBe("0");
    expect(shield.state.account!.hfAfterGap).toBeGreaterThanOrEqual(1.049);
    expect(restore.state.canAddRisk).toBe(true);
    expect(restore.state.account!.ltvBps!).toBeLessThanOrEqual(Number(restore.result.maxLtvBps));
  });

  it("settles the guardian job in the desk's favour and writes its reputation", () => {
    const settle = r.steps[r.steps.length - 1]!;
    expect(settle.state.job).toMatchObject({ status: "Completed", settled: true });
    expect(settle.result).toMatchObject({ survived: true, paid: true, reputationValue: 100, reputationTag: "ballast-guard", feedbackWritten: true });
    expect(r.steps.find((s) => s.kind === "job")!.state.job!.status).toBe("Funded");
  });

  it("names a way to reproduce every step, and every transaction hash is well formed and unique", () => {
    const hashes = r.steps.flatMap((s) => s.txs.map((t) => t.hash));
    expect(hashes.length).toBeGreaterThanOrEqual(15);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const s of r.steps) {
      expect(s.reproduce.command).toMatch(/^pnpm /);
      expect(s.proofKeys.length).toBeGreaterThan(0);
    }
    // the fork tests the steps point at exist in this repository
    const root = path.resolve(__dirname, "..", "..", "..");
    for (const s of r.steps) {
      if (!s.reproduce.test) continue;
      const [file, fn] = s.reproduce.test.split(":");
      const source = readFileSync(path.join(root, file!), "utf8");
      if (fn) expect(source).toContain(`function ${fn}(`);
    }
  });
});

describe("parseReplay", () => {
  it("refuses a recording that is not whole", () => {
    expect(() => parseReplay(null)).toThrow("not an object");
    expect(() => parseReplay({ ...clone(), version: 2 })).toThrow("unknown version");
    expect(() => parseReplay({ ...clone(), steps: [] })).toThrow("no steps");
    const noFork = clone();
    delete noFork.fork;
    expect(() => parseReplay(noFork)).toThrow("header is incomplete");
  });

  it("refuses a step without a way to reproduce it or with a malformed transaction", () => {
    const a = clone();
    delete a.steps[2]!.reproduce;
    expect(() => parseReplay(a)).toThrow("step 3 does not say how to reproduce it");
    const b = clone();
    (b.steps[1]!.txs as { hash: string }[])[0]!.hash = "0x1234";
    expect(() => parseReplay(b)).toThrow("malformed hash");
    const c = clone();
    c.steps[3]!.kind = "liquidated";
    expect(() => parseReplay(c)).toThrow("unknown kind");
  });

  it("refuses a refusal without its revert, and a reverted transaction passed off as a success", () => {
    const a = clone();
    delete a.steps[6]!.error;
    expect(() => parseReplay(a)).toThrow("refusal without a reverted transaction and its error");
    const b = clone();
    (b.steps[5]!.txs as { status: string }[])[0]!.status = "reverted";
    expect(() => parseReplay(b)).toThrow("carries a reverted transaction but is not a refusal");
  });

  it("refuses steps out of order or with repeated ids", () => {
    const a = clone();
    a.steps[4]!.at = 1;
    expect(() => parseReplay(a)).toThrow("earlier than the step before it");
    const b = clone();
    b.steps[4]!.id = b.steps[3]!.id;
    expect(() => parseReplay(b)).toThrow("step ids repeat");
  });
});

describe("parseProofs", () => {
  it("reads a map of keys to hashes, objects or lists, with or without a txs wrapper", () => {
    expect(parseProofs({ txs: { deploy: { tx: TX_A, label: "First transaction of the deployment" }, shield: TX_B } })).toEqual({ deploy: [{ tx: TX_A, label: "First transaction of the deployment" }], shield: [{ tx: TX_B }] });
    expect(parseProofs({ shield: [TX_A, { hash: TX_B, note: "second shield" }] })).toEqual({ shield: [{ tx: TX_A }, { tx: TX_B, label: "second shield" }] });
  });

  it("reads a list of rows", () => {
    expect(parseProofs([{ key: "restore", txHash: TX_A }, { step: "restore", tx: TX_A }, { kind: "shield", tx: TX_B, label: "x" }, { tx: TX_B }])).toEqual({ restore: [{ tx: TX_A }], shield: [{ tx: TX_B, label: "x" }] });
  });

  it("drops anything that is not a transaction hash, and answers nothing for a broken file", () => {
    expect(parseProofs({ txs: { shield: "pending", restore: { tx: "0x12" }, deploy: 7 } })).toEqual({});
    expect(parseProofs(null)).toEqual({});
    expect(parseProofs("nope")).toEqual({});
  });

  it("matches the repository's proof file to the recording's steps", () => {
    const proofs = parseProofs(JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "..", "data", "proof-txs.json"), "utf8")));
    const r = parseReplay(cycleJson);
    expect(proofsFor(r.steps[0]!, proofs).map((p) => p.tx)).toHaveLength(3);
    expect(proofsFor(r.steps[1]!, proofs)).toHaveLength(1);
    // every key in the file is one a step asks for
    const wanted = new Set(r.steps.flatMap((s) => s.proofKeys));
    expect(Object.keys(proofs).every((k) => wanted.has(k))).toBe(true);
  });
});

describe("/judge", () => {
  const r = parseReplay(cycleJson);
  const proofs = { deploy: [{ tx: TX_A, label: "First transaction of the deployment" }] };

  it("labels the recording as a fork recording and opens on the first step", () => {
    render(<ReplayPage replay={r} proofs={proofs} serverNow={r.fork.blockTime} />);
    const label = screen.getByRole("note");
    expect(label.textContent).toContain("Demo recording");
    expect(label.textContent).toContain(`Recorded on a fork of BSC mainnet at block ${r.fork.block.toLocaleString("en-US")}`);
    expect(label.textContent).toContain(`1 of ${r.steps.length} steps also have a transaction on BNB Chain`);
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem").filter((li) => li.querySelector("button[aria-expanded]"))).toHaveLength(r.steps.length);
    const open = within(steps).getByRole("button", { expanded: true });
    expect(open.textContent).toContain(r.steps[0]!.title);
    // the one step with a BNB Chain transaction links to it
    expect(within(steps).getByText("First transaction of the deployment").previousElementSibling!.getAttribute("href")).toBe(`https://bscscan.com/tx/${TX_A}`);
    expect(within(steps).getByText("pnpm verify:onchain")).toBeTruthy();
  });

  it("shows the refusal as a refusal: the revert, the fork transaction, how to reproduce it, and no BNB Chain link it does not have", () => {
    render(<ReplayPage replay={r} proofs={proofs} serverNow={r.fork.blockTime} />);
    const steps = screen.getByRole("region", { name: "Steps" });
    fireEvent.click(within(steps).getByRole("button", { name: /a restore is refused/ }));
    const slip = within(steps).getByRole("group", { name: "The refused call" });
    expect(within(slip).getByText("Reverted: RestoreRefused(NOT_REGULAR)")).toBeTruthy();
    expect(within(slip).getByText("Sent on the fork, reverted")).toBeTruthy();
    expect(within(slip).getByText(/Nothing\. Debt/)).toBeTruthy();
    const refused = r.steps.find((s) => s.kind === "refused")!;
    expect(within(steps).getByTitle(refused.txs[0]!.hash)).toBeTruthy();
    expect(within(steps).getByText("Reverted", { selector: "span" })).toBeTruthy();
    expect(within(steps).getByText("pnpm contracts:test:fork --match-test test_restore_refusedOnWeekend_andMovesNothing")).toBeTruthy();
    expect(within(steps).getByText(/No matching transaction on BNB Chain yet/)).toBeTruthy();
    expect(steps.querySelector('a[href*="bscscan.com/tx/"]')).toBeNull();
    expect(screen.getByText("Step 7 of 9")).toBeTruthy();
  });

  it("steps with Next and Previous, and stops at both ends", () => {
    render(<ReplayPage replay={r} proofs={{}} serverNow={r.fork.blockTime} />);
    const transport = screen.getByRole("group", { name: "Playback" });
    const prev = within(transport).getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const next = within(transport).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    for (let i = 1; i < r.steps.length; i++) fireEvent.click(next);
    expect(screen.getByText(`Step ${r.steps.length} of ${r.steps.length}`)).toBeTruthy();
    expect(next.disabled).toBe(true);
    expect(within(transport).getByRole("button", { name: "Play again" })).toBeTruthy();
    expect(screen.getByText("Paid to the desk").nextElementSibling!.textContent).toBe("0.05 USD1");
    fireEvent.click(prev);
    expect(screen.getByText(`Step ${r.steps.length - 1} of ${r.steps.length}`)).toBeTruthy();
  });

  it("plays on a timer and can be paused", () => {
    vi.useFakeTimers();
    try {
      render(<ReplayPage replay={r} proofs={{}} serverNow={r.fork.blockTime} />);
      const transport = screen.getByRole("group", { name: "Playback" });
      fireEvent.click(within(transport).getByRole("button", { name: "Play the cycle" }));
      act(() => {
        vi.advanceTimersByTime(4300);
      });
      expect(screen.getByText("Step 2 of 9")).toBeTruthy();
      fireEvent.click(within(transport).getByRole("button", { name: "Pause" }));
      act(() => {
        vi.advanceTimersByTime(9000);
      });
      expect(screen.getByText("Step 2 of 9")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists what only a fork can do", () => {
    render(<ReplayPage replay={r} proofs={{}} serverNow={r.fork.blockTime} />);
    const fork = screen.getByRole("region", { name: "What a fork changes" });
    expect(within(fork).getAllByRole("listitem")).toHaveLength(r.forkOnly.length);
    expect(within(fork).getByText(/scripts\/demo\/record-replay\.ts/)).toBeTruthy();
    expect(within(fork).getByRole("link", { name: "/replay/cycle.json" }).getAttribute("href")).toBe("/replay/cycle.json");
  });
});
