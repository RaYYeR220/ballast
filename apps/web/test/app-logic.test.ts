import { ballastAccountBaseAbi, ballastFactoryAbi, cushionVaultAbi, listaAccountAbi } from "@ballast/sdk";
import { decodeFunctionData, erc20Abi, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { parseAmount } from "../lib/amount";
import type { DeskEvent } from "../lib/desk";
import { eventRow, plannedRows, refusalRows } from "../lib/feed-rows";
import { countdown, nyDayTime, nyWeekdayClock, pctBps, shortHex, units } from "../lib/format";
import { defaultMandate, mandateProblems, pctToBps } from "../lib/mandate";
import { deleveragePathFor, MARKETS, marketById, tokenSymbol } from "../lib/markets";
import { comingGap, ltvAfterGap } from "../lib/server/views";
import { accountSteps, approvalStep, createAccountStep, openCoverSteps, topUpCoverSteps } from "../lib/steps";
import type { CoverView, LoanView, MarketView } from "../lib/views";
import { CLOSE, E18, KEEPER, nvda, OPEN, OWNER, TUE_1100, VIEW } from "./fixtures";
import { addr, DEPLOYMENT } from "./helpers";

describe("format", () => {
  it("writes amounts, percentages and hashes", () => {
    expect(units(9_170n * E18, 18)).toBe("9,170");
    expect(units("1234560000000000000000", 18)).toBe("1,234.56");
    expect(pctBps(4100)).toBe("41.0%");
    expect(shortHex(`0x51c2${"0".repeat(56)}a09f`)).toBe("0x51c2...a09f");
  });

  it("writes New York times across the DST change", () => {
    expect(nyDayTime(TUE_1100)).toBe("Tue 11:00");
    expect(nyWeekdayClock(CLOSE)).toBe("Tuesday 4:00 PM");
    expect(nyDayTime(1_793_716_200)).toBe("Tue 09:30"); // Tue 3 Nov 2026 09:30 EST, after the fall back
  });

  it("counts down", () => {
    expect(countdown(8 * 3600 + 24 * 60)).toBe("8 h 24 min");
    expect(countdown(4 * 60)).toBe("4 min");
    expect(countdown(2 * 86_400 + 3 * 3600 + 5)).toBe("2 d 3 h");
    expect(countdown(-5)).toBe("0 min");
  });

  it("parses amounts strictly", () => {
    expect(parseAmount("120.5", 18)).toBe(1205n * 10n ** 17n);
    expect(parseAmount("1,000", 18)).toBe(1000n * E18);
    for (const bad of ["", ".", "0", "-1", "1e3", "abc", "1.2.3"]) expect(parseAmount(bad, 18)).toBeNull();
    expect(parseAmount("0.1234567", 6)).toBeNull();
  });
});

describe("mandate", () => {
  it("sizes the defaults to the liquidation LTV", () => {
    expect(defaultMandate(7500)).toEqual({ maxLtvBps: 6000, shieldLtvBps: 4500, maxSlippageBps: 100, autoRestore: true });
    expect(defaultMandate(8500)).toEqual({ maxLtvBps: 6800, shieldLtvBps: 5100, maxSlippageBps: 100, autoRestore: true });
    for (const lltv of [5000, 6500, 7500, 8500, 9500]) expect(mandateProblems(defaultMandate(lltv), lltv, "lista")).toEqual([]);
  });

  it("mirrors the contract's bounds", () => {
    const ok = { maxLtvBps: 6000, shieldLtvBps: 4500, maxSlippageBps: 100, autoRestore: true };
    expect(mandateProblems({ ...ok, maxLtvBps: 7500 }, 7500, "lista")).toHaveLength(1);
    expect(mandateProblems({ ...ok, maxLtvBps: 7500 }, 7500, "venus")).toEqual([]);
    expect(mandateProblems({ ...ok, maxLtvBps: 9100 }, null, "venus")).toHaveLength(1);
    expect(mandateProblems({ ...ok, shieldLtvBps: 6000 }, 7500, "lista")).toHaveLength(1);
    expect(mandateProblems({ ...ok, maxSlippageBps: 501 }, 7500, "lista")).toHaveLength(1);
    expect(mandateProblems({ ...ok, maxLtvBps: Number.NaN }, 7500, "lista").length).toBeGreaterThan(0);
  });

  it("reads percent inputs", () => {
    expect(pctToBps("45")).toBe(4500);
    expect(pctToBps(" 0.5 ")).toBe(50);
    expect(pctToBps("abc")).toBeNaN();
    expect(pctToBps("")).toBeNaN();
  });
});

describe("markets", () => {
  it("lists the configured Lista and Venus markets with their tickers", () => {
    expect(MARKETS.map((m) => m.id)).toEqual(["lista:SPYB_USD1", "lista:NVDAB_USD1", "lista:QQQB_USD1", "venus:vTSLAB", "venus:vNVDAB"]);
    expect(nvda).toMatchObject({ symbol: "NVDA", collateralSymbol: "NVDAB", loanSymbol: "USD1", configLltvBps: 7500 });
    expect(marketById("venus:vTSLAB")).toMatchObject({ symbol: "TSLA", loanSymbol: "USDT" });
    expect(tokenSymbol(nvda.collateralToken)).toBe("NVDAB");
    expect(tokenSymbol(nvda.loanToken)).toBe("USD1");
    expect(tokenSymbol(addr(1))).toBeNull();
  });

  it("builds the deleverage route from the configured pools", () => {
    const p = deleveragePathFor(nvda)!;
    // collateral (20) + fee (3) + USDT (20) + fee (3) + loan (20) bytes
    expect(p.hex.length).toBe(2 + 2 * 66);
    expect(p.hex.toLowerCase().startsWith(nvda.collateralToken.toLowerCase())).toBe(true);
    expect(p.hex.toLowerCase().endsWith(nvda.loanToken.slice(2).toLowerCase())).toBe(true);
    expect(p.hex.slice(42, 48)).toBe("0009c4"); // 2500
    expect(deleveragePathFor(marketById("lista:QQQB_USD1")!)).toBeNull();
  });
});

describe("gap maths", () => {
  it("applies the gap to the collateral value", () => {
    expect(ltvAfterGap(4100, 440)).toBeCloseTo(4288.7, 1);
    expect(ltvAfterGap(4100, 10_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("takes the closure under way before the next one", () => {
    const ahead = { window: "OVERNIGHT" as const, startsAt: CLOSE, endsAt: OPEN, gapBps: 417 };
    expect(comingGap({ at: TUE_1100, currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 }, windowAhead: ahead })).toEqual({ ...ahead, inProgress: false });
    const sat = 1_791_640_800; // Sat 10 Oct 2026 10:00 New York
    const g = comingGap({ at: sat, currentWindow: { window: "WEEKEND", gapBps: 737, closedAt: 1_791_576_000 }, windowAhead: ahead })!;
    expect(g).toMatchObject({ window: "WEEKEND", gapBps: 737, inProgress: true, startsAt: 1_791_576_000 });
    expect(nyDayTime(g.endsAt)).toBe("Mon 09:30");
    expect(comingGap({ at: TUE_1100, currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 }, windowAhead: { window: "NONE", startsAt: 0, endsAt: 0, gapBps: 0 } })).toBeNull();
  });
});

describe("watch log rows", () => {
  const TX = `0x${"ab".repeat(32)}`;
  const u = { decimals: 18, symbol: "USD1" };
  const ev = (o: Partial<DeskEvent>): DeskEvent => ({ seq: 1, ts: TUE_1100, kind: "shield", ...o });

  it("describes shields, restores, refusals, alerts and checks from the feed", () => {
    const shield = eventRow(ev({ txHash: TX, window: { kind: "WEEKEND", startsAt: 0, endsAt: 0, gapBps: 737 }, plan: { step: { fn: "shieldRepay", assets: (3_400n * E18).toString() } } }), u);
    expect(shield).toMatchObject({ kind: "shield", title: "Shielded for the weekend", text: "repaid 3,400 USD1", txHash: TX, planned: false });
    expect(shield.status).toBeUndefined();
    const dry = eventRow(ev({ dryRun: true, plan: { step: { fn: "shieldRepay", assets: (100n * E18).toString() } } }), u);
    expect(dry).toMatchObject({ title: "Shield simulated", text: "would have repaid 100 USD1", status: "dry run" });
    expect(eventRow(ev({ kind: "restore", txHash: TX, plan: { step: { fn: "restore", assets: (2_900n * E18).toString() } } }), u)).toMatchObject({ title: "Restored", text: "borrowed 2,900 USD1 back" });
    const refused = eventRow(ev({ kind: "refused", plan: { step: { fn: "restore", assets: "1" } }, error: { name: "RestoreRefused", message: "restore refused by the Session Oracle: NOT_REGULAR", reason: "NOT_REGULAR" } }), u);
    expect(refused).toMatchObject({ kind: "refused", title: "Restore refused", text: "restore refused by the Session Oracle: NOT_REGULAR", status: "not sent" });
    expect(eventRow(ev({ kind: "alert", reason: "cushion too small" }))).toMatchObject({ kind: "alert", title: "Alert", text: "cushion too small" });
    expect(eventRow(ev({ kind: "noop", reason: "survives a 417 bps gap" }))).toMatchObject({ kind: "noop", title: "Checked" });
    expect(eventRow(ev({ kind: "pending", reason: "receipt pending" }))).toMatchObject({ kind: "other", title: "Pending" });
  });

  it("names cover shields, oracle posts and guardian events, and says when the unit is unknown", () => {
    const cover = eventRow(ev({ txHash: TX, cover: { user: OWNER, key: "0x01" }, plan: { step: { fn: "shieldFor", amount: (13n * E18).toString() } } }));
    expect(cover).toMatchObject({ kind: "shield", title: "Cover shielded", text: "repaid 13 of the loan" });
    expect(eventRow(ev({ kind: "publish", txHash: TX, symbols: ["NVDA", "SPY"] }))).toMatchObject({ kind: "publish", title: "Session Oracle overlays posted", text: "for 2 stocks" });
    expect(eventRow(ev({ kind: "settle", txHash: TX, reason: "the account survived the window: the desk is paid" }))).toMatchObject({ kind: "other", title: "Guard job settled", text: "the account survived the window: the desk is paid" });
    expect(eventRow(ev({ kind: "submit", reason: "window over: evidence submitted" })).title).toBe("Guard evidence submitted");
  });

  it("lists refusals with the call, the reason and who made it", () => {
    const rows = refusalRows(
      [
        ev({ seq: 2, kind: "refused", source: "keeper", txHash: TX, plan: { step: { fn: "restore", assets: (2_400n * E18).toString() } }, error: { name: "RestoreRefused", message: "m", reason: "NOT_REGULAR" } }),
        ev({ seq: 3, kind: "shield" }),
        ev({ seq: 4, kind: "refused", plan: { step: { fn: "shieldDeleverage", repayAssets: (500n * E18).toString() } }, error: { name: "NotInShieldWindow", message: "outside the window" } }),
      ],
      u,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ call: "restore(2,400 USD1)", from: "from the desk agent", reason: "RestoreRefused(NOT_REGULAR)", txHash: TX });
    expect(rows[1]).toMatchObject({ call: "shieldDeleverage(500 USD1)", reason: "NotInShieldWindow", message: "outside the window" });
  });

  it("plans the next shield from the keeper's plan, one hour before the close", () => {
    const rows = plannedRows(VIEW, TUE_1100, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planned: true, kind: "shield", ts: CLOSE - 3600, title: "Shield for tonight", status: "planned" });
    // (12,070 - 2,900) / (120 * 186.40) = 41.0%
    expect(rows[0]!.text).toBe("repay about 2,900 USD1 to reach 41.0%");
  });

  it("says when no shield is needed and plans the restore after a shield", () => {
    const calm = { ...VIEW, plan: { ...VIEW.plan!, kind: "noop", steps: [], reason: "survives a 417 bps gap at HF 1.33" } };
    expect(plannedRows(calm, TUE_1100, [])[0]).toMatchObject({ title: "No shield needed for tonight", text: "the loan survives a 4.2% gap" });
    const shielded = [ev({ kind: "shield", txHash: TX })];
    const rows = plannedRows(calm, TUE_1100, shielded);
    expect(rows.map((r) => r.kind)).toEqual(["restore", "shield"]);
    expect(rows[0]!.ts).toBe(OPEN + 5400);
    expect(plannedRows({ ...calm, mandate: { ...calm.mandate, autoRestore: false } }, TUE_1100, shielded).map((r) => r.kind)).toEqual(["shield"]);
  });

  it("plans nothing without a closure or after a liquidation", () => {
    expect(plannedRows({ ...VIEW, coming: null }, TUE_1100, [])).toEqual([]);
    expect(plannedRows({ ...VIEW, liquidated: true }, TUE_1100, [])).toEqual([]);
    expect(plannedRows({ ...VIEW, debt: "0" }, TUE_1100, [])).toEqual([]);
  });
});

describe("transaction steps", () => {
  const market: MarketView = {
    id: nvda.id,
    venue: "lista",
    label: nvda.label,
    symbol: "NVDA",
    collateralSymbol: "NVDAB",
    loanSymbol: "USD1",
    collateralToken: nvda.collateralToken,
    loanToken: nvda.loanToken,
    lltvBps: 7500,
    marketParams: VIEW.lista!.marketParams,
    path: deleveragePathFor(nvda),
  };
  const mandate = defaultMandate(7500);

  it("builds the create call for the factory with the desk agent as keeper", () => {
    const st = createAccountStep(DEPLOYMENT, market, KEEPER, mandate);
    expect(st.tx.to).toBe(DEPLOYMENT.factory);
    const call = decodeFunctionData({ abi: ballastFactoryAbi, data: st.tx.data });
    expect(call.functionName).toBe("createListaAccount");
    expect(call.args![2]).toBe(KEEPER);
    expect(call.args![3]).toEqual(mandate);
    expect(st.call).toBe("createListaAccount(NVDAB / USD1, NVDA)");
    expect(() => createAccountStep(DEPLOYMENT, { ...market, marketParams: null }, KEEPER, mandate)).toThrow();
  });

  it("adds an exact approval only when the allowance is short", () => {
    const amount = 120n * E18;
    const two = accountSteps(VIEW, { action: "deposit-collateral", owner: OWNER, amount, allowance: 0n });
    expect(two.map((s) => s.key)).toEqual([`approve-${VIEW.collateralToken}`, "deposit-collateral"]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: two[0]!.tx.data });
    expect(two[0]!.tx.to).toBe(VIEW.collateralToken);
    expect(approve.args).toEqual([VIEW.address, amount]);
    expect(decodeFunctionData({ abi: ballastAccountBaseAbi, data: two[1]!.tx.data })).toMatchObject({ functionName: "depositCollateral", args: [amount] });
    expect(accountSteps(VIEW, { action: "deposit-collateral", owner: OWNER, amount, allowance: amount }).map((s) => s.key)).toEqual(["deposit-collateral"]);
    expect(approvalStep({ token: VIEW.loanToken, symbol: "USD1", decimals: 18, spender: VIEW.address, spenderName: "your account", amount: 1n, allowance: 5n })).toEqual([]);
  });

  it("builds every owner action against the account", () => {
    const amount = 10n * E18;
    const fn = (action: Parameters<typeof accountSteps>[1]["action"], extra = {}) => {
      const steps = accountSteps(VIEW, { action, owner: OWNER, amount, allowance: amount, ...extra });
      const last = steps[steps.length - 1]!;
      expect(last.tx.to).toBe(VIEW.address);
      return decodeFunctionData({ abi: listaAccountAbi, data: last.tx.data });
    };
    expect(fn("borrow")).toMatchObject({ functionName: "borrow", args: [amount, OWNER] });
    expect(fn("deposit-cushion")).toMatchObject({ functionName: "depositCushion", args: [amount] });
    expect(fn("withdraw-cushion")).toMatchObject({ functionName: "withdrawCushion", args: [amount, OWNER] });
    expect(fn("withdraw-collateral")).toMatchObject({ functionName: "withdrawCollateral", args: [amount, OWNER] });
    expect(fn("repay-all").functionName).toBe("repayAll");
    expect(fn("set-mandate", { mandate })).toMatchObject({ functionName: "setMandate", args: [mandate] });
    const path = market.path!;
    const set = fn("set-path", { path });
    expect(set).toMatchObject({ functionName: "setDeleveragePath", args: [path.hex] });
    expect(keccak256(path.hex)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => accountSteps(VIEW, { action: "borrow", owner: OWNER })).toThrow("enter an amount");
    expect(() => accountSteps(VIEW, { action: "set-path", owner: OWNER })).toThrow();
  });

  it("opens and tops up a cover through the vault, approval first", () => {
    const loan: LoanView = {
      venue: "lista",
      key: `0x${"77".repeat(32)}`,
      label: nvda.label,
      symbol: "NVDA",
      collateralSymbol: "NVDAB",
      loanSymbol: "USD1",
      loanToken: nvda.loanToken,
      collateral: (100n * E18).toString(),
      collateralDecimals: 18,
      debt: (9_000n * E18).toString(),
      loanDecimals: 18,
      ltvBps: 5000,
      lltvBps: 7500,
      marketParams: VIEW.lista!.marketParams,
    };
    const steps = openCoverSteps(DEPLOYMENT, loan, { keeper: KEEPER, amount: 500n * E18, capPerDay: 250n * E18, allowance: 0n });
    expect(steps).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: steps[0]!.tx.data }).args).toEqual([DEPLOYMENT.cushionVault, 500n * E18]);
    const open = decodeFunctionData({ abi: cushionVaultAbi, data: steps[1]!.tx.data });
    expect(open.functionName).toBe("openListaCover");
    expect(open.args!.slice(2)).toEqual([KEEPER, 250n * E18, 500n * E18]);
    const cover: CoverView = { user: OWNER, key: loan.key, venue: "lista", symbol: "NVDA", token: nvda.loanToken, tokenSymbol: "USD1", tokenDecimals: 18, keeper: KEEPER, capPerDay: "0", balance: "0", dayStart: 0, usedToday: "0", label: nvda.label };
    const top = topUpCoverSteps(DEPLOYMENT, cover, 5n * E18, 5n * E18);
    expect(top).toHaveLength(1);
    expect(decodeFunctionData({ abi: cushionVaultAbi, data: top[0]!.tx.data })).toMatchObject({ functionName: "topUp", args: [loan.key, 5n * E18] });
  });
});
