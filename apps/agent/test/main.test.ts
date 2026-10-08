import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Loop, assertWritable, backoffSec, salesWarning, senderView, startDesk } from "../src/desk/main";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("data dir", () => {
  it("passes a writable directory and leaves no probe behind", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "desk-main-")), "state");
    await assertWritable(dir);
    expect(await readdir(dir)).toEqual(["evidence"]);
  });

  it("fails the start when DATA_DIR cannot be written", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "desk-main-"));
    const file = path.join(base, "not-a-dir");
    await writeFile(file, "x");
    await expect(assertWritable(path.join(file, "state"))).rejects.toThrow(/DATA_DIR .* is not writable/);
    // the desk refuses to start before it opens the API or touches the chain
    await expect(
      startDesk({ CHAIN_ID: "31337", BSC_RPC_URL: "http://127.0.0.1:1", AGENT_PRIVATE_KEY: `0x${"4f".repeat(32)}`, DATA_DIR: path.join(file, "state") }, () => undefined),
    ).rejects.toThrow(/DATA_DIR .* is not writable/);
  });
});

describe("sender view for /health", () => {
  it("shows the halt and the transaction in flight, amounts readable", () => {
    expect(senderView(undefined)).toBeNull();
    expect(senderView({ sales: "public", halted: null, outstanding: null, spentLastHourWei: 0n })).toEqual({ sales: "public", halted: null, inFlight: null, feeSpentLastHourBnb: "0" });
    const hashes = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`] as const;
    expect(
      senderView({
        sales: "disabled",
        halted: { reason: "GAS_CAP", message: "replacing nonce 12 needs more than the gas price cap of 5 gwei", nonce: 12, since: 1_800_000_000 },
        outstanding: { nonce: 12, hashes: [...hashes], gasPrice: 4_500_000_000n, rounds: 3, kind: "intent" },
        spentLastHourWei: 2_500_000_000_000_000n,
      }),
    ).toEqual({
      sales: "disabled",
      halted: { reason: "GAS_CAP", message: "replacing nonce 12 needs more than the gas price cap of 5 gwei", nonce: 12, since: 1_800_000_000 },
      inFlight: { nonce: 12, kind: "intent", rounds: 3, gasPriceGwei: "4.5", hashes: [...hashes] },
      feeSpentLastHourBnb: "0.0025",
    });
  });
});

describe("startup warning", () => {
  it("says sales are disabled when the sender has no protected endpoint, and nothing otherwise", () => {
    expect(salesWarning("disabled")).toMatch(/collateral sales are DISABLED.*BINANCE_WEB3_API_KEY.*cushion still shields/);
    expect(salesWarning("protected")).toBeNull();
    expect(salesWarning("public")).toBeNull();
    expect(salesWarning(undefined)).toBeNull();
  });
});

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
