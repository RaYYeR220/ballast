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

/** `accounts` is one page, newest first; `total` counts all of the owner's credit lines and `more` says older ones exist. */
export type AccountsBody = ReadBody<{
  accounts: AccountView[];
  total: number;
  offset: number;
  more: boolean;
  covers: CoverView[];
  errors: string[];
  /** set when the chain did not answer just now and these are the last figures read (at most a minute old) */
  stale?: { ageSec: number; detail: string };
}>;
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

export type MarketsBody = { status: "ok"; markets: MarketView[]; partial?: boolean } | { status: "unavailable"; detail: string };

export interface TokenView {
  token: Address;
  symbol: string;
  decimals: number;
  balance: string;
  allowance: string | null;
}

/** A tokenized stock the wallet holds. Only a bStock with a market can back a credit line here. */
export interface HeldStock {
  /** ticker, e.g. NVDA */
  symbol: string;
  issuer: "bStock" | "Ondo" | "xStock";
  token: Address;
  tokenSymbol: string;
  /** token units (18 decimals) */
  rawBalance: string;
  /** USD per token as Binance prices it; null when read from the chain */
  priceUsd: string | null;
  market: { id: string; label: string } | null;
}

/**
 * `source` says who answered: the Binance Wallet API, or BNB Chain when Binance is not set up or did not
 * answer (`binance` then says which, with the reason in `detail`).
 */
export type StocksBody =
  | { status: "ok"; source: "binance" | "chain"; binance: "ok" | "unavailable" | "not-configured"; detail?: string; stocks: HeldStock[] }
  | { status: "unavailable"; binance: "unavailable" | "not-configured"; detail: string };

/** One lending position as the Binance DeFi API reports it (amounts are its own decimal strings). */
export interface DefiLending {
  venue: "lista" | "venus";
  protocol: string;
  /** value of everything the wallet has in the protocol, as Binance prices it */
  valueUsd: string | null;
  /** "1,630.8 USD1" style amounts */
  borrowed: string[];
  supplied: string[];
  /** reported under the Lista market contract or the Venus comptroller this app reads */
  onOurMarkets: boolean;
}

export interface DefiSummary {
  status: "ok" | "unavailable" | "not-configured";
  protocols: { id: string; valueUsd: string }[];
  /** Lista and Venus positions among them */
  lending: DefiLending[];
  detail?: string;
}
