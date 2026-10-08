/* Live smoke test of the Binance Web3 API calls the app makes, against BNB Chain mainnet. Read-only: balances,
   positions and a simulation; it never broadcasts and never prints the key.

     BINANCE_WEB3_API_KEY=... BINANCE_WEB3_API_SECRET=... npx tsx scripts/binance-smoke.ts [wallet ...]

   Prints, per call, the response shape and what the app's own readers make of it. */
import { transaction, wallet, defi } from "@ballast/binance";
import { bscConfig } from "@ballast/risk";
import { writes } from "@ballast/sdk";
import { getAddress, type Address } from "viem";
import { BINANCE_BSC, binanceMessage, web3Client } from "../lib/server/binance";
import { lendingPositions, matchStocks, walletStocks } from "../lib/server/binance-data";
import { MAINNET, serverEnv } from "../lib/server/env";
import { balanceChangeText } from "../lib/sim";

const shape = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], depth + 1), `(${v.length} rows)`];
  if (v && typeof v === "object") return depth > 12 ? "{...}" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v;
};

async function step(name: string, run: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const out = await run();
    console.log(`\n== ${name}: ok in ${Date.now() - t0} ms`);
    console.log(JSON.stringify(out, null, 1));
  } catch (err) {
    console.log(`\n== ${name}: FAILED in ${Date.now() - t0} ms: ${binanceMessage(err)}`);
  }
}

async function main() {
  const env = serverEnv({ ...process.env, NEXT_PUBLIC_CHAIN_ID: "56" });
  const web3 = web3Client(env);
  if (!web3) {
    console.error("BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are not set: nothing to check");
    process.exit(2);
  }
  // by default: the deployer, a large exchange wallet (lending positions) and the Lista market contract (it holds bStocks)
  const wallets = (process.argv.slice(2).length ? process.argv.slice(2) : [MAINNET.owner, bscConfig.forkWhales.binanceHot, bscConfig.lista.moolah]).map((a) => getAddress(a));
  const usdt = getAddress(bscConfig.tokens.USDT);

  for (const user of wallets) {
    await step(`Wallet API all-token-balances ${user}`, async () => {
      const raw = await wallet.allTokenBalances(web3, { address: user, chains: BINANCE_BSC, page: 1, pageSize: 50 });
      const rows = (Array.isArray(raw) ? raw : [raw]).flatMap((p) => ((p as { tokenAssets?: unknown[] })?.tokenAssets ?? []) as unknown[]);
      return { shape: shape(raw), rowsOnPage1: rows.length, stocksOnPage1: matchStocks(rows), stocksAllPages: (await walletStocks(web3, user)).length };
    });
    await step(`DeFi API positions ${user}`, async () => {
      const raw = await defi.positions(web3, [user], [BINANCE_BSC]);
      return { shape: shape(raw), lending: lendingPositions(raw) };
    });
  }

  const owner = wallets[0] as Address;
  // the app's real preview calls: an exact approval and a 1 USDT transfer-shaped call from a wallet that holds USDT
  const approve = writes.approve(usdt, MAINNET.deskAgent, 10n ** 18n);
  await step("Transaction API simulate: approve(1 USDT)", async () => {
    const r = await transaction.simulate(web3, { binanceChainId: BINANCE_BSC, evmTx: { from: owner, to: approve.to, value: "0", data: approve.data } });
    return { result: r, shape: shape(r) };
  });
  const transfer = `0xa9059cbb${MAINNET.deskAgent.slice(2).toLowerCase().padStart(64, "0")}${(10n ** 18n).toString(16).padStart(64, "0")}`;
  await step("Transaction API simulate: transfer(1 USDT), to read the balance-change units", async () => {
    const r = await transaction.simulate(web3, { binanceChainId: BINANCE_BSC, evmTx: { from: owner, to: usdt, value: "0", data: transfer } });
    return { result: r, appReadsItAs: balanceChangeText({ balanceChanges: r.balanceChanges }, owner) };
  });
  const tooMuch = `0xa9059cbb${MAINNET.deskAgent.slice(2).toLowerCase().padStart(64, "0")}${(10n ** 30n).toString(16).padStart(64, "0")}`;
  await step("Transaction API simulate: a call that must fail (transfer more USDT than the wallet holds)", async () => {
    const r = await transaction.simulate(web3, { binanceChainId: BINANCE_BSC, evmTx: { from: owner, to: usdt, value: "0", data: tooMuch } });
    return { status: r.status, failReason: r.failReason };
  });
}

main().catch((err) => {
  console.error(binanceMessage(err));
  process.exit(1);
});
