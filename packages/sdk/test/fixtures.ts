import { erc20Abi, stringToHex, type Address, type Hex } from "viem";
import {
  ballastAccountBaseAbi,
  comptrollerAbi,
  listaAccountAbi,
  moolahAbi,
  parseDeployment,
  venusAccountAbi,
  venusOracleAbi,
} from "../src/index";
import { addr, cloneCode, FakeChain } from "./fake-chain";

export const d = parseDeployment(31337, {
  owner: addr(0xa0),
  calendar: addr(0xa1),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
  block: 123,
});

export const OWNER = addr(0xb1);
export const KEEPER = addr(0xb2);
export const USD1 = addr(0xc1);
export const NVDAB = addr(0xc2);
export const MOOLAH = addr(0xc3);
export const LISTA_ORACLE = addr(0xc4);
export const IRM = addr(0xc5);
export const USDT = addr(0xc6);
export const V_NVDAB = addr(0xc7);
export const V_USDT = addr(0xc8);
export const COMPTROLLER = addr(0xc9);
export const VENUS_ORACLE = addr(0xca);
export const NVDA = stringToHex("NVDA", { size: 32 });
export const E18 = 10n ** 18n;
export const UINT_MAX = 2n ** 256n - 1n;

export const mp = { loanToken: USD1, collateralToken: NVDAB, oracle: LISTA_ORACLE, irm: IRM, lltv: 75n * 10n ** 16n };
export const MARKET_ID: Hex = `0x${"11".repeat(32)}`;
export const PATH_HASH: Hex = `0x${"22".repeat(32)}`;

interface AccountOpts {
  collateral?: bigint;
  debt?: bigint;
  cushion?: bigint;
  ltvBps?: bigint | "revert";
  health?: [boolean, boolean];
  liquidated?: boolean;
  liquidationRecorded?: boolean;
  tracked?: bigint;
  autoRestore?: boolean;
}

function common(chain: FakeChain, account: Address, loan: Address, coll: Address, o: AccountOpts) {
  const a = ballastAccountBaseAbi;
  chain
    .on(account, a, "owner", [], OWNER)
    .on(account, a, "keeper", [], KEEPER)
    .on(account, a, "symbol", [], NVDA)
    .on(account, a, "mandate", [], [6000, 5000, 150, o.autoRestore ?? true])
    .on(account, a, "trackedCollateral", [], o.tracked ?? o.collateral ?? 10n * E18)
    .on(account, a, "liquidationRecorded", [], o.liquidationRecorded ?? false)
    .on(account, a, "liquidated", [], o.liquidated ?? false)
    .on(account, a, "healthStatus", [], o.health ?? [true, true])
    .on(account, a, "position", [], [o.collateral ?? 10n * E18, o.debt ?? 1000n * E18])
    .on(account, a, "cushion", [], o.cushion ?? 100n * E18)
    .on(account, a, "loanToken", [], loan)
    .on(account, a, "collateralToken", [], coll)
    .on(loan, erc20Abi, "decimals", [], 18)
    .on(coll, erc20Abi, "decimals", [], 18);
  if (o.ltvBps === "revert") chain.revert(account, a, "ltvBps", []);
  else chain.on(account, a, "ltvBps", [], o.ltvBps ?? 4000n);
}

/** A Lista account on NVDAB/USD1 at $250 per token unless the price is "revert". */
export function listaAccount(
  chain: FakeChain,
  account: Address,
  o: AccountOpts & { price?: bigint | "revert" | "fail"; pathHash?: Hex; minLoan?: bigint | "revert" } = {},
) {
  chain.code(account, cloneCode(d.listaImpl));
  common(chain, account, USD1, NVDAB, o);
  chain
    .on(account, listaAccountAbi, "moolah", [], MOOLAH)
    .on(account, listaAccountAbi, "marketId", [], MARKET_ID)
    .on(account, listaAccountAbi, "marketParams", [], mp)
    .on(account, listaAccountAbi, "deleveragePathHash", [], o.pathHash ?? PATH_HASH);
  if (o.minLoan === "revert") chain.revert(MOOLAH, moolahAbi, "minLoan", [mp]);
  else chain.on(MOOLAH, moolahAbi, "minLoan", [mp], o.minLoan ?? E18);
  if (o.price === "revert") chain.revert(MOOLAH, moolahAbi, "getPrice", [mp]);
  else if (o.price === "fail") chain.fail(MOOLAH, moolahAbi, "getPrice", [mp]);
  else chain.on(MOOLAH, moolahAbi, "getPrice", [mp], o.price ?? 250n * 10n ** 36n);
}

/** A Venus account on vNVDAB/vUSDT at $250 per token, USDT at $1, LT 60%, CF 50%. */
export function venusAccount(chain: FakeChain, account: Address, o: AccountOpts & { price?: bigint | "revert" } = {}) {
  chain.code(account, cloneCode(d.venusImpl));
  common(chain, account, USDT, NVDAB, o);
  chain
    .on(account, venusAccountAbi, "comptroller", [], COMPTROLLER)
    .on(account, venusAccountAbi, "vCollateral", [], V_NVDAB)
    .on(account, venusAccountAbi, "vDebt", [], V_USDT)
    .on(account, venusAccountAbi, "venusOracle", [], VENUS_ORACLE)
    .on(COMPTROLLER, comptrollerAbi, "markets", [V_NVDAB], [true, 5n * 10n ** 17n, false, 6n * 10n ** 17n])
    .on(VENUS_ORACLE, venusOracleAbi, "getUnderlyingPrice", [V_USDT], E18);
  if (o.price === "revert") chain.revert(VENUS_ORACLE, venusOracleAbi, "getUnderlyingPrice", [V_NVDAB]);
  else chain.on(VENUS_ORACLE, venusOracleAbi, "getUnderlyingPrice", [V_NVDAB], o.price ?? 250n * E18);
}
