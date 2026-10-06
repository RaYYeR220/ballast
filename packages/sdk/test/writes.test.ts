import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodePacked, erc20Abi, type Abi, type Hex } from "viem";
import {
  ballastAccountBaseAbi,
  ballastFactoryAbi,
  ballastGuardianAbi,
  cushionVaultAbi,
  kernelAbi,
  listaAccountAbi,
  sessionOracleAbi,
  symbolToBytes32,
  writes,
  type TxRequest,
} from "../src/index";
import { addr } from "./fake-chain";
import { d, E18, KEEPER, mp, NVDA, NVDAB, OWNER, USD1, USDT, V_NVDAB, V_USDT } from "./fixtures";

const ACCOUNT = addr(0xd1);
const mandate = { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true };

function decode(tx: TxRequest, abi: Abi) {
  expect(tx.value).toBe(0n);
  return decodeFunctionData({ abi, data: tx.data });
}

describe("factory writes", () => {
  it("createListaAccount", () => {
    const tx = writes.createListaAccount(d, { marketParams: mp, symbol: "NVDA", keeper: KEEPER, mandate });
    expect(tx.to).toBe(d.factory);
    const { functionName, args } = decode(tx, ballastFactoryAbi);
    expect(functionName).toBe("createListaAccount");
    expect(args).toEqual([mp, NVDA, KEEPER, mandate]);
  });

  it("createVenusAccount", () => {
    const tx = writes.createVenusAccount(d, { vCollateral: V_NVDAB, vDebt: V_USDT, symbol: NVDA, keeper: KEEPER, mandate });
    expect(tx.to).toBe(d.factory);
    const { functionName, args } = decode(tx, ballastFactoryAbi);
    expect(functionName).toBe("createVenusAccount");
    expect(args).toEqual([V_NVDAB, V_USDT, NVDA, KEEPER, mandate]);
  });
});

describe("account owner writes", () => {
  const cases: [string, TxRequest, string, unknown[]][] = [
    ["depositCollateral", writes.depositCollateral(ACCOUNT, 5n * E18), "depositCollateral", [5n * E18]],
    ["withdrawCollateral", writes.withdrawCollateral(ACCOUNT, 2n * E18, OWNER), "withdrawCollateral", [2n * E18, OWNER]],
    ["borrow", writes.borrow(ACCOUNT, 100n * E18, OWNER), "borrow", [100n * E18, OWNER]],
    ["repay", writes.repay(ACCOUNT, 40n * E18), "repay", [40n * E18]],
    ["repayAll", writes.repayAll(ACCOUNT), "repayAll", []],
    ["depositCushion", writes.depositCushion(ACCOUNT, 50n * E18), "depositCushion", [50n * E18]],
    ["withdrawCushion", writes.withdrawCushion(ACCOUNT, 10n * E18, OWNER), "withdrawCushion", [10n * E18, OWNER]],
    ["setMandate", writes.setMandate(ACCOUNT, mandate), "setMandate", [mandate]],
    ["setKeeper", writes.setKeeper(ACCOUNT, KEEPER), "setKeeper", [KEEPER]],
    ["recordLiquidation", writes.recordLiquidation(ACCOUNT), "recordLiquidation", []],
  ];
  it.each(cases)("%s", (_, tx, fn, args) => {
    expect(tx.to).toBe(ACCOUNT);
    const decoded = decode(tx, ballastAccountBaseAbi);
    expect(decoded.functionName).toBe(fn);
    expect(decoded.args ?? []).toEqual(args);
  });

  it("setDeleveragePath encodes a PancakeSwap v3 path", () => {
    const path = writes.encodeV3Path([NVDAB, USDT, USD1], [2500, 100]);
    expect(path).toBe(encodePacked(["address", "uint24", "address", "uint24", "address"], [NVDAB, 2500, USDT, 100, USD1]));
    const decoded = decode(writes.setDeleveragePath(ACCOUNT, path), listaAccountAbi);
    expect(decoded.functionName).toBe("setDeleveragePath");
    expect(decoded.args).toEqual([path]);
  });

  it("encodeV3Path rejects a fee list of the wrong length", () => {
    expect(() => writes.encodeV3Path([NVDAB, USDT], [2500, 100])).toThrow(/fees/);
  });

  it("approve targets the token", () => {
    const tx = writes.approve(NVDAB, ACCOUNT, 5n * E18);
    expect(tx.to).toBe(NVDAB);
    expect(decode(tx, erc20Abi)).toEqual({ functionName: "approve", args: [ACCOUNT, 5n * E18] });
  });
});

describe("keeper writes", () => {
  it("shieldRepay", () => {
    const tx = writes.shieldRepay(ACCOUNT, 88n * E18);
    expect(tx.to).toBe(ACCOUNT);
    expect(decode(tx, ballastAccountBaseAbi)).toEqual({ functionName: "shieldRepay", args: [88n * E18] });
  });

  it("shieldDeleverage", () => {
    const path = writes.encodeV3Path([NVDAB, USDT, USD1], [2500, 100]);
    const tx = writes.shieldDeleverage(ACCOUNT, { repayAssets: 300n * E18, collateralToSell: 12n * 10n ** 17n, path, minOut: 299n * E18 });
    expect(tx.to).toBe(ACCOUNT);
    expect(decode(tx, listaAccountAbi)).toEqual({
      functionName: "shieldDeleverage",
      args: [300n * E18, 12n * 10n ** 17n, path, 299n * E18],
    });
  });

  it("restore", () => {
    expect(decode(writes.restore(ACCOUNT, 70n * E18), ballastAccountBaseAbi)).toEqual({ functionName: "restore", args: [70n * E18] });
  });

  it("shieldFor targets the vault", () => {
    const key: Hex = `0x${"aa".repeat(32)}`;
    const tx = writes.shieldFor(d, OWNER, key, 25n * E18);
    expect(tx.to).toBe(d.cushionVault);
    expect(decode(tx, cushionVaultAbi)).toEqual({ functionName: "shieldFor", args: [OWNER, key, 25n * E18] });
  });
});

describe("vault owner writes", () => {
  const key: Hex = `0x${"aa".repeat(32)}`;
  it("openListaCover", () => {
    const tx = writes.openListaCover(d, { marketParams: mp, symbol: "NVDA", keeper: KEEPER, capPerDay: 500n * E18, amount: 200n * E18 });
    expect(tx.to).toBe(d.cushionVault);
    expect(decode(tx, cushionVaultAbi)).toEqual({ functionName: "openListaCover", args: [mp, NVDA, KEEPER, 500n * E18, 200n * E18] });
  });
  it("openVenusCover", () => {
    const tx = writes.openVenusCover(d, { vDebt: V_USDT, symbol: "NVDA", keeper: KEEPER, capPerDay: 500n * E18, amount: 0n });
    expect(decode(tx, cushionVaultAbi)).toEqual({ functionName: "openVenusCover", args: [V_USDT, NVDA, KEEPER, 500n * E18, 0n] });
  });
  it("topUpCover and withdrawCover", () => {
    expect(decode(writes.topUpCover(d, key, 5n * E18), cushionVaultAbi)).toEqual({ functionName: "topUp", args: [key, 5n * E18] });
    expect(decode(writes.withdrawCover(d, key, 5n * E18, OWNER), cushionVaultAbi)).toEqual({
      functionName: "withdraw",
      args: [key, 5n * E18, OWNER],
    });
  });
});

describe("publisher writes", () => {
  it("postOverlays batches symbols and overlays", () => {
    const overlay = { validUntil: 1_790_019_800, nextEarnings: 0, flags: 1, ondoMultiplier: 0n, referencePrice: 0n };
    const tx = writes.postOverlays(d, [
      { symbol: "NVDA", overlay },
      { symbol: "CRCL", overlay: { ...overlay, flags: 0, referencePrice: 12_345_000_000n } },
    ]);
    expect(tx.to).toBe(d.sessionOracle);
    const { functionName, args } = decode(tx, sessionOracleAbi);
    expect(functionName).toBe("postOverlays");
    const [syms, data] = args as [Hex[], { validUntil: bigint; flags: number; referencePrice: bigint; postedAt: bigint }[]];
    expect(syms).toEqual([NVDA, symbolToBytes32("CRCL")]);
    expect(data[0]).toMatchObject({ validUntil: 1_790_019_800n, flags: 1, postedAt: 0n });
    expect(data[1]).toMatchObject({ flags: 0, referencePrice: 12_345_000_000n });
  });
});

describe("guardian writes", () => {
  const PROVIDER = addr(0xf1);
  const terms = { account: ACCOUNT, start: 1_790_000_000, end: 1_790_200_000, agentId: 77n };

  it("encodeTerms matches BallastGuardian.encodeTerms", () => {
    const enc = writes.encodeTerms(terms);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }], enc)).toEqual([
      ACCOUNT,
      1_790_000_000n,
      1_790_200_000n,
      77n,
    ]);
  });

  it("createJobWithToken makes the guardian both evaluator and hook", () => {
    const tx = writes.createJobWithToken(d, { provider: PROVIDER, expiredAt: 1_790_400_000, description: "guard NVDA", token: USD1 });
    expect(tx.to).toBe(d.external.kernel);
    expect(decode(tx, kernelAbi)).toEqual({
      functionName: "createJobWithToken",
      args: [PROVIDER, d.guardian, 1_790_400_000n, "guard NVDA", d.guardian, USD1],
    });
  });

  it("setBudget, fund with terms, submit", () => {
    expect(decode(writes.setBudget(d, 9n, E18), kernelAbi)).toEqual({ functionName: "setBudget", args: [9n, E18, "0x"] });
    const fund = decode(writes.fund(d, { jobId: 9n, expectedBudget: E18, terms }), kernelAbi);
    expect(fund).toEqual({ functionName: "fund", args: [9n, E18, writes.encodeTerms(terms)] });
    const deliverable: Hex = `0x${"cd".repeat(32)}`;
    expect(decode(writes.submit(d, 9n, deliverable), kernelAbi)).toEqual({ functionName: "submit", args: [9n, deliverable, "0x"] });
    expect(decode(writes.claimRefund(d, 9n), kernelAbi)).toEqual({ functionName: "claimRefund", args: [9n] });
  });

  it("settle targets the guardian", () => {
    const tx = writes.settle(d, 9n);
    expect(tx.to).toBe(d.guardian);
    expect(decode(tx, ballastGuardianAbi)).toEqual({ functionName: "settle", args: [9n] });
  });
});
