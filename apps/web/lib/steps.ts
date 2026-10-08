/* Transaction steps for the app's actions, built with the SDK's calldata builders. Approvals are steps of their
   own. Pure: nothing here reads the chain or signs. */
import { writes, type Deployment, type Mandate, type TxRequest } from "@ballast/sdk";
import { formatUnits, type Address, type Hex } from "viem";
import type { AccountView, CoverView, LoanView, MarketView } from "./views";

export interface TxStep {
  key: string;
  title: string;
  detail?: string;
  /** the call as a person reads it, e.g. "depositCollateral(120 NVDAB)" */
  call: string;
  tx: TxRequest;
}

export const amountText = (x: bigint, decimals: number, symbol: string) =>
  `${Number(formatUnits(x, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${symbol}`;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export function approvalStep(o: { token: Address; symbol: string; decimals: number; spender: Address; spenderName: string; amount: bigint; allowance: bigint }): TxStep[] {
  if (o.allowance >= o.amount) return [];
  return [
    {
      key: `approve-${o.token}`,
      title: `Approve ${amountText(o.amount, o.decimals, o.symbol)} for ${o.spenderName}`,
      detail: `An ERC-20 approval for exactly this amount. ${o.spenderName.charAt(0).toUpperCase() + o.spenderName.slice(1)} can pull no more than that.`,
      call: `approve(${o.spenderName}, ${amountText(o.amount, o.decimals, o.symbol)})`,
      tx: writes.approve(o.token, o.spender, o.amount),
    },
  ];
}

export const mandateText = (m: Mandate) =>
  `max LTV ${pct(m.maxLtvBps)}, shield LTV ${pct(m.shieldLtvBps)}, slippage ${pct(m.maxSlippageBps)}, auto-restore ${m.autoRestore ? "on" : "off"}`;

export function createAccountStep(d: Deployment, m: MarketView, keeper: Address, mandate: Mandate): TxStep {
  if (m.venue === "lista") {
    if (!m.marketParams) throw new Error(`${m.label}: market parameters are not available`);
    const mp = { ...m.marketParams, lltv: BigInt(m.marketParams.lltv) };
    return {
      key: "create",
      title: `Open a credit line on ${m.label}`,
      detail: `Creates your Ballast account for ${m.symbol} with ${mandateText(mandate)}. The desk agent is its keeper.`,
      call: `createListaAccount(${m.collateralSymbol} / ${m.loanSymbol}, ${m.symbol})`,
      tx: writes.createListaAccount(d, { marketParams: mp, symbol: m.symbol, keeper, mandate }),
    };
  }
  if (!m.vCollateral || !m.vDebt) throw new Error(`${m.label}: Venus markets are not configured`);
  return {
    key: "create",
    title: `Open a credit line on ${m.label}`,
    detail: `Creates your Ballast account for ${m.symbol} with ${mandateText(mandate)}. The desk agent is its keeper.`,
    call: `createVenusAccount(v${m.collateralSymbol}, vUSDT, ${m.symbol})`,
    tx: writes.createVenusAccount(d, { vCollateral: m.vCollateral, vDebt: m.vDebt, symbol: m.symbol, keeper, mandate }),
  };
}

export function deleveragePathStep(account: Address, path: { hex: Hex; label: string }): TxStep {
  return {
    key: "path",
    title: "Fix the deleverage route",
    detail: `The one PancakeSwap route the keeper may sell collateral through when the cushion is not enough: ${path.label}.`,
    call: `setDeleveragePath(${path.label})`,
    tx: writes.setDeleveragePath(account, path.hex),
  };
}

export type AccountAction = "deposit-collateral" | "borrow" | "deposit-cushion" | "withdraw-cushion" | "repay-all" | "withdraw-collateral" | "set-mandate" | "set-path";

export interface ActionInput {
  action: AccountAction;
  owner: Address;
  amount?: bigint;
  allowance?: bigint;
  mandate?: Mandate;
  path?: { hex: Hex; label: string };
}

export function accountSteps(v: AccountView, i: ActionInput): TxStep[] {
  const a = v.address;
  const coll = (x: bigint) => amountText(x, v.collateralDecimals, v.collateralSymbol);
  const loan = (x: bigint) => amountText(x, v.loanDecimals, v.loanSymbol);
  const need = (x: bigint | undefined) => {
    if (x === undefined || x <= 0n) throw new Error("enter an amount");
    return x;
  };
  switch (i.action) {
    case "deposit-collateral": {
      const x = need(i.amount);
      return [
        ...approvalStep({ token: v.collateralToken, symbol: v.collateralSymbol, decimals: v.collateralDecimals, spender: a, spenderName: "your account", amount: x, allowance: i.allowance ?? 0n }),
        { key: "deposit-collateral", title: `Deposit ${coll(x)}`, call: `depositCollateral(${coll(x)})`, tx: writes.depositCollateral(a, x) },
      ];
    }
    case "borrow": {
      const x = need(i.amount);
      return [{ key: "borrow", title: `Borrow ${loan(x)} to your wallet`, call: `borrow(${loan(x)})`, tx: writes.borrow(a, x, i.owner) }];
    }
    case "deposit-cushion": {
      const x = need(i.amount);
      return [
        ...approvalStep({ token: v.loanToken, symbol: v.loanSymbol, decimals: v.loanDecimals, spender: a, spenderName: "your account", amount: x, allowance: i.allowance ?? 0n }),
        { key: "deposit-cushion", title: `Add ${loan(x)} to the cushion`, call: `depositCushion(${loan(x)})`, tx: writes.depositCushion(a, x) },
      ];
    }
    case "withdraw-cushion": {
      const x = need(i.amount);
      return [{ key: "withdraw-cushion", title: `Withdraw ${loan(x)} from the cushion`, call: `withdrawCushion(${loan(x)})`, tx: writes.withdrawCushion(a, x, i.owner) }];
    }
    case "repay-all":
      return [{ key: "repay-all", title: "Repay the whole loan from the cushion", call: "repayAll()", tx: writes.repayAll(a) }];
    case "withdraw-collateral": {
      const x = need(i.amount);
      return [{ key: "withdraw-collateral", title: `Withdraw ${coll(x)} to your wallet`, call: `withdrawCollateral(${coll(x)})`, tx: writes.withdrawCollateral(a, x, i.owner) }];
    }
    case "set-mandate": {
      if (!i.mandate) throw new Error("no mandate");
      return [{ key: "set-mandate", title: "Update the mandate", detail: mandateText(i.mandate), call: `setMandate(${mandateText(i.mandate)})`, tx: writes.setMandate(a, i.mandate) }];
    }
    case "set-path": {
      if (!i.path) throw new Error("no deleverage route is configured for this market");
      return [deleveragePathStep(a, i.path)];
    }
  }
}

export function openCoverSteps(d: Deployment, loan: LoanView, o: { keeper: Address; amount: bigint; capPerDay: bigint; allowance: bigint }): TxStep[] {
  const amt = amountText(o.amount, loan.loanDecimals, loan.loanSymbol);
  const cap = amountText(o.capPerDay, loan.loanDecimals, loan.loanSymbol);
  const approve = approvalStep({
    token: loan.loanToken,
    symbol: loan.loanSymbol,
    decimals: loan.loanDecimals,
    spender: d.cushionVault,
    spenderName: "the cushion vault",
    amount: o.amount,
    allowance: o.allowance,
  });
  if (loan.venue === "lista") {
    if (!loan.marketParams) throw new Error("market parameters are not available");
    const mp = { ...loan.marketParams, lltv: BigInt(loan.marketParams.lltv) };
    return [
      ...approve,
      {
        key: "open-cover",
        title: `Open a cover for your ${loan.label} loan with ${amt}`,
        detail: `The desk agent may spend up to ${cap} a day from it, only to repay this loan, only before or during a closure.`,
        call: `openListaCover(${loan.collateralSymbol} / ${loan.loanSymbol}, ${loan.symbol}, cap ${cap}, ${amt})`,
        tx: writes.openListaCover(d, { marketParams: mp, symbol: loan.symbol, keeper: o.keeper, capPerDay: o.capPerDay, amount: o.amount }),
      },
    ];
  }
  if (!loan.vDebt) throw new Error("Venus debt market unknown");
  return [
    ...approve,
    {
      key: "open-cover",
      title: `Open a cover for your Venus ${loan.loanSymbol} loan with ${amt}`,
      detail: `The desk agent may spend up to ${cap} a day from it, only to repay this loan, only before or during a closure.`,
      call: `openVenusCover(vUSDT, ${loan.symbol}, cap ${cap}, ${amt})`,
      tx: writes.openVenusCover(d, { vDebt: loan.vDebt, symbol: loan.symbol, keeper: o.keeper, capPerDay: o.capPerDay, amount: o.amount }),
    },
  ];
}

export function topUpCoverSteps(d: Deployment, c: CoverView, amount: bigint, allowance: bigint): TxStep[] {
  const amt = amountText(amount, c.tokenDecimals, c.tokenSymbol);
  return [
    ...approvalStep({ token: c.token, symbol: c.tokenSymbol, decimals: c.tokenDecimals, spender: d.cushionVault, spenderName: "the cushion vault", amount, allowance }),
    { key: "top-up", title: `Top up the ${c.label} cover with ${amt}`, call: `topUp(${amt})`, tx: writes.topUpCover(d, c.key, amount) },
  ];
}

export function withdrawCoverSteps(d: Deployment, c: CoverView, amount: bigint, to: Address): TxStep[] {
  const amt = amountText(amount, c.tokenDecimals, c.tokenSymbol);
  return [{ key: "withdraw-cover", title: `Withdraw ${amt} from the ${c.label} cover`, call: `withdraw(${amt})`, tx: writes.withdrawCover(d, c.key, amount, to) }];
}
