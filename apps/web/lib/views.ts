/* JSON shapes the app's read routes return (bigints as decimal strings). Client-safe. */
import type { Address, Hex } from "viem";

export interface MandateView {
  maxLtvBps: number;
  shieldLtvBps: number;
  maxSlippageBps: number;
  autoRestore: boolean;
}

export interface MarketParamsView {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: string;
}

export interface GapsView {
  overnight: number;
  weekend: number;
  holiday: number;
  earnings: number;
}

export interface PlanStepView {
  fn: string;
  /** token-unit amounts as decimal strings */
  assets?: string;
  repayAssets?: string;
  collateralToSell?: string;
}

export interface PlanView {
  kind: string;
  mode: "shield" | "restore";
  reason?: string;
  gapBps: number;
  targetHfAfterGap: number;
  hfAfterGap?: number;
  repayUsd?: number;
  sellTokens?: number;
  inDeleverageWindow: boolean;
  canSellCollateral: boolean;
  steps: PlanStepView[];
  warnings: string[];
}

export interface OracleBrief {
  session: string;
  canAddRisk: boolean;
  reason: string;
  reasonText: string;
  /** seconds: the keeper's deleverage window before a closure */
  horizon: number;
  restoreDelay: number;
  perShare: string | null;
  referenceUpdatedAt: number | null;
}

export interface ComingGap {
  window: string;
  gapBps: number;
  startsAt: number;
  endsAt: number;
  /** true while that closure is under way */
  inProgress: boolean;
}

export interface AccountView {
  address: Address;
  venue: "lista" | "venus";
  owner: Address;
  keeper: Address;
  symbol: string;
  collateralSymbol: string;
  loanSymbol: string;
  collateralToken: Address;
  loanToken: Address;
  collateralDecimals: number;
  loanDecimals: number;
  collateral: string;
  debt: string;
  cushion: string;
  mandate: MandateView;
  /** null when the venue cannot price the collateral right now */
  ltvBps: number | null;
  /** collateral worth nothing: LTV is unbounded */
  ltvUnbounded: boolean;
  healthKnown: boolean;
  healthy: boolean;
  liquidated: boolean;
  /** price of one whole collateral token in the venue's unit of account */
  priceUsd: number | null;
  loanPriceUsd: number | null;
  lltvBps: number;
  minLoan: string | null;
  lista?: { marketId: Hex; deleveragePathSet: boolean; deleveragePathHash: Hex; marketParams: MarketParamsView };
  venus?: { vCollateral: Address; vDebt: Address };
  gaps: GapsView | null;
  coming: ComingGap | null;
  ltvAfterGapBps: number | null;
  oracle: OracleBrief | null;
  oracleError?: string;
  plan: PlanView | null;
}

export interface LoanView {
  venue: "lista" | "venus";
  /** CushionVault cover key for this loan */
  key: Hex;
  label: string;
  symbol: string;
  collateralSymbol: string;
  loanSymbol: string;
  loanToken: Address;
  collateral: string;
  collateralDecimals: number;
  debt: string;
  loanDecimals: number;
  ltvBps: number | null;
  lltvBps: number | null;
  marketParams?: MarketParamsView;
  vDebt?: Address;
}

export interface CoverView {
  user: Address;
  key: Hex;
  venue: "lista" | "venus";
  symbol: string;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  keeper: Address;
  capPerDay: string;
  balance: string;
  dayStart: number;
  usedToday: string;
  label: string;
}

export type ReadBody<T> =
  | ({ status: "ok"; chainId: number; blockNumber: string; at: number } & T)
  | { status: "not-deployed"; detail: string }
  | { status: "unavailable"; detail: string };

export type AccountsBody = ReadBody<{ accounts: AccountView[]; covers: CoverView[]; errors: string[] }>;
export type LoansBody = ReadBody<{ loans: LoanView[]; errors: string[] }>;

export interface MarketView {
  id: string;
  venue: "lista" | "venus";
  label: string;
  symbol: string;
  collateralSymbol: string;
  loanSymbol: string;
  collateralToken: Address;
  loanToken: Address;
  lltvBps: number | null;
  marketParams: MarketParamsView | null;
  vCollateral?: Address;
  vDebt?: Address;
  path: { hex: Hex; label: string } | null;
  error?: string;
}

export type MarketsBody = { status: "ok"; markets: MarketView[] } | { status: "unavailable"; detail: string };

export interface TokenView {
  token: Address;
  symbol: string;
  decimals: number;
  balance: string;
  allowance: string | null;
}
