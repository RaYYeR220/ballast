// Calldata builders. Nothing here signs or sends: each returns { to, data, value } for any wallet or
// for a simulation (eth_call) before broadcast.
import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, type Address, type Hex } from "viem";
import { ballastAccountBaseAbi, ballastFactoryAbi, ballastGuardianAbi, cushionVaultAbi, kernelAbi, listaAccountAbi, sessionOracleAbi } from "./abi";
import type { Deployment } from "./addresses";
import type { Mandate, MarketParams } from "./reads";
import { symbolToBytes32 } from "./util";

export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

const tx = (to: Address, data: Hex): TxRequest => ({ to, data, value: 0n });
const big = (x: number | bigint) => BigInt(x);

// ------------------------------------------------------------------ factory

export function createListaAccount(
  d: Deployment,
  p: { marketParams: MarketParams; symbol: string; keeper: Address; mandate: Mandate },
): TxRequest {
  return tx(
    d.factory,
    encodeFunctionData({
      abi: ballastFactoryAbi,
      functionName: "createListaAccount",
      args: [p.marketParams, symbolToBytes32(p.symbol), p.keeper, p.mandate],
    }),
  );
}

export function createVenusAccount(
  d: Deployment,
  p: { vCollateral: Address; vDebt: Address; symbol: string; keeper: Address; mandate: Mandate },
): TxRequest {
  return tx(
    d.factory,
    encodeFunctionData({
      abi: ballastFactoryAbi,
      functionName: "createVenusAccount",
      args: [p.vCollateral, p.vDebt, symbolToBytes32(p.symbol), p.keeper, p.mandate],
    }),
  );
}

// ------------------------------------------------------------ account owner

const acct = (account: Address, data: Hex) => tx(account, data);
const base = ballastAccountBaseAbi;

export const depositCollateral = (account: Address, amount: bigint) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "depositCollateral", args: [amount] }));
export const withdrawCollateral = (account: Address, amount: bigint, to: Address) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "withdrawCollateral", args: [amount, to] }));
export const borrow = (account: Address, assets: bigint, to: Address) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "borrow", args: [assets, to] }));
export const repay = (account: Address, assets: bigint) => acct(account, encodeFunctionData({ abi: base, functionName: "repay", args: [assets] }));
export const repayAll = (account: Address) => acct(account, encodeFunctionData({ abi: base, functionName: "repayAll" }));
export const depositCushion = (account: Address, assets: bigint) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "depositCushion", args: [assets] }));
export const withdrawCushion = (account: Address, assets: bigint, to: Address) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "withdrawCushion", args: [assets, to] }));
export const setMandate = (account: Address, mandate: Mandate) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "setMandate", args: [mandate] }));
export const setKeeper = (account: Address, keeper: Address) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "setKeeper", args: [keeper] }));
/** Lista only: fixes the one swap route the keeper may deleverage through ("0x" disables it). */
export const setDeleveragePath = (account: Address, path: Hex) =>
  acct(account, encodeFunctionData({ abi: listaAccountAbi, functionName: "setDeleveragePath", args: [path] }));
/** Permissionless: latches a seizure before donated collateral can hide it. */
export const recordLiquidation = (account: Address) => acct(account, encodeFunctionData({ abi: base, functionName: "recordLiquidation" }));

/** ERC-20 approval, e.g. collateral or cushion tokens to the account, or the budget to the kernel. */
export const approve = (token: Address, spender: Address, amount: bigint) =>
  tx(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));

/** PancakeSwap v3 path: token0, fee0, token1, fee1, ..., tokenN. */
export function encodeV3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error("encodeV3Path: need one fees entry per hop");
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    const fee = fees[i];
    if (fee !== undefined) {
      types.push("uint24");
      values.push(fee);
    }
  });
  return encodePacked(types, values);
}

// ------------------------------------------------------------------- keeper

export const shieldRepay = (account: Address, assets: bigint) =>
  acct(account, encodeFunctionData({ abi: base, functionName: "shieldRepay", args: [assets] }));

/** Lista only: flash-loan `repayAssets`, repay, withdraw and sell `collateralToSell` along `path`. */
export const shieldDeleverage = (account: Address, p: { repayAssets: bigint; collateralToSell: bigint; path: Hex; minOut: bigint }) =>
  acct(
    account,
    encodeFunctionData({ abi: listaAccountAbi, functionName: "shieldDeleverage", args: [p.repayAssets, p.collateralToSell, p.path, p.minOut] }),
  );

export const restore = (account: Address, assets: bigint) => acct(account, encodeFunctionData({ abi: base, functionName: "restore", args: [assets] }));

/** Keeper repays `user`'s own loan from their CushionVault cover. */
export const shieldFor = (d: Deployment, user: Address, key: Hex, amount: bigint) =>
  tx(d.cushionVault, encodeFunctionData({ abi: cushionVaultAbi, functionName: "shieldFor", args: [user, key, amount] }));

// --------------------------------------------------------------- vault user

export const openListaCover = (
  d: Deployment,
  p: { marketParams: MarketParams; symbol: string; keeper: Address; capPerDay: bigint; amount: bigint },
) =>
  tx(
    d.cushionVault,
    encodeFunctionData({
      abi: cushionVaultAbi,
      functionName: "openListaCover",
      args: [p.marketParams, symbolToBytes32(p.symbol), p.keeper, p.capPerDay, p.amount],
    }),
  );

export const openVenusCover = (d: Deployment, p: { vDebt: Address; symbol: string; keeper: Address; capPerDay: bigint; amount: bigint }) =>
  tx(
    d.cushionVault,
    encodeFunctionData({
      abi: cushionVaultAbi,
      functionName: "openVenusCover",
      args: [p.vDebt, symbolToBytes32(p.symbol), p.keeper, p.capPerDay, p.amount],
    }),
  );

export const topUpCover = (d: Deployment, key: Hex, amount: bigint) =>
  tx(d.cushionVault, encodeFunctionData({ abi: cushionVaultAbi, functionName: "topUp", args: [key, amount] }));

export const withdrawCover = (d: Deployment, key: Hex, amount: bigint, to: Address) =>
  tx(d.cushionVault, encodeFunctionData({ abi: cushionVaultAbi, functionName: "withdraw", args: [key, amount, to] }));

// ---------------------------------------------------------------- publisher

export interface OverlayInput {
  validUntil: number | bigint;
  /** Regular-open timestamp at which the next earnings gap is realised (0 = none known). */
  nextEarnings: number | bigint;
  flags: number;
  /** Shares per Ondo token, 1e18 (0 = not posted). */
  ondoMultiplier: bigint;
  /** Per-share USD 1e8, only for tickers without Chainlink and only in the regular session (0 = not posted). */
  referencePrice: bigint;
}

export function postOverlays(d: Deployment, entries: readonly { symbol: string; overlay: OverlayInput }[]): TxRequest {
  const syms = entries.map((e) => symbolToBytes32(e.symbol));
  const data = entries.map(({ overlay: o }) => ({
    validUntil: big(o.validUntil),
    nextEarnings: big(o.nextEarnings),
    flags: o.flags,
    ondoMultiplier: o.ondoMultiplier,
    referencePrice: o.referencePrice,
    postedAt: 0n, // set by the contract
  }));
  return tx(d.sessionOracle, encodeFunctionData({ abi: sessionOracleAbi, functionName: "postOverlays", args: [syms, data] }));
}

// ----------------------------------------------------------------- guardian

export interface GuardTermsInput {
  account: Address;
  start: number | bigint;
  end: number | bigint;
  agentId: bigint;
}

/** Same bytes as BallastGuardian.encodeTerms: abi.encode(account, uint64 start, uint64 end, agentId). */
export const encodeTerms = (t: GuardTermsInput): Hex =>
  encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }], [t.account, big(t.start), big(t.end), t.agentId]);

/** Client opens a guard job on the kernel with the guardian as evaluator and hook. */
export const createJobWithToken = (
  d: Deployment,
  p: { provider: Address; expiredAt: number | bigint; description: string; token: Address },
) =>
  tx(
    d.external.kernel,
    encodeFunctionData({
      abi: kernelAbi,
      functionName: "createJobWithToken",
      args: [p.provider, d.guardian, big(p.expiredAt), p.description, d.guardian, p.token],
    }),
  );

export const setBudget = (d: Deployment, jobId: bigint, amount: bigint) =>
  tx(d.external.kernel, encodeFunctionData({ abi: kernelAbi, functionName: "setBudget", args: [jobId, amount, "0x"] }));

/** Client funds the job; the terms ride along as optParams and are bound by the guardian hook. */
export const fund = (d: Deployment, p: { jobId: bigint; expectedBudget: bigint; terms: GuardTermsInput }) =>
  tx(d.external.kernel, encodeFunctionData({ abi: kernelAbi, functionName: "fund", args: [p.jobId, p.expectedBudget, encodeTerms(p.terms)] }));

/** Provider submits after the window ends; `deliverable` is the hash of the evidence. */
export const submit = (d: Deployment, jobId: bigint, deliverable: Hex) =>
  tx(d.external.kernel, encodeFunctionData({ abi: kernelAbi, functionName: "submit", args: [jobId, deliverable, "0x"] }));

export const claimRefund = (d: Deployment, jobId: bigint) =>
  tx(d.external.kernel, encodeFunctionData({ abi: kernelAbi, functionName: "claimRefund", args: [jobId] }));

/** Anyone settles a submitted job after the window: pays the guardian or refunds the client. */
export const settle = (d: Deployment, jobId: bigint) =>
  tx(d.guardian, encodeFunctionData({ abi: ballastGuardianAbi, functionName: "settle", args: [jobId] }));
