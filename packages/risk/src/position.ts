export interface ListaMarketState { totalBorrowAssets: bigint; totalBorrowShares: bigint; lltv: bigint }
export interface Position {
  /** Collateral amount in token units (not USD). */
  collateralTokens: number;
  /** USD price of ONE raw collateral token (not of the underlying share when a shares multiplier applies). */
  collateralPriceUsd: number;
  /** Outstanding debt in USD. */
  debtUsd: number;
  /** Liquidation LTV as a fraction in 0..1 (0.75 = 75%). */
  lltv: number;
  /** Venue minimum loan in USD; a remaining debt in (0, minLoanUsd) is not allowed. */
  minLoanUsd: number;
}

const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

export function listaDebt(borrowShares: bigint, m: ListaMarketState): bigint {
  if (borrowShares === 0n) return 0n;
  const num = borrowShares * (m.totalBorrowAssets + VIRTUAL_ASSETS);
  const den = m.totalBorrowShares + VIRTUAL_SHARES;
  return (num + den - 1n) / den;
}

export const listaLif = (lltv: number) => Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));

const collateralValue = (p: Position) => p.collateralTokens * p.collateralPriceUsd;
export const ltv = (p: Position) => (p.debtUsd === 0 ? 0 : p.debtUsd / collateralValue(p));
export const healthFactor = (p: Position) => (p.debtUsd === 0 ? Infinity : (collateralValue(p) * p.lltv) / p.debtUsd);
export const healthAfterGap = (p: Position, gapBps: number) =>
  p.debtUsd === 0 ? Infinity : (collateralValue(p) * (1 - gapBps / 10_000) * p.lltv) / p.debtUsd;
export const liquidationPrice = (p: Position) => p.debtUsd / (p.collateralTokens * p.lltv);
