import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, pad, parseEther, parseUnits, toHex, type Address, type Hex } from "viem";
import {
  GUARD_MIN_WINDOW_SEC,
  GUARD_START_SLACK_SEC,
  MAX_GAS_WEI,
  SpendGuard,
  addRiskWindow,
  amountOption,
  appendProof,
  bscScanTx,
  checkBinanceSwap,
  checkRestore,
  expectRefusal,
  guardWindow,
  intOption,
  lastJobId,
  minOut,
  parseArgs,
  parseWhen,
  planVenusOpen,
  priorSpend,
  readProofs,
  utc,
  type ProofTx,
} from "../../../scripts/demo/mainnet-lib";

const OWNER = "0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf" as Address;
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address;
const TSLAB = "0x5b1910eAaD6450E50f816082Aa078C41F10C292f" as Address;
const ROUTER = "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5" as Address;
const AMOUNT = parseUnits("5.6", 18);
const OUT = 14_935_990_037_201_957n;
const MIN = 14_711_950_186_643_927n; // OUT less 1.5%

describe("parseArgs", () => {
  it("is a dry run unless --send is given, and takes options and the fork RPC", () => {
    expect(parseArgs(["open-venus"])).toEqual({ command: "open-venus", send: false, forkRpc: null, confirmMainnet: false, again: false, noBinanceSim: false, options: {} });
    expect(parseArgs(["open-venus", "--send", "--fork-rpc", "http://127.0.0.1:8572", "--usdt", "5.6", "--confirm-mainnet"])).toEqual({
      command: "open-venus",
      send: true,
      forkRpc: "http://127.0.0.1:8572",
      confirmMainnet: true,
      again: false,
      noBinanceSim: false,
      options: { usdt: "5.6" },
    });
    expect(parseArgs(["refused-restore", "--again", "--amount", "0.05"])).toMatchObject({ again: true, send: false, noBinanceSim: false, options: { amount: "0.05" } });
    expect(parseArgs(["restore", "--no-binance-sim"]).noBinanceSim).toBe(true);
  });

  it("refuses a missing subcommand, stray words and options without a value", () => {
    expect(() => parseArgs([])).toThrow(/subcommand/);
    expect(() => parseArgs(["--send"])).toThrow(/subcommand/);
    expect(() => parseArgs(["status", "now"])).toThrow(/unexpected/);
    expect(() => parseArgs(["status", "--usdt"])).toThrow(/needs a value/);
    expect(() => parseArgs(["status", "--usdt", "--send"])).toThrow(/needs a value/);
  });

  it("parses amounts and whole numbers strictly", () => {
    expect(amountOption({}, "usdt", "5.6")).toBe(AMOUNT);
    expect(amountOption({ usdt: "0.3" }, "usdt", "5.6")).toBe(parseUnits("0.3", 18));
    for (const bad of ["-1", "1e3", "abc", "0"]) expect(() => amountOption({ usdt: bad }, "usdt", "5.6")).toThrow(/--usdt/);
    expect(intOption({}, "ltv-bps", 5800, 1, 9000)).toBe(5800);
    expect(intOption({ "ltv-bps": "5500" }, "ltv-bps", 5800, 1, 9000)).toBe(5500);
    for (const bad of ["55.5", "-1", "9001"]) expect(() => intOption({ "ltv-bps": bad }, "ltv-bps", 5800, 1, 9000)).toThrow(/--ltv-bps/);
  });
});

describe("SpendGuard", () => {
  it("stops before the 6 USDT cap, counting what earlier runs spent", () => {
    const g = new SpendGuard({ usdt: parseUnits("5.6", 18) });
    g.addUsdt(parseUnits("0.3", 18));
    expect(() => g.addUsdt(parseUnits("0.11", 18))).toThrow(/USDT cap: 5.9 already spent/);
    g.addUsdt(parseUnits("0.1", 18));
    expect(g.usdt).toBe(parseUnits("6", 18));
    expect(() => g.addUsdt(-1n)).toThrow();
  });

  it("stops before the 0.001 BNB gas cap and never signs above 1 gwei", () => {
    const g = new SpendGuard();
    g.addGas(500_000n, 60_000_000n); // 0.00003 BNB
    expect(g.gasWei).toBe(parseEther("0.00003"));
    expect(() => g.addGas(1n, 1_000_000_001n)).toThrow(/gas price .* above the 1 gwei cap/);
    expect(() => g.addGas(1_000_000n, 1_000_000_000n)).toThrow(/gas cap/);
    g.addGas(970_000n, 1_000_000_000n);
    expect(g.gasWei).toBe(MAX_GAS_WEI);
  });
});

describe("proof file", () => {
  it("appends sent transactions and sums the caps per chain", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "demo-proof-")), "nested", "proof-txs.json");
    expect(readProofs(file)).toEqual([]);
    appendProof(file, { label: "buy TSLAB", txHash: `0x${"11".repeat(32)}`, at: "2026-10-09T14:00:00.000Z", note: "5.6 USDT", chainId: 56, usdtSpent: AMOUNT.toString(), feeWei: "30" });
    appendProof(file, { label: "borrow", txHash: `0x${"22".repeat(32)}`, at: "2026-10-09T14:01:00.000Z", note: "3.24 USDT", chainId: 56, feeWei: "12" });
    appendProof(file, { label: "fork", txHash: `0x${"33".repeat(32)}`, at: "2026-10-09T14:02:00.000Z", note: "", chainId: 31337, usdtSpent: "7", feeWei: "7" });
    const all = readProofs(file);
    expect(all.map((p) => p.label)).toEqual(["buy TSLAB", "borrow", "fork"]);
    expect(JSON.parse(await readFile(file, "utf8"))[0]).toMatchObject({ label: "buy TSLAB", txHash: `0x${"11".repeat(32)}`, at: "2026-10-09T14:00:00.000Z", note: "5.6 USDT" });
    expect(priorSpend(all, 56)).toEqual({ usdt: AMOUNT, gasWei: 42n });
    expect(priorSpend(all, 31337)).toEqual({ usdt: 7n, gasWei: 7n });
    expect(bscScanTx("0xabc")).toBe("https://bscscan.com/tx/0xabc");
  });
});

// The shapes the Binance Trading API returned for 5.6 USDT -> TSLAB on 2026-10-08.
const token = (a: Address, sym: string) => ({ tokenContractAddress: a.toLowerCase(), tokenSymbol: sym, decimal: "18", isHoneyPot: false, taxRate: "0" });
const quote = (o: Record<string, unknown> = {}) => ({
  quoteId: "18a3abf327f246e29d453ad8ce490dae",
  vendorName: "LiquidMesh",
  executionMode: "SWAP",
  fromTokenAmount: AMOUNT.toString(),
  toTokenAmount: OUT.toString(),
  fromToken: token(USDT, "USDT"),
  toToken: token(TSLAB, "TSLAB"),
  approveTarget: ROUTER,
  isBest: true,
  ...o,
});
const approveData = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const approve = (o: Record<string, unknown> = {}) => [{ data: approveData(ROUTER, AMOUNT), dexContractAddress: ROUTER, gasLimit: "70000", gasPrice: "58861186", ...o }];
const word = (n: bigint) => pad(toHex(n), { size: 32 }).slice(2);
const swapData = (min: bigint): Hex => `0xad43f73d${word(AMOUNT)}${word(min)}${"00".repeat(64)}`;
const swap = (tx: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({
  executionMode: "SWAP",
  routerResult: { toTokenAmount: OUT.toString() },
  tx: { from: OWNER, to: ROUTER, data: swapData(MIN), value: "0", gas: "250000", minReceiveAmount: MIN.toString(), slippagePercent: "1.5", ...tx },
  ...o,
});
const check = (o: { quote?: unknown; approve?: unknown; swap?: unknown } = {}) =>
  checkBinanceSwap({ owner: OWNER, tokenIn: USDT, tokenOut: TSLAB, amountIn: AMOUNT, slippageBps: 150, quote: o.quote ?? quote(), approve: o.approve ?? approve(), swap: o.swap ?? swap() });

describe("checkBinanceSwap", () => {
  it("takes 1.5% off the quoted amount as the floor", () => {
    expect(minOut(OUT)).toBe(MIN);
    expect(minOut(1_000n, 0)).toBe(1_000n);
    expect(() => minOut(1n, 10_000)).toThrow();
  });

  it("accepts a consistent quote, approval and swap and returns what to sign", () => {
    expect(check()).toEqual({
      vendor: "LiquidMesh",
      spender: ROUTER,
      approve: { to: USDT, data: approveData(ROUTER, AMOUNT), value: 0n },
      swap: { to: ROUTER, data: swapData(MIN), value: 0n },
      expectedOut: OUT,
      minOut: MIN,
    });
  });

  it.each([
    ["an RFQ order instead of a swap", { quote: quote({ executionMode: "RFQ" }) }, /not a plain swap/],
    ["a quote for another amount", { quote: quote({ fromTokenAmount: "1" }) }, /another amount/],
    ["a quote for another token", { quote: quote({ toToken: token(USDT, "USDT") }) }, /quote.toToken is another token/],
    ["a flagged token", { quote: quote({ toToken: { ...token(TSLAB, "TSLAB"), isHoneyPot: true } }) }, /flagged/],
    ["a taxed token", { quote: quote({ toToken: { ...token(TSLAB, "TSLAB"), taxRate: "0.05" } }) }, /flagged/],
    ["a quote that returns nothing", { quote: quote({ toTokenAmount: "0" }) }, /returns nothing/],
    ["two approvals", { approve: [...approve(), ...approve()] }, /expected one approval/],
    ["an approval naming another spender", { approve: approve({ dexContractAddress: OWNER }) }, /spender other than/],
    ["approve calldata for another spender", { approve: approve({ data: approveData(OWNER, AMOUNT) }) }, /approves another spender/],
    ["an unlimited approval", { approve: approve({ data: approveData(ROUTER, 2n ** 256n - 1n) }) }, /another amount/],
    ["approve calldata that is a transfer", { approve: approve({ data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ROUTER, AMOUNT] }) }) }, /calls transfer/],
    ["a swap built for another wallet", { swap: swap({ from: ROUTER }) }, /another wallet/],
    ["a swap to another contract", { swap: swap({ to: OWNER }) }, /contract other than/],
    ["a swap that attaches BNB", { swap: swap({ value: "1" }) }, /attaches BNB/],
    ["a swap without calldata", { swap: swap({ data: "0x" }) }, /not calldata/],
    ["a minimum below our floor", { swap: swap({ minReceiveAmount: (MIN - 2n).toString(), data: swapData(MIN - 2n) }) }, /below our floor/],
    ["a minimum that is not in the calldata", { swap: swap({ data: swapData(1n) }) }, /not found in the swap calldata/],
    ["an order to sign instead of a transaction", { swap: swap({}, { executionMode: "RFQ" }) }, /not a plain swap/],
  ])("refuses %s", (_what, o, message) => {
    expect(() => check(o)).toThrow(message);
  });
});

describe("planVenusOpen", () => {
  // vTSLAB on Venus core: collateral factor 0.60, liquidation threshold 0.70; TSLA weekend gap 551 bps.
  const base = { collateralTokens: 0.014936, collateralPriceUsd: 374.93, loanPriceUsd: 0.9992, collateralFactor: 0.6, liquidationThreshold: 0.7, gapBps: 551, targetHfAfterGap: 1.05 };

  it("sizes the loan in cents and reports the health now and after the gap", () => {
    const p = planVenusOpen({ ...base, ltvBps: 5800 });
    expect(p.collateralValueUsd).toBeCloseTo(5.6, 2);
    expect(p.borrowTokens).toBe(3.25);
    expect(p.ltvBps).toBeGreaterThanOrEqual(5790);
    expect(p.ltvBps).toBeLessThanOrEqual(5800);
    expect(p.hfNow).toBeCloseTo(0.7 / (p.ltvBps / 10_000), 2);
    expect(p.hfAfterGap).toBeCloseTo(p.hfNow * 0.9449, 3);
  });

  it("shows that at the desk's target of 1.05 no loan Venus allows is shielded before a weekend", () => {
    const p = planVenusOpen({ ...base, ltvBps: 5900 });
    expect(p.shieldAboveLtvBps).toBe(6299); // above the 60% Venus lets you borrow
    expect(p.shield.kind).toBe("noop");
    expect(p.shield).toMatchObject({ reason: expect.stringMatching(/survives a 551 bps gap/) });
    expect(p.restoreUsd).toBe(0);
  });

  it("plans a cushion repay and the matching restore once the target asks for more health than the loan has", () => {
    const p = planVenusOpen({ ...base, ltvBps: 5350, targetHfAfterGap: 1.3 });
    expect(p.hfNow).toBeGreaterThan(1.3);
    expect(p.shieldAboveLtvBps).toBe(5088);
    expect(p.shield.kind).toBe("repay");
    const repay = p.shield.kind === "repay" ? p.shield.repayUsd : 0;
    expect(repay).toBeGreaterThan(0.1);
    expect(repay).toBeLessThan(0.2);
    expect(p.restoreUsd).toBe(repay);
  });

  it("keeps the loan clear of the Venus collateral factor", () => {
    expect(() => planVenusOpen({ ...base, ltvBps: 5901 })).toThrow(/too close to the Venus collateral factor \(6000 bps\): at most 5900/);
    expect(() => planVenusOpen({ ...base, ltvBps: 0 })).toThrow();
    expect(() => planVenusOpen({ ...base, collateralTokens: 0.00001, ltvBps: 5000 })).toThrow(/too small/);
  });
});

describe("times", () => {
  const NOW = Date.UTC(2026, 9, 9, 15, 5) / 1000;
  it("reads relative, unix and ISO times", () => {
    expect(parseWhen("+10", NOW)).toBe(NOW + 600);
    expect(parseWhen(String(NOW + 5), NOW)).toBe(NOW + 5);
    expect(parseWhen("2026-10-09T15:15:00Z", NOW)).toBe(NOW + 600);
    expect(parseWhen("2026-10-09T15:15Z", NOW)).toBe(NOW + 600);
    expect(utc(NOW)).toBe("2026-10-09T15:05:00Z");
    for (const bad of ["10", "soon", "2026-10-09 15:15", "2026-10-09T15:15:00+02:00", "+", "-5"]) expect(() => parseWhen(bad, NOW)).toThrow(/cannot read the time/);
  });

  it("finds the part of the session in which risk may be added", () => {
    const openAt = Date.UTC(2026, 9, 9, 13, 30) / 1000;
    const closeAt = Date.UTC(2026, 9, 9, 20, 0) / 1000;
    expect(addRiskWindow({ openAt, closeAt, restoreDelay: 5400, horizon: 3600 })).toEqual({ from: openAt + 5400, until: closeAt - 3600 });
    // A delay and a horizon that meet leave no window at all.
    expect(addRiskWindow({ openAt, closeAt, restoreDelay: 3 * 3600, horizon: 3.5 * 3600 })).toBeNull();
    expect(addRiskWindow({ openAt, closeAt, restoreDelay: 4 * 3600, horizon: 4 * 3600 })).toBeNull();
  });
});

describe("checkRestore", () => {
  const ok = { canAddRisk: true, reason: "OK", debtUsd: 2.99, addUsd: 0.05, collateralValueUsd: 5.6, maxLtvBps: 6000, venueLimitBps: 6000 };
  it("passes inside both caps and reports the LTV after, rounded up", () => {
    expect(checkRestore(ok)).toEqual({ ltvAfterBps: 5429 });
  });
  it("refuses when the oracle says no, with its reason", () => {
    expect(() => checkRestore({ ...ok, canAddRisk: false, reason: "NOT_REGULAR" })).toThrow(/refuses added risk now \(NOT_REGULAR\)/);
  });
  it("refuses above the mandate cap or the venue limit", () => {
    expect(() => checkRestore({ ...ok, addUsd: 0.5 })).toThrow(/above the mandate cap 6000/);
    expect(() => checkRestore({ ...ok, addUsd: 0.5, maxLtvBps: 7000 })).toThrow(/venue's borrow limit 6000/);
    expect(checkRestore({ ...ok, addUsd: 0.37 })).toEqual({ ltvAfterBps: 6000 });
    // One basis point over the mandate cap is already refused.
    expect(() => checkRestore({ ...ok, addUsd: 0.3704, venueLimitBps: 7000 })).toThrow(/would be 6001 bps, above the mandate cap 6000/);
    expect(() => checkRestore({ ...ok, collateralValueUsd: 0 })).toThrow(/no priced collateral/);
    expect(() => checkRestore({ ...ok, addUsd: 0 })).toThrow(/nothing to restore/);
  });
});

describe("expectRefusal", () => {
  it("accepts only the expected oracle reason", () => {
    expect(expectRefusal({ name: "RestoreRefused", reason: "NOT_REGULAR" }, "NOT_REGULAR")).toBe("RestoreRefused(NOT_REGULAR)");
    expect(() => expectRefusal(null, "NOT_REGULAR")).toThrow(/would SUCCEED/);
    expect(() => expectRefusal({ name: "RestoreRefused", reason: "WINDOW_AHEAD" }, "NOT_REGULAR")).toThrow(/refused for WINDOW_AHEAD, not for NOT_REGULAR/);
    expect(() => expectRefusal({ name: "ExceedsMandate" }, "NOT_REGULAR")).toThrow(/fails with ExceedsMandate/);
    expect(() => expectRefusal({ name: "RestoreRefused" }, "NOT_REGULAR")).toThrow(/unknown reason/);
  });
});

describe("guardian window", () => {
  const NOW = Date.UTC(2026, 9, 9, 15, 5) / 1000;
  const MONDAY_OPEN = Date.UTC(2026, 9, 12, 13, 30) / 1000;
  const base = { now: NOW, start: NOW + 600, end: NOW + 600 + 3900, reopen: MONDAY_OPEN, minGrace: 3600 };
  it("gives the expiry the guardian accepts: next open plus grace plus a margin", () => {
    expect(guardWindow(base)).toEqual({ start: NOW + 600, end: NOW + 4500, expiredAt: MONDAY_OPEN + 3600 + 3600 });
    expect(guardWindow({ ...base, marginSec: 0 }).expiredAt).toBe(MONDAY_OPEN + 3600);
  });
  it("refuses what the contract would refuse", () => {
    expect(() => guardWindow({ ...base, end: base.start + GUARD_MIN_WINDOW_SEC - 1 })).toThrow(/at least one hour/);
    expect(guardWindow({ ...base, end: base.start + GUARD_MIN_WINDOW_SEC }).end).toBe(base.start + 3600);
    expect(() => guardWindow({ ...base, start: NOW - 3600, end: NOW - 1 })).toThrow(/ends in the past/);
    // A start up to 5 minutes old is accepted at funding time; the sends take a while.
    expect(() => guardWindow({ ...base, start: NOW - GUARD_START_SLACK_SEC + 119 })).toThrow(/too far in the past/);
    expect(guardWindow({ ...base, start: NOW - GUARD_START_SLACK_SEC + 120 }).start).toBe(NOW - 180);
    expect(() => guardWindow({ ...base, reopen: 0 })).toThrow(/no regular open/);
  });
  it("finds the last job id recorded for the chain", () => {
    const p = (jobId: string | undefined, chainId = 56): ProofTx => ({ label: "x", txHash: `0x${"1".repeat(64)}`, at: "t", note: "n", chainId, ...(jobId === undefined ? {} : { jobId }) });
    expect(lastJobId([], 56)).toBeNull();
    expect(lastJobId([p("7"), p(undefined), p("9", 31337)], 56)).toBe(7n);
    expect(lastJobId([p("7"), p("12"), p(undefined)], 56)).toBe(12n);
    expect(lastJobId([p("abc")], 56)).toBeNull();
  });
});
