import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { planShield } from "@ballast/risk";
import { planForAccount, positionForPlanner, type AccountState, type PlanOracle } from "../src/index";
import { addr } from "./fake-chain";
import { E18, KEEPER, MARKET_ID, mp, NVDAB, OWNER, USD1, USDT, V_NVDAB, V_USDT } from "./fixtures";

const PATH_HASH = `0x${"22".repeat(32)}` as const;

function lista(o: Partial<AccountState> & { minLoan?: bigint; price?: number | null; pathSet?: boolean } = {}): AccountState {
  const { minLoan = E18, price = 250, pathSet = true, ...rest } = o;
  return {
    address: addr(0xd1),
    blockNumber: 1_000n,
    venue: "lista",
    owner: OWNER,
    keeper: KEEPER,
    symbol: "NVDA",
    mandate: { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true },
    collateral: 10n * E18,
    debt: 1800n * E18,
    cushion: 100n * E18,
    ltvBps: 7200,
    healthKnown: true,
    healthy: true,
    liquidated: false,
    liquidationRecorded: false,
    trackedCollateral: 10n * E18,
    loanToken: USD1,
    collateralToken: NVDAB,
    loanDecimals: 18,
    collateralDecimals: 18,
    market: {
      venue: "lista",
      moolah: addr(0xc3),
      marketId: MARKET_ID,
      marketParams: mp,
      deleveragePathHash: pathSet ? PATH_HASH : `0x${"00".repeat(32)}`,
      deleveragePathSet: pathSet,
      oraclePrice: price === null ? null : BigInt(price) * 10n ** 36n,
      minLoan,
    },
    pricing: { collateralPriceUsd: price, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: Number(minLoan / E18), minLoanKnown: true },
    ...rest,
  };
}

function venus(o: Partial<AccountState> = {}): AccountState {
  return {
    ...lista(),
    venue: "venus",
    loanToken: USDT,
    market: {
      venue: "venus",
      comptroller: addr(0xc9),
      vCollateral: V_NVDAB,
      vDebt: V_USDT,
      venusOracle: addr(0xca),
      collateralFactor: 5n * 10n ** 17n,
      liquidationThreshold: 75n * 10n ** 16n,
      collateralPrice: 250n * E18,
      debtPrice: E18,
    },
    pricing: { collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: 0, minLoanKnown: true },
    ...o,
  };
}

const params = { restoreDelay: 5400, horizon: 10_800, convergenceBps: 60, maxRefAge: 93_600, maxOverlayTtl: 21_600, maxOndoDriftBps: 100, maxRefDeviationBps: 300 };
/** Regular session, one hour before an overnight closure: inside the 3 h deleverage window. */
const regular: PlanOracle = {
  at: 1_790_000_000,
  params,
  session: "REGULAR",
  canAddRisk: false,
  reason: "WINDOW_AHEAD",
  windowAhead: { window: "OVERNIGHT", startsAt: 1_790_003_600, endsAt: 1_790_066_000, gapBps: 417 },
  currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 },
};
/** Regular session, the closure more than the horizon away. */
const morning: PlanOracle = { ...regular, at: 1_789_980_000 };
const overnight: PlanOracle = {
  ...regular,
  session: "OVERNIGHT",
  reason: "NOT_REGULAR",
  currentWindow: { window: "OVERNIGHT", gapBps: 417, closedAt: 1_789_990_000 },
};

describe("positionForPlanner", () => {
  it("converts venue units with token decimals", () => {
    const s = lista({ collateral: 5n * 10n ** 8n, collateralDecimals: 8, debt: 1_234_500_000n, loanDecimals: 6 });
    expect(positionForPlanner(s, 250, 0.75, 1)).toEqual({ collateralTokens: 5, collateralPriceUsd: 250, debtUsd: 1234.5, lltv: 0.75, minLoanUsd: 1 });
  });

  it("prices Venus debt with the loan token oracle price", () => {
    const s = venus({ debt: 1000n * E18, pricing: { collateralPriceUsd: 250, loanPriceUsd: 0.998, lltv: 0.75, minLoanUsd: 0, minLoanKnown: true } });
    expect(positionForPlanner(s, 250, 0.75, 0).debtUsd).toBeCloseTo(998, 9);
  });
});

describe("planForAccount: shield", () => {
  it("is a noop when the position survives the coming gap", () => {
    const p = planForAccount(lista({ debt: 1500n * E18 }), regular);
    expect(p.kind).toBe("noop");
    expect(p.mode).toBe("shield");
    expect(p.gapBps).toBe(417);
    expect(p.amounts.repayAssets).toBe(0n);
  });

  it("repays from the cushion with on-chain amounts matching the planner", () => {
    const s = lista();
    const p = planForAccount(s, regular);
    const ref = planShield({
      position: positionForPlanner(s, 250, 0.75, 1),
      gapBps: 417,
      targetHfAfterGap: 1.05,
      cushionUsd: 100,
      maxSlippageBps: 150,
      canSellCollateral: true,
    });
    expect(p.kind).toBe("repay");
    expect(ref.kind).toBe("repay");
    if (p.kind !== "repay" || ref.kind !== "repay") return;
    expect(p.repayUsd).toBe(ref.repayUsd);
    expect(p.amounts.repayAssets).toBe(parseUnits(ref.repayUsd.toFixed(6), 18));
    expect(p.amounts.sellCollateral).toBe(0n);
    expect(p.targetHfAfterGap).toBe(1.05);
    expect(p.steps).toEqual([{ fn: "shieldRepay", assets: p.amounts.repayAssets }]);
  });

  it("repays the whole debt with headroom when the minimum loan forces a full close", () => {
    const s = lista({ cushion: 2000n * E18, minLoan: 1750n * E18 });
    const p = planForAccount(s, regular);
    expect(p.kind).toBe("repay");
    expect(p.amounts.repayAssets).toBeGreaterThanOrEqual(s.debt);
    expect(p.amounts.repayAssets).toBeLessThanOrEqual(s.cushion);
  });

  it("sells collateral on Lista in the regular session when the cushion is short", () => {
    const s = lista({ cushion: 10n * E18 });
    const p = planForAccount(s, regular);
    expect(p.canSellCollateral).toBe(true);
    expect(p.kind).toBe("repay+deleverage");
    expect(p.amounts.repayAssets).toBe(10n * E18);
    expect(p.amounts.sellCollateral).toBeGreaterThan(0n);
    expect(p.amounts.sellCollateral).toBeLessThanOrEqual(s.collateral);
    expect(p.amounts.flashRepayAssets).toBeGreaterThan(0n);
    expect(p.amounts.minOut).toBe(p.amounts.flashRepayAssets);
    expect(p.warnings).toEqual([]);
    expect(p.inDeleverageWindow).toBe(true);
    // One keeper call: the contract spends the cushion first, then sells only if still above the shield LTV.
    expect(p.steps).toEqual([
      { fn: "shieldDeleverage", repayAssets: p.amounts.flashRepayAssets, collateralToSell: p.amounts.sellCollateral, minOut: p.amounts.minOut },
    ]);
  });

  it("splits an owner sale into a cushion repay and a deleverage", () => {
    const p = planForAccount(lista({ cushion: 10n * E18 }), regular, { asOwner: true });
    expect(p.steps.map((s) => s.fn)).toEqual(["shieldRepay", "shieldDeleverage"]);
  });

  it("does not sell outside the deleverage window and says why", () => {
    const p = planForAccount(lista({ cushion: 10n * E18, debt: 1400n * E18, mandate: { maxLtvBps: 7000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true } }), {
      ...morning,
      windowAhead: { ...morning.windowAhead, gapBps: 2446 },
    });
    expect(p.inDeleverageWindow).toBe(false);
    expect(p.canSellCollateral).toBe(false);
    expect(p.kind).toBe("insufficient");
    expect(p.warnings.join(" ")).toMatch(/NotInShieldWindow/);
    expect(p.steps).toEqual([{ fn: "shieldRepay", assets: 10n * E18 }]);
  });

  it("sells outside the window when LTV after the cushion is above the owner's cap, floored at the cap", () => {
    const p = planForAccount(lista({ cushion: 10n * E18 }), morning);
    expect(p.inDeleverageWindow).toBe(false);
    expect(p.canSellCollateral).toBe(true);
    expect(p.kind).toBe("repay+deleverage");
    expect(p.warnings).toEqual([]); // lands near 68% LTV, above the 59% floor
  });

  it("flags a sale that clears the loan: accrual headroom and the OverDeleverage floor", () => {
    const s = lista({ cushion: 10n * E18, minLoan: 1700n * E18 });
    const p = planForAccount(s, regular);
    expect(p.kind).toBe("repay+deleverage");
    if (p.kind !== "repay+deleverage") return;
    const remaining = s.debt - p.amounts.repayAssets;
    expect(p.amounts.flashRepayAssets).toBe(remaining + remaining / 10_000n + 1n);
    expect(p.amounts.sellCollateral).toBeGreaterThan(parseUnits(p.sellTokens.toFixed(6), 18));
    expect(p.warnings.join(" ")).toMatch(/OverDeleverage/);
  });

  it("warns when the venue minimum loan is unknown", () => {
    const s = lista();
    const p = planForAccount({ ...s, pricing: { ...s.pricing, minLoanUsd: 0, minLoanKnown: false } }, regular);
    expect(p.warnings.join(" ")).toMatch(/minimum loan unknown/);
  });

  it("is a noop when no closure window is known", () => {
    const none: PlanOracle = { ...regular, windowAhead: { window: "NONE", startsAt: 0, endsAt: 0, gapBps: 0 } };
    expect(planForAccount(lista(), none)).toMatchObject({ kind: "noop", reason: "no closure window known" });
    expect(planForAccount(lista(), none, { gapBps: 417 }).kind).toBe("repay");
  });

  it("warns when the mandate would refuse the deleverage", () => {
    const s = lista({ cushion: 10n * E18, mandate: { maxLtvBps: 7400, shieldLtvBps: 7300, maxSlippageBps: 150, autoRestore: true } });
    const p = planForAccount(s, regular);
    expect(p.kind).toBe("repay+deleverage");
    expect(p.warnings.join(" ")).toMatch(/shield LTV/);
  });

  it("surfaces an insufficient plan as-is outside the regular session", () => {
    const p = planForAccount(lista({ cushion: 10n * E18 }), overnight);
    expect(p.canSellCollateral).toBe(false);
    expect(p.kind).toBe("insufficient");
    expect(p.amounts.repayAssets).toBe(10n * E18);
    expect(p.steps).toEqual([{ fn: "shieldRepay", assets: 10n * E18 }]);
  });

  it("never sells without a deleverage path", () => {
    const p = planForAccount(lista({ cushion: 10n * E18, pathSet: false }), regular);
    expect(p.canSellCollateral).toBe(false);
    expect(p.kind).toBe("insufficient");
  });

  it("never sells on Venus", () => {
    const p = planForAccount(venus({ cushion: 10n * E18 }), regular);
    expect(p.canSellCollateral).toBe(false);
    expect(p.kind).toBe("insufficient");
  });

  it("uses the gap of the closure in progress, else the window ahead, else the override", () => {
    const inClosure: PlanOracle = { ...overnight, currentWindow: { window: "WEEKEND", gapBps: 737, closedAt: 1 } };
    expect(planForAccount(lista(), inClosure).gapBps).toBe(737);
    expect(planForAccount(lista(), regular).gapBps).toBe(417);
    expect(planForAccount(lista(), regular, { gapBps: 1000 }).gapBps).toBe(1000);
  });

  it("is a noop when the collateral price is unavailable", () => {
    const p = planForAccount(lista({ price: null }), regular);
    expect(p.kind).toBe("noop");
    expect(p.kind === "noop" && p.reason).toMatch(/price/);
    expect(planForAccount(lista({ price: null }), regular, { priceUsd: 250 }).kind).toBe("repay");
  });

  it("is a noop for liquidated or debt-free accounts", () => {
    expect(planForAccount(lista({ liquidated: true }), regular)).toMatchObject({ kind: "noop", reason: expect.stringMatching(/liquidated/) });
    expect(planForAccount(lista({ debt: 0n }), regular)).toMatchObject({ kind: "noop", reason: expect.stringMatching(/debt/) });
  });
});

describe("planForAccount: restore", () => {
  const open: PlanOracle = { ...regular, canAddRisk: true, reason: "OK" };

  it("borrows back toward the pre-shield debt within the owner's cap", () => {
    const p = planForAccount(lista({ debt: 1000n * E18 }), open, { restoreToDebtUsd: 1400 });
    expect(p.mode).toBe("restore");
    expect(p).toMatchObject({ kind: "borrow", borrowUsd: 400 });
    expect(p.amounts.borrowAssets).toBe(400n * E18);
    expect(p.steps).toEqual([{ fn: "restore", assets: 400n * E18 }]);
  });

  it("caps the restore at the owner's max LTV", () => {
    const p = planForAccount(lista({ debt: 1000n * E18 }), open, { restoreToDebtUsd: 2000 });
    expect(p).toMatchObject({ kind: "borrow", borrowUsd: 500 });
  });

  it("refuses while the oracle says risk may not be added", () => {
    const p = planForAccount(lista({ debt: 1000n * E18 }), regular, { restoreToDebtUsd: 1400 });
    expect(p).toMatchObject({ kind: "noop", mode: "restore", reason: expect.stringMatching(/WINDOW_AHEAD/) });
  });

  it("refuses keeper restores the owner disabled, but plans them for the owner", () => {
    const s = lista({ debt: 1000n * E18, mandate: { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: false } });
    expect(planForAccount(s, open, { restoreToDebtUsd: 1400 })).toMatchObject({ kind: "noop", reason: expect.stringMatching(/auto-restore/) });
    expect(planForAccount(s, open, { restoreToDebtUsd: 1400, asOwner: true }).kind).toBe("borrow");
  });
});
