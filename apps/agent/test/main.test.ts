import { describe, expect, it } from "vitest";
import { Loop, backoffSec } from "../src/desk/main";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Loop", () => {
  it("backs off 30 s doubling to 15 min while failures last", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffSec(n))).toEqual([30, 60, 120, 240, 480, 900, 900]);
  });

  it("isolates failures, records them and recovers", async () => {
    let n = 0;
    const logs: string[] = [];
    const loop = new Loop({
      name: "keeper",
      run: async () => {
        n++;
        if (n === 1) throw new Error("rpc down");
        return n;
      },
      delaySec: () => 300,
      log: (l) => logs.push(l),
    });
    await loop.runOnce();
    expect(loop.state).toMatchObject({ failures: 1, consecutiveFailures: 1, lastError: "rpc down", lastOkAt: null });
    expect(logs[0]).toMatch(/keeper failed \(1 in a row, retry in 30 s\): rpc down/);
    await loop.runOnce();
    expect(loop.state).toMatchObject({ runs: 2, failures: 1, consecutiveFailures: 0, lastError: null });
  });

  it("runs on its timer with jitter, never overlapping, and stop() waits for the run in flight", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let finished = 0;
    const loop = new Loop({
      name: "publisher",
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(60);
        active--;
        finished++;
      },
      delaySec: () => 0.01,
      firstDelaySec: 0.01,
      jitter: 0.5,
      random: () => 1,
    });
    loop.start();
    await sleep(40);
    void loop.runOnce(); // a manual trigger joins the run in flight
    const stopped = await loop.stop(5_000);
    expect(stopped).toBe(true);
    expect(maxActive).toBe(1);
    expect(finished).toBe(runs);
    const after = runs;
    await sleep(100);
    expect(runs).toBe(after);
    expect(loop.state.nextAt).toBeNull();
  });

  it("gives up waiting after the stop timeout", async () => {
    const loop = new Loop({ name: "guardian", run: () => new Promise(() => undefined), delaySec: () => 1 });
    void loop.runOnce();
    expect(await loop.stop(20)).toBe(false);
  });
});
