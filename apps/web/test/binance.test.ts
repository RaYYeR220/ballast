/* The Binance Web3 API in the app: the wallet's tokenized stocks (Wallet API) and its lending positions (DeFi
   API), over a mocked fetch that answers in the shapes seen live. Each use has to degrade to an explicit
   "Binance API unavailable" state and fall back to the chain. */
import { bscConfig, tickers } from "@ballast/risk";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { importSource } from "../components/app/CoversPanel";
import { sourceLine } from "../components/app/StockPicker";
import { lendingPositions, matchStocks, STOCK_TOKENS, walletStocks } from "../lib/server/binance-data";
import { web3Client } from "../lib/server/binance";
import { serverEnv } from "../lib/server/env";
import { handleLoans, handleWalletStocks } from "../lib/server/handlers/reads";
import { balanceChangeText } from "../lib/sim";
import { addr, fakeReads } from "./helpers";

const KEYED = serverEnv({ BINANCE_WEB3_API_KEY: "key-123456", BINANCE_WEB3_API_SECRET: "secret-abcdef" });
const KEYLESS = serverEnv({});
const USER = addr(0xb1);
const E18 = 10n ** 18n;
const nvda = tickers.find((t) => t.symbol === "NVDA")!;
const tsla = tickers.find((t) => t.symbol === "TSLA")!;
const USDT = bscConfig.tokens.USDT;

const row = (token: string, symbol: string, raw: bigint, price = "231.55") => ({
  binanceChainId: "56",
  tokenContractAddress: token,
  address: USER,
  symbol,
  balance: (Number(raw) / 1e18).toString(),
  rawBalance: raw.toString(),
  tokenPrice: price,
  isRiskToken: false,
});
const ok = (data: unknown) => new Response(JSON.stringify({ code: "000000", data }), { headers: { "content-type": "application/json" } });
const refused = (code: string, msg: string) => new Response(JSON.stringify({ code, msg }), { headers: { "content-type": "application/json" } });
const page = (rows: unknown[], n = 1) => [{ page: n, pageSize: 50, tokenAssets: rows }];

/** the DeFi position list as the API nests it; `pools` are [poolType, poolCa, tokenList] */
const positions = (protocols: [string, string, [string, string, unknown][]][]) => ({
  totalValue: "0",
  addressList: [
    {
      address: USER,
      addressTotalValue: "0",
      protocolList: protocols.map(([id, value, pools]) => ({
        binanceChainId: "56",
        defiProtocolId: id,
        protocolName: id,
        protocolTotalValue: value,
        poolList: pools.map(([poolType, poolCa, tokenList]) => ({
          bnPoolId: "1",
          poolCa,
          poolType,
          positionCollectionList: [{ positionCollectionId: "1", positionList: [{ positionId: "1", tokenList }] }],
        })),
      })),
    },
  ],
});
const tok = (symbol: string, amount: string) => ({ tokenAddress: addr(1), tokenSymbol: symbol, tokenAmount: amount, tokenValue: "1", tokenDecimals: "18" });

describe("the wallet's tokenized stocks", () => {
  it("knows every configured ticker under all three issuers, and which bStocks have a market", () => {
    expect(STOCK_TOKENS.size).toBe(tickers.length * 3);
    expect(STOCK_TOKENS.get(nvda.bStock.toLowerCase())).toMatchObject({ symbol: "NVDA", issuer: "bStock", market: { id: "lista:NVDAB_USD1", label: "Lista NVDAB / USD1, Venus NVDAB / USDT" } });
    expect(STOCK_TOKENS.get(nvda.ondo.toLowerCase())).toMatchObject({ symbol: "NVDA", issuer: "Ondo", market: null });
    expect(STOCK_TOKENS.get(nvda.xStock.toLowerCase())).toMatchObject({ issuer: "xStock", market: null });
    // a bStock without a lending market is a stock, but not collateral here
    const meta = tickers.find((t) => t.symbol === "META")!;
    expect(STOCK_TOKENS.get(meta.bStock.toLowerCase())!.market).toBeNull();
  });

  it("picks the stocks out of Wallet API rows and ignores everything else", () => {
    const got = matchStocks([
      row(USDT, "USDT", 6n * E18, "0.999"),
      row(nvda.ondo, "NVDAon", 2n * E18, "230"),
      row(nvda.bStock.toUpperCase().replace("0X", "0x"), "NVDAB", 10n * E18, "231.55"),
      row(tsla.bStock, "TSLAB", 0n),
      row(addr(0xdead), "SCAM", 10n ** 30n, "1000000"),
      { tokenContractAddress: "not-an-address", rawBalance: "5" },
      { tokenContractAddress: nvda.xStock, rawBalance: "-5" },
      null,
      "junk",
    ]);
    expect(got.map((s) => [s.symbol, s.issuer, s.tokenSymbol, s.market?.id ?? null])).toEqual([
      ["NVDA", "bStock", "NVDAB", "lista:NVDAB_USD1"],
      ["NVDA", "Ondo", "NVDAon", null],
    ]);
    expect(got[0]).toMatchObject({ token: getAddress(nvda.bStock), rawBalance: (10n * E18).toString(), priceUsd: "231.55" });
  });

  it("reads a bounded number of pages however many the wallet has", async () => {
    const full = Array.from({ length: 50 }, (_, i) => row(addr(0x9000 + i), `T${i}`, E18));
    const f = vi.fn(async () => ok(page(full)));
    const web3 = web3Client(KEYED, f as never)!;
    expect(await walletStocks(web3, USER)).toEqual([]);
    expect(f).toHaveBeenCalledTimes(3);
    const urls = f.mock.calls.map((c) => new URL((c as unknown as [string])[0]));
    expect(urls[0]!.pathname).toBe("/build/api/v1/dex/balance/all-token-balances-by-address");
    expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(urls[0]!.searchParams.get("address")).toBe(USER);
    expect(urls[0]!.searchParams.get("chains")).toBe("56");
    // a short page ends it
    const g = vi.fn(async () => ok(page([row(nvda.bStock, "NVDAB", E18)])));
    expect(await walletStocks(web3Client(KEYED, g as never)!, USER)).toHaveLength(1);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("answers from the Wallet API when it is keyed and on BNB Chain", async () => {
    const f = vi.fn(async () => ok(page([row(nvda.bStock, "NVDAB", 10n * E18), row(nvda.ondo, "NVDAon", E18)])));
    const { client, reads } = fakeReads({});
    const res = await handleWalletStocks(new Request(`http://x/api/wallet-stocks?user=${addr(0xc1)}`), KEYED, client, f as never);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", source: "binance", binance: "ok" });
    expect(body.stocks).toHaveLength(2);
    expect(reads).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain("secret-abcdef");
  });

  it("says Binance is unavailable and reads the same tokens from the chain", async () => {
    // an error comes back as HTTP 200 with a code, as the live API does
    const f = vi.fn(async () => refused("40304", "Service unavailable from a restricted location"));
    const { client, reads } = fakeReads({ balanceOf: ({ address }: { address: string }) => (address.toLowerCase() === nvda.bStock.toLowerCase() ? 7n * E18 : 0n) });
    const body = await (await handleWalletStocks(new Request(`http://x/api/wallet-stocks?user=${addr(0xc2)}`), KEYED, client, f as never)).json();
    expect(body).toMatchObject({ status: "ok", source: "chain", binance: "unavailable", detail: "40304 Service unavailable from a restricted location" });
    expect(body.stocks).toEqual([expect.objectContaining({ symbol: "NVDA", issuer: "bStock", tokenSymbol: "NVDAB", rawBalance: (7n * E18).toString(), priceUsd: null })]);
    // one balance read per configured stock token, no more
    expect(reads.filter((r) => r.functionName === "balanceOf")).toHaveLength(tickers.length * 3);
    expect(sourceLine(body)).toBe("Binance API unavailable: read from BNB Chain instead, without prices.");
  });

  it("reads the chain without keys, never asks Binance about a fork, and says so when nothing answers", async () => {
    const f = vi.fn();
    const chain = fakeReads({ balanceOf: 0n });
    const keyless = await (await handleWalletStocks(new Request(`http://x/api/wallet-stocks?user=${addr(0xc3)}`), KEYLESS, chain.client, f as never)).json();
    expect(keyless).toEqual({ status: "ok", source: "chain", binance: "not-configured", stocks: [] });
    const fork = serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337", BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" });
    expect((await (await handleWalletStocks(new Request(`http://x/api/wallet-stocks?user=${addr(0xc4)}`), fork, chain.client, f as never)).json()).source).toBe("chain");
    expect(f).not.toHaveBeenCalled();
    expect(sourceLine(keyless)).toBe("Read from BNB Chain.");

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const dead = fakeReads({});
    (dead.client as unknown as { getBlock: () => Promise<never> }).getBlock = async () => {
      throw new Error("connection reset");
    };
    const none = await (await handleWalletStocks(new Request(`http://x/api/wallet-stocks?user=${addr(0xc5)}`), KEYED, dead.client, down as never)).json();
    expect(none).toMatchObject({ status: "unavailable", binance: "unavailable" });
    expect(sourceLine(none)).toBe("Binance API unavailable, and BNB Chain did not answer either.");
    expect((await handleWalletStocks(new Request("http://x/api/wallet-stocks?user=0x12"), KEYED, chain.client, f as never)).status).toBe(400);
  });
});

describe("lending positions from the DeFi API", () => {
  const MOOLAH = bscConfig.lista.moolah;
  const COMPTROLLER = bscConfig.venus.comptroller;

  it("finds Lista and Venus loans in the nested list, with what is borrowed and supplied", () => {
    const got = lendingPositions(
      positions([
        ["helio", "2363.48", [["Lending", MOOLAH, { supply: [tok("NVDAB", "10")], borrow: [tok("USD1", "1630.8032631")] }]]],
        ["venus", "186.94", [["Lending", COMPTROLLER, { supply: [tok("XVS", "36.244658817445420873"), tok("USDC", "50")] }]]],
        ["pancakeswap", "12", [["Liquidity", addr(5), { supply: [tok("CAKE", "1")] }]]],
      ]),
    );
    expect(got).toEqual([
      { venue: "lista", protocol: "Lista", valueUsd: "2363.48", borrowed: ["1,630.8 USD1"], supplied: ["10 NVDAB"], onOurMarkets: true },
      { venue: "venus", protocol: "Venus", valueUsd: "186.94", borrowed: [], supplied: ["36.24 XVS", "50 USDC"], onOurMarkets: true },
    ]);
  });

  it("leaves staking out, keeps a borrow wherever it is reported, and survives any shape", () => {
    // seen live: a Lista entry that is only staked BNB
    expect(lendingPositions(positions([["helio", "8.8", [["Staked", addr(7), { supply: [tok("BNB", "0.011991411156139281")] }]]]]))).toEqual([]);
    const odd = lendingPositions(positions([["venus", "5", [["Other", addr(8), [{ type: "borrow", symbol: "USDT", amount: "3" }]]]]]));
    expect(odd).toEqual([{ venue: "venus", protocol: "Venus", valueUsd: "5", borrowed: ["3 USDT"], supplied: [], onOurMarkets: false }]);
    for (const junk of [null, undefined, "x", 7, [], {}, { addressList: "no" }, { addressList: [null, { protocolList: [null, { defiProtocolId: "venus", poolList: "no" }] }] }]) {
      expect(lendingPositions(junk)).toEqual([]);
    }
  });

  it("adds them to the loans answer and says which source answered", async () => {
    const data = positions([["helio", "2363.48", [["Lending", MOOLAH, { supply: [tok("NVDAB", "10")], borrow: [tok("USD1", "1630.8")] }]]]]);
    const f = vi.fn(async () => ok(data));
    const reads = { idToMarketParams: new Error("rpc timeout"), borrowBalanceStored: 0n };
    const body = await (await handleLoans(new Request(`http://x/api/loans?user=${addr(0xd1)}`), KEYED, fakeReads(reads).client, f as never)).json();
    expect(body.status).toBe("ok");
    expect(body.defi).toMatchObject({ status: "ok", lending: [{ venue: "lista", borrowed: ["1,630.8 USD1"] }] });
    expect(importSource(body.defi)).toBe("The Binance DeFi API reports 1 lending position for this wallet. A loan this app can cover is confirmed on BNB Chain below.");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://web3.binance.com/build/api/v1/defi/data/position/list");
    expect(JSON.parse(String(init.body))).toEqual({ addresses: [addr(0xd1)], binanceChainIds: ["56"] });
  });

  it("falls back to the chain alone when Binance does not answer", async () => {
    const f = vi.fn(async () => refused("42900", "Too many requests"));
    const body = await (await handleLoans(new Request(`http://x/api/loans?user=${addr(0xd2)}`), KEYED, fakeReads({ idToMarketParams: new Error("x"), borrowBalanceStored: 0n }).client, f as never)).json();
    expect(body.status).toBe("ok");
    expect(body.defi).toMatchObject({ status: "unavailable", lending: [], detail: "42900 Too many requests" });
    expect(importSource(body.defi)).toBe("Binance API unavailable. Loans are read from BNB Chain only.");
    expect(importSource({ status: "not-configured", protocols: [], lending: [] })).toBe("Loans are read from BNB Chain.");
    expect(importSource({ status: "ok", protocols: [], lending: [] })).toContain("reports no Lista or Venus lending position");
  });
});

describe("what a passed Binance simulation says will change", () => {
  it("reads an approval as an allowance, in the shape the Transaction API returns", () => {
    // from a live answer for approve(1 USDT)
    const sim = {
      balanceChanges: [],
      allowanceChanges: [{ tokenAddress: USDT, owner: USER.toLowerCase(), spender: "0xccd7f069275549793b2a8804a5691fca6665d152", preAmount: "0", postAmount: "1000000000000000000" }],
    };
    expect(balanceChangeText(sim, USER)).toBe("Allowance after: 1 USDT for 0xccd7...d152");
    expect(balanceChangeText({ ...sim, balanceChanges: [{ contractAddress: USDT, tokenType: "Erc20", change: "-1000000000000000000", owner: USER.toLowerCase() }] }, USER)).toBe(
      "Your wallet: -1 USDT. Allowance after: 1 USDT for 0xccd7...d152",
    );
    const unlimited = { allowanceChanges: [{ ...sim.allowanceChanges[0]!, postAmount: (2n ** 256n - 1n).toString() }] };
    expect(balanceChangeText(unlimited, USER)).toBe("Allowance after: an unlimited amount of USDT for 0xccd7...d152");
    expect(balanceChangeText({ allowanceChanges: [{ ...sim.allowanceChanges[0]!, owner: addr(9) }] }, USER)).toBe("");
  });
});
