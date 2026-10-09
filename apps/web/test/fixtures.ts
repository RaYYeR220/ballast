/* Shared fixtures: one Lista NVDAB / USD1 account on a Tuesday morning in New York. */
import { marketById } from "../lib/markets";
import type { AccountView } from "../lib/views";
import { addr } from "./helpers";

export const E18 = 10n ** 18n;
export const TUE_1100 = 1_791_298_800;
export const CLOSE = 1_791_316_800;
export const OPEN = 1_791_379_800;
export const OWNER = addr(0xb1);
export const KEEPER = addr(0xb2);
export const nvda = marketById("lista:NVDAB_USD1")!;

export const VIEW: AccountView = {
  address: addr(0xbb),
  venue: "lista",
  owner: OWNER,
  keeper: KEEPER,
  symbol: "NVDA",
  collateralSymbol: "NVDAB",
  loanSymbol: "USD1",
  collateralToken: nvda.collateralToken,
  loanToken: nvda.loanToken,
  collateralDecimals: 18,
  loanDecimals: 18,
  collateral: (120n * E18).toString(),
  debt: (12_070n * E18).toString(),
  cushion: (3_000n * E18).toString(),
  mandate: { maxLtvBps: 6000, shieldLtvBps: 4500, maxSlippageBps: 100, autoRestore: true },
  ltvBps: 5396,
  ltvUnbounded: false,
  healthKnown: true,
  healthy: true,
  liquidated: false,
  priceUsd: 186.4,
  loanPriceUsd: 1,
  lltvBps: 7500,
  minLoan: (15n * E18).toString(),
  lista: {
    marketId: nvda.lista!.marketId,
    deleveragePathSet: false,
    deleveragePathHash: `0x${"00".repeat(32)}`,
    marketParams: { loanToken: nvda.loanToken, collateralToken: nvda.collateralToken, oracle: addr(0xc4), irm: addr(0xc5), lltv: (75n * 10n ** 16n).toString() },
  },
  gaps: { overnight: 417, weekend: 737, holiday: 450, earnings: 502 },
  coming: { window: "OVERNIGHT", gapBps: 417, startsAt: CLOSE, endsAt: OPEN, inProgress: false },
  ltvAfterGapBps: 5630.8,
  oracle: { session: "REGULAR", canAddRisk: true, reason: "OK", reasonText: "risk may be added", horizon: 10800, restoreDelay: 5400, perShare: "18640000000", referenceUpdatedAt: TUE_1100 },
  plan: {
    kind: "repay",
    mode: "shield",
    gapBps: 417,
    targetHfAfterGap: 1.05,
    hfAfterGap: 1.05,
    repayUsd: 2900,
    inDeleverageWindow: false,
    canSellCollateral: false,
    steps: [{ fn: "shieldRepay", assets: (2_900n * E18).toString() }],
    warnings: [],
  },
};
