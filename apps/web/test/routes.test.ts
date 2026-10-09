import { bscConfig, tickers } from "@ballast/risk";
import { getAddress, stringToHex, zeroHash } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ttlCache } from "../lib/server/cache";
import { deploymentInfo, resolveDeployment, type DeploymentStatus } from "../lib/server/deployment";
import { describeEnv, envProblems, MAINNET, serverEnv } from "../lib/server/env";
import { assertStartup, StartupError, startupProblems } from "../lib/server/startup";
import { handleOracle, readOracle } from "../lib/server/handlers/oracle";
import { handleAccounts, handleLoans, handleMarkets, handleToken, summarizeDefi } from "../lib/server/handlers/reads";
import { handleRwaStatus, readRwaStatus } from "../lib/server/handlers/rwa";
import { clientKey, rateLimiter } from "../lib/server/ratelimit";
import { listaCoverKey, venusCoverKey } from "../lib/server/reads";
import { addr, cloneCode, DEPLOYMENT, fakeReads, NO_COVER } from "./helpers";

const TUE_1100 = 1_791_298_800n; // Tue 6 Oct 2026 11:00 New York, regular session
const CLOSE = 1_791_316_800; // Tue 16:00
const OPEN = 1_791_379_800; // Wed 09:30
const E18 = 10n ** 18n;

const OK: DeploymentStatus = { ok: true, chainId: 31337, deployment: DEPLOYMENT, source: "test" };
const MISSING: DeploymentStatus = { ok: false, chainId: 56, reason: "missing", detail: "no deployment file for chain 56 (contracts/deployments/56.json)" };

const RAW = {
  calendar: addr(0xa1),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
  owner: addr(0xa0),
  block: 5,
  guardianStartJobId: 56910,
};

describe("serverEnv", () => {
  it("defaults to BNB Chain with the public RPC, keyless, no desk URL and the mainnet desk agent as keeper", () => {
    expect(serverEnv({})).toEqual({ chainId: 56, rpcUrl: "https://bsc-rpc.publicnode.com", agentApiUrl: null, binance: null, deskAgent: MAINNET.deskAgent, localRpcUrl: null });
    expect(MAINNET).toEqual({ deskAgent: "0xccD7f069275549793b2A8804A5691fCa6665D152", deskAgentId: 368122n, owner: "0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf" });
    // a fork has no default keeper: it comes from the environment or from the desk itself
    expect(serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" }).deskAgent).toBeNull();
    expect(serverEnv({ DESK_AGENT_ADDRESS: addr(0xd1) }).deskAgent).toBe(addr(0xd1));
  });

  it("reads the fork setup", () => {
    const e = serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337", AGENT_API_URL: "http://127.0.0.1:8787/", DESK_AGENT_ADDRESS: addr(0xd1).toLowerCase() });
    expect(e).toMatchObject({ chainId: 31337, rpcUrl: "http://127.0.0.1:8545", agentApiUrl: "http://127.0.0.1:8787", deskAgent: addr(0xd1), localRpcUrl: "http://127.0.0.1:8545" });
  });

  it("needs both Binance values and ignores a bad desk URL", () => {
    expect(serverEnv({ BINANCE_WEB3_API_KEY: "k" }).binance).toBeNull();
    expect(serverEnv({ BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" }).binance).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(serverEnv({ AGENT_API_URL: "ftp://desk" }).agentApiUrl).toBeNull();
  });
});

describe("startup checks", () => {
  const none = () => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };

  it("accepts an empty environment: every setting has a default or an explicit state", () => {
    expect(envProblems({})).toEqual([]);
    expect(startupProblems({}, none)).toEqual([]);
    expect(startupProblems({ NEXT_PUBLIC_CHAIN_ID: "31337", BSC_RPC_URL: "http://127.0.0.1:8545", DESK_AGENT_ADDRESS: addr(0xd1), DEPLOYMENT_JSON: JSON.stringify(RAW) }, none)).toEqual([]);
  });

  it("names each malformed setting without repeating its value", () => {
    const env = {
      NEXT_PUBLIC_CHAIN_ID: "97",
      BSC_RPC_URL: "wss://user:hunter2@node.example",
      AGENT_API_URL: "desk.internal:8787",
      DESK_AGENT_ADDRESS: "0xnot-an-address",
      BINANCE_WEB3_API_KEY: "key-123456",
    };
    const problems = envProblems(env);
    expect(problems).toEqual([
      "NEXT_PUBLIC_CHAIN_ID: must be 56 (BNB Chain) or 31337 (a local fork)",
      "BSC_RPC_URL: must be an http(s) URL",
      "AGENT_API_URL: must be an http(s) URL",
      "DESK_AGENT_ADDRESS: must be a 0x address of 40 hex characters",
      "BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET: set both or neither",
    ]);
    const text = problems.join(" ");
    for (const secret of ["hunter2", "node.example", "desk.internal", "key-123456", "0xnot"]) expect(text).not.toContain(secret);
  });

  it("refuses to start on a deployment that is named but missing, broken or for another chain", () => {
    expect(startupProblems({ DEPLOYMENT_FILE: "var/nope.json" }, none)).toEqual(["deployment: no deployment file for chain 56 (DEPLOYMENT_FILE)"]);
    expect(startupProblems({ DEPLOYMENT_JSON: "{oops" }, none)).toEqual(["deployment: DEPLOYMENT_JSON is not valid JSON"]);
    expect(startupProblems({ DEPLOYMENT_JSON: JSON.stringify({ ...RAW, chainId: 31337 }) }, none)).toEqual(["deployment: DEPLOYMENT_JSON is for chain 31337, this site runs on chain 56"]);
    expect(startupProblems({ DEPLOYMENT_JSON: JSON.stringify(RAW), DEPLOYMENT_FILE: "x.json" }, none)).toContain("DEPLOYMENT_JSON and DEPLOYMENT_FILE: set one, not both");
    // the repository file may be absent (not deployed yet), but a broken one stops the server
    expect(startupProblems({}, () => "{broken")).toEqual(["deployment: contracts/deployments/56.json is not valid JSON"]);
  });

  it("throws one readable error, or logs one line that carries no value", () => {
    expect(() => assertStartup({ BSC_RPC_URL: "nope", DESK_AGENT_ADDRESS: "nope" }, () => {})).toThrow(StartupError);
    try {
      assertStartup({ BSC_RPC_URL: "nope", DESK_AGENT_ADDRESS: "nope" }, () => {});
    } catch (err) {
      expect((err as Error).message).toBe("Ballast web cannot start, the configuration is invalid:\n  BSC_RPC_URL: must be an http(s) URL\n  DESK_AGENT_ADDRESS: must be a 0x address of 40 hex characters");
    }
    const line = describeEnv({ BSC_RPC_URL: "https://rpc.example/v1/SECRETKEY", AGENT_API_URL: "https://desk.example", BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" });
    expect(line).toBe("chain=56 rpc=configured desk=configured deskAgent=mainnet default binance=keyed deployment=repository file");
  });
});

describe("resolveDeployment", () => {
  const enoent = () => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };

  it("reports a missing deployment instead of throwing", () => {
    const s = resolveDeployment({ chainId: 56, env: {}, readFile: enoent, repoRoot: "/repo" });
    expect(s).toMatchObject({ ok: false, reason: "missing" });
    expect(deploymentInfo(s)).toEqual({ status: "missing", detail: "no deployment file for chain 56 (contracts/deployments/56.json)" });
  });

  it("reads contracts/deployments/<chainId>.json from the repository", () => {
    const readFile = vi.fn((_file: string) => JSON.stringify(RAW));
    const s = resolveDeployment({ chainId: 31337, env: {}, readFile, repoRoot: "/repo" });
    expect(readFile.mock.calls[0]![0].replace(/\\/g, "/")).toMatch(/\/repo\/contracts\/deployments\/31337\.json$/);
    expect(s.ok).toBe(true);
    const info = deploymentInfo(s);
    expect(info).toMatchObject({ status: "ok", json: { chainId: 31337, factory: addr(0xa4), guardianStartJobId: "56910" } });
  });

  it("prefers DEPLOYMENT_JSON, then DEPLOYMENT_FILE", () => {
    const inline = resolveDeployment({ chainId: 31337, env: { DEPLOYMENT_JSON: JSON.stringify(RAW), DEPLOYMENT_FILE: "x.json" }, readFile: enoent });
    expect(inline).toMatchObject({ ok: true, source: "DEPLOYMENT_JSON" });
    const readFile = vi.fn((_file: string) => JSON.stringify(RAW));
    const file = resolveDeployment({ chainId: 31337, env: { DEPLOYMENT_FILE: "var/fork.json" }, readFile, repoRoot: "/repo" });
    expect(file).toMatchObject({ ok: true, source: "DEPLOYMENT_FILE" });
    expect(readFile.mock.calls[0]![0].replace(/\\/g, "/")).toMatch(/\/repo\/var\/fork\.json$/);
  });

  it("rejects a record made for another chain", () => {
    expect(resolveDeployment({ chainId: 56, env: { DEPLOYMENT_JSON: JSON.stringify({ ...RAW, chainId: 31337 }) } })).toMatchObject({ ok: false, reason: "invalid", detail: "DEPLOYMENT_JSON is for chain 31337, this site runs on chain 56" });
    expect(resolveDeployment({ chainId: 31337, env: { DEPLOYMENT_JSON: JSON.stringify({ ...RAW, chainId: 31337 }) } }).ok).toBe(true);
    // a record without a chain id (as the deploy script writes it) is taken for the configured chain
    expect(resolveDeployment({ chainId: 56, env: { DEPLOYMENT_JSON: JSON.stringify(RAW) } }).ok).toBe(true);
  });

  it("reports a broken file as invalid", () => {
    expect(resolveDeployment({ chainId: 56, env: { DEPLOYMENT_JSON: "{not json" } })).toMatchObject({ ok: false, reason: "invalid" });
    expect(resolveDeployment({ chainId: 56, env: { DEPLOYMENT_JSON: JSON.stringify({ ...RAW, factory: "0x12" }) } })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("ttlCache", () => {
  it("caches a value for its TTL, shares one request in flight and never caches a failure", async () => {
    let t = 0;
    const c = ttlCache<number>(1000, { clock: () => t });
    const load = vi.fn(async () => 7);
    expect(await Promise.all([c.get("k", load), c.get("k", load)])).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
    t = 999;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1001;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
    const fail = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(c.get("f", fail)).rejects.toThrow("down");
    await expect(c.get("f", fail)).rejects.toThrow("down");
    expect(fail).toHaveBeenCalledTimes(2);
  });
});

describe("rateLimiter", () => {
  const from = (ip: string) => new Request("http://x/api/simulate", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

  it("lets a client through up to its budget, then answers 429 until the minute is over", async () => {
    let t = 0;
    const l = rateLimiter(2, () => t);
    expect(l.check(from("1.1.1.1"))).toBeNull();
    expect(l.check(from("1.1.1.1"))).toBeNull();
    const blocked = l.check(from("1.1.1.1"))!;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(l.check(from("2.2.2.2"))).toBeNull();
    t = 60_000;
    expect(l.check(from("1.1.1.1"))).toBeNull();
  });

  it("keys on the first forwarded address", () => {
    expect(clientKey(from("9.9.9.9"))).toBe("9.9.9.9");
    expect(clientKey(new Request("http://x/"))).toBe("unknown");
  });
});

// ------------------------------------------------------------------- oracle

const overlay = { validUntil: BigInt(CLOSE), nextEarnings: 0n, flags: 0, ondoMultiplier: 0n, referencePrice: 0n, postedAt: TUE_1100 - 60n };

const oracleAnswers = (extra: Record<string, unknown> = {}) => ({
  session: 5, // REGULAR
  nextClose: BigInt(CLOSE),
  nextOpen: BigInt(OPEN),
  nextWindow: [1, BigInt(CLOSE), BigInt(OPEN)],
  [`currentWindow@${addr(0xa1).toLowerCase()}`]: [0, 0n, 0n],
  rawPrice: [18_640_000_000n, true],
  perSharePrice: [18_640_000_000n, true],
  referenceFor: [18_650_000_000n, TUE_1100 - 30n, true],
  converged: [true, 5n, 0],
  canAddRisk: [true, 0],
  windowAhead: [1, BigInt(CLOSE), BigInt(OPEN), 417],
  [`currentWindow@${addr(0xa2).toLowerCase()}`]: [0, 0, 0n],
  overlay,
  params: [5400, 10800, 60, 93600, 21600, 100, 300],
  ...extra,
});

describe("GET /api/oracle", () => {
  it("says the contracts are not deployed", async () => {
    const res = await handleOracle(MISSING, fakeReads({}).client);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "not-deployed", detail: MISSING.detail });
  });

  it("returns a snapshot for every listed ticker at one block, bigints as strings", async () => {
    const { client, reads } = fakeReads(oracleAnswers(), { timestamp: TUE_1100 });
    const body = await readOracle(client, OK);
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    expect(body.symbols).toHaveLength(tickers.length);
    expect(body.blockNumber).toBe("1000");
    expect(body.symbols[0]).toMatchObject({ symbol: "NVDA", session: "REGULAR", perShare: "18640000000", canAddRisk: true, windowAhead: { window: "OVERNIGHT", gapBps: 417 } });
    expect(new Set(reads.map((r) => r.functionName))).toContain("windowAhead");
  });

  it("isolates a symbol that cannot be read", async () => {
    const nvda = stringToHex("NVDA", { size: 32 });
    const { client } = fakeReads(oracleAnswers({ canAddRisk: ({ args }: { args: readonly unknown[] }) => (args[0] === nvda ? new Error("rpc timeout") : [true, 0]) }), { timestamp: TUE_1100 });
    const body = await readOracle(client, OK);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.symbols[0]).toMatchObject({ symbol: "NVDA", error: expect.stringContaining("snapshot unreadable") });
    expect(body.symbols[1]).toMatchObject({ symbol: "SPY", canAddRisk: true });
  });

  it("reports a chain failure as unavailable", async () => {
    const dead = { ...OK, deployment: { ...DEPLOYMENT, sessionOracle: addr(0xee) } };
    const res = await handleOracle(dead, fakeReads({}).client);
    expect(await res.json()).toMatchObject({ status: "unavailable" });
  });
});

// ----------------------------------------------------------------- accounts

const OWNER = addr(0xb1);
const KEEPER = addr(0xb2);
const ACCOUNT = addr(0xbb);
const USD1 = getAddress(bscConfig.tokens.USD1);
const NVDAB = getAddress(bscConfig.lista.markets.NVDAB_USD1.collateralToken);
const NVDA_MARKET = bscConfig.lista.markets.NVDAB_USD1.id;
const MP = { loanToken: USD1, collateralToken: NVDAB, oracle: addr(0xc4), irm: addr(0xc5), lltv: 75n * 10n ** 16n };

/** idToMarketParams as the chain answers it for a configured Lista market */
function paramsFor({ args }: { args: readonly unknown[] }) {
  const m = Object.values(bscConfig.lista.markets).find((x) => x.id === args[0]);
  if (!m) return new Error("unknown market");
  return [USD1, getAddress(m.collateralToken), MP.oracle, MP.irm, BigInt(m.lltv)];
}

const accountAnswers = () => ({
  ...oracleAnswers(),
  accountsOf: [ACCOUNT],
  idToMarketParams: paramsFor,
  cover: NO_COVER,
  owner: OWNER,
  keeper: KEEPER,
  symbol: stringToHex("NVDA", { size: 32 }),
  mandate: [6000, 4500, 100, true],
  trackedCollateral: 120n * E18,
  liquidationRecorded: false,
  liquidated: false,
  healthStatus: [true, true],
  position: [120n * E18, 15_500n * E18],
  ltvBps: 6930n,
  cushion: 3_000n * E18,
  loanToken: USD1,
  collateralToken: NVDAB,
  decimals: 18,
  moolah: addr(0xc3),
  marketId: `0x${"11".repeat(32)}`,
  marketParams: MP,
  deleveragePathHash: zeroHash,
  getPrice: 18_640n * 10n ** 34n, // 186.40 USD1 per NVDAB at 1e36
  minLoan: 15n * E18,
});

describe("GET /api/accounts", () => {
  it("validates the owner and reports a missing deployment", async () => {
    expect((await handleAccounts(new Request("http://x/api/accounts?owner=nope"), OK, fakeReads({}).client)).status).toBe(400);
    const res = await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}`), MISSING, fakeReads({}).client);
    expect(await res.json()).toEqual({ status: "not-deployed", detail: MISSING.detail });
  });

  it("returns the owner's accounts with health after the coming gap and the keeper's plan", async () => {
    const { client } = fakeReads(accountAnswers(), { timestamp: TUE_1100, code: { [ACCOUNT.toLowerCase()]: cloneCode(DEPLOYMENT.listaImpl) } });
    const res = await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}`), OK, client);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", chainId: 31337, blockNumber: "1000", total: 1, offset: 0, more: false, covers: [], errors: [] });
    const a = body.accounts[0];
    expect(a).toMatchObject({
      address: ACCOUNT,
      venue: "lista",
      symbol: "NVDA",
      collateralSymbol: "NVDAB",
      loanSymbol: "USD1",
      collateral: (120n * E18).toString(),
      debt: (15_500n * E18).toString(),
      ltvBps: 6930,
      lltvBps: 7500,
      priceUsd: 186.4,
      coming: { window: "OVERNIGHT", gapBps: 417, startsAt: CLOSE, endsAt: OPEN, inProgress: false },
      gaps: { overnight: 417, weekend: 737 },
      oracle: { canAddRisk: true, horizon: 10800, restoreDelay: 5400 },
      lista: { deleveragePathSet: false },
    });
    // 69.30% / (1 - 4.17%) = 72.32%: above 75% / 1.05, so a shield is due
    expect(a.ltvAfterGapBps).toBeCloseTo(7231.6, 0);
    // the planner repays from the cushion until the loan survives the gap at HF 1.05
    expect(a.plan).toMatchObject({ kind: "repay", mode: "shield", gapBps: 417 });
    expect(a.plan.steps[0].fn).toBe("shieldRepay");
    expect(BigInt(a.plan.steps[0].assets)).toBeGreaterThan(0n);
  });

  it("keeps the account and says so when the oracle cannot be read", async () => {
    const { client } = fakeReads({ ...accountAnswers(), windowAhead: new Error("rpc timeout") }, { timestamp: TUE_1100, code: { [ACCOUNT.toLowerCase()]: cloneCode(DEPLOYMENT.listaImpl) } });
    const body = await (await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}`), OK, client)).json();
    expect(body.accounts[0]).toMatchObject({ address: ACCOUNT, coming: null, ltvAfterGapBps: null, plan: null, oracle: null });
    expect(body.accounts[0].oracleError).toContain("Session Oracle could not be read for NVDA");
  });

  it("keeps showing the last figures for up to a minute when the chain stops answering", async () => {
    const owner = addr(0xb7);
    const { client, chain } = fakeReads({ ...accountAnswers(), owner }, { timestamp: TUE_1100, code: { [ACCOUNT.toLowerCase()]: cloneCode(DEPLOYMENT.listaImpl) } });
    const url = `http://x/api/accounts?owner=${owner}`;
    let t = 5_000_000;
    const clock = () => t;
    const good = await (await handleAccounts(new Request(url), OK, client, clock)).json();
    expect(good.status).toBe("ok");
    expect(good.stale).toBeUndefined();

    // the chain goes away
    const dead = { ...(client as object), getBlock: async () => { throw new Error("connection reset"); } } as never;
    void chain;
    t += 30_000;
    const stale = await (await handleAccounts(new Request(url), OK, dead, clock)).json();
    // a different client object has its own memory, so use the same one with a failing head
    expect(stale.status).toBe("unavailable");

    const flaky = client as unknown as { getBlock: () => Promise<unknown> };
    const original = flaky.getBlock;
    flaky.getBlock = async () => {
      throw new Error("connection reset");
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10_000); // past the head TTL, so the head is read again and fails
      const kept = await (await handleAccounts(new Request(url), OK, client, clock)).json();
      expect(kept.status).toBe("ok");
      expect(kept.accounts).toEqual(good.accounts);
      expect(kept.stale).toMatchObject({ ageSec: 30, detail: expect.stringContaining("connection reset") });
      // older than a minute: no longer shown as if it were current
      t += 31_000;
      const gone = await (await handleAccounts(new Request(url), OK, client, clock)).json();
      expect(gone.status).toBe("unavailable");
      // another wallet never sees this one's figures
      const other = await (await handleAccounts(new Request(`http://x/api/accounts?owner=${addr(0xb8)}`), OK, client, clock)).json();
      expect(other.status).toBe("unavailable");
    } finally {
      flaky.getBlock = original;
      vi.useRealTimers();
    }
  });

  it("reports a chain failure as unavailable, never as an empty list", async () => {
    const res = await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}`), OK, fakeReads({}).client);
    expect(await res.json()).toMatchObject({ status: "unavailable" });
  });
});

// ------------------------------------------------------------ loans, markets

describe("GET /api/loans", () => {
  const env = serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" });
  const moolahReads = {
    idToMarketParams: paramsFor,
    position: ({ args }: { args: readonly unknown[] }) => (args[0] === NVDA_MARKET ? [0n, 9_000n * E18 * 1_000_000n, 100n * E18] : [0n, 0n, 0n]),
    market: [0n, 0n, 1_000_000n * E18, 1_000_000n * E18 * 1_000_000n, 0n, 0n],
    getPrice: 18_000n * 10n ** 34n,
    decimals: 18,
    borrowBalanceStored: 0n,
  };

  it("finds the wallet's Lista loan and its cover key", async () => {
    const { client } = fakeReads(moolahReads);
    const body = await (await handleLoans(new Request(`http://x/api/loans?user=${OWNER}`), env, client)).json();
    expect(body.status).toBe("ok");
    expect(body.defi).toEqual({ status: "not-configured", protocols: [], lending: [] });
    expect(body.loans).toHaveLength(1);
    expect(body.loans[0]).toMatchObject({ venue: "lista", symbol: "NVDA", collateralSymbol: "NVDAB", loanSymbol: "USD1", lltvBps: 7500, ltvBps: 5000 });
    expect(body.loans[0].key).toBe(listaCoverKey(MP as never));
    expect(Number(BigInt(body.loans[0].debt) / E18)).toBe(9000);
  });

  it("reports unreadable markets instead of hiding them", async () => {
    const { client } = fakeReads({ ...moolahReads, position: new Error("rpc timeout") });
    const body = await (await handleLoans(new Request(`http://x/api/loans?user=${OWNER}`), env, client)).json();
    expect(body.loans).toEqual([]);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("derives distinct cover keys per venue", () => {
    expect(listaCoverKey(MP as never)).not.toBe(venusCoverKey(addr(0xc8)));
    expect(listaCoverKey(MP as never)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("summarizes the DeFi API's nested position list", () => {
    const data = { totalValue: "10", addressList: [{ address: OWNER, protocolList: [{ defiProtocolId: "lista", protocolTotalValue: "7.5" }, { defiProtocolId: 12, protocolTotalValue: "2.5" }] }] };
    expect(summarizeDefi(data)).toEqual([{ id: "lista", valueUsd: "7.5" }, { id: "12", valueUsd: "2.5" }]);
    expect(summarizeDefi(null)).toEqual([]);
  });
});

describe("GET /api/markets and /api/token", () => {
  it("lists the configured markets with live parameters and the configured sale route", async () => {
    const { client } = fakeReads({
      idToMarketParams: paramsFor,
      markets: [true, 60n * 10n ** 16n, false, 65n * 10n ** 16n],
      underlying: NVDAB,
    });
    const res = await handleMarkets(serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" }), client);
    const body = await res.json();
    expect(body.status).toBe("ok");
    // one market could not be confirmed, so this list is marked partial and is not kept
    expect(body.partial).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const nvda = body.markets.find((m: { id: string }) => m.id === "lista:NVDAB_USD1");
    expect(nvda).toMatchObject({ venue: "lista", symbol: "NVDA", lltvBps: 7500, marketParams: { lltv: (75n * 10n ** 16n).toString() } });
    expect(nvda.path.label).toBe("NVDAB to USDT (0.25% pool) to USD1 (0.01% pool)");
    expect(body.markets.find((m: { id: string }) => m.id === "lista:SPYB_USD1")).toMatchObject({ lltvBps: 8500, path: { label: "SPYB to USDT (0.01% pool) to USD1 (0.01% pool)" } });
    // no pool is configured for QQQB: no sale route is offered
    expect(body.markets.find((m: { id: string }) => m.id === "lista:QQQB_USD1").path).toBeNull();
    expect(body.markets.find((m: { id: string }) => m.id === "venus:vNVDAB")).toMatchObject({ venue: "venus", lltvBps: 6500, path: null });
    // the TSLA market's underlying does not match the stubbed NVDAB: flagged, not trusted
    expect(body.markets.find((m: { id: string }) => m.id === "venus:vTSLAB").error).toContain("underlying");
  });

  it("keeps a complete list for the long TTL but never a list with a failed market", async () => {
    const env = serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" });
    let fail = true;
    const underlying = ({ address }: { address: string }) => {
      const m = bscConfig.venus as Record<string, string>;
      if (fail && address.toLowerCase() === m.vTSLAB!.toLowerCase()) return new Error("rpc timeout");
      const t = bscConfig.tickers.find((x) => `v${x.symbol}B` === Object.keys(m).find((k) => m[k]!.toLowerCase() === address.toLowerCase()));
      return getAddress(t!.bStock);
    };
    const { client, reads } = fakeReads({ idToMarketParams: paramsFor, markets: [true, 60n * 10n ** 16n, false, 65n * 10n ** 16n], underlying });
    const count = () => reads.filter((r) => r.functionName === "underlying").length;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(2_000_000);
      const first = await (await handleMarkets(env, client)).json();
      expect(first.partial).toBe(true);
      expect(first.markets.find((m: { id: string }) => m.id === "venus:vTSLAB").error).toContain("could not be read");
      const afterFirst = count();
      // the failure is replayed for a few seconds, then read again: not remembered for ten minutes
      vi.setSystemTime(2_000_000 + 6_000);
      fail = false;
      const second = await handleMarkets(env, client);
      const body = await second.json();
      expect(count()).toBeGreaterThan(afterFirst);
      expect(body.partial).toBeUndefined();
      expect(body.markets.every((m: { error?: string }) => !m.error)).toBe(true);
      expect(second.headers.get("cache-control")).toContain("s-maxage=300");
      // complete: kept
      const afterSecond = count();
      vi.setSystemTime(2_000_000 + 5 * 60_000);
      await handleMarkets(env, client);
      expect(count()).toBe(afterSecond);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a token's balance and allowance", async () => {
    const { client } = fakeReads({ decimals: 18, balanceOf: 5n * E18, allowance: 2n * E18, symbol: "USD1" });
    const ok = await (await handleToken(new Request(`http://x/api/token?token=${USD1}&owner=${OWNER}&spender=${ACCOUNT}`), client)).json();
    expect(ok).toMatchObject({ status: "ok", symbol: "USD1", decimals: 18, balance: (5n * E18).toString(), allowance: (2n * E18).toString() });
    expect((await handleToken(new Request(`http://x/api/token?token=${USD1}`), client)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------- rwa

describe("GET /api/rwa-status", () => {
  const market = { openState: true, marketStatus: "OPEN", reasonCode: null, reasonMsg: null };

  it("returns the market status and one row per listed bStock, keyless", async () => {
    const client = { marketStatus: vi.fn(async () => market), assetStatus: vi.fn(async () => ({ ...market, marketStatus: "TRADING" })) };
    const body = await readRwaStatus(client as never, () => 1_791_298_800_000);
    expect(body).toMatchObject({ status: "ok", fetchedAt: 1_791_298_800, market });
    if (body.status !== "ok") return;
    expect(body.assets).toHaveLength(tickers.length);
    expect(client.assetStatus).toHaveBeenCalledWith("56", tickers[0]!.bStock);
  });

  it("keeps the market status when one asset fails and marks that asset", async () => {
    const client = {
      marketStatus: async () => market,
      assetStatus: async (_c: string, token: string) => {
        if (token === tickers[1]!.bStock) throw new Error("HTTP 429");
        return market;
      },
    };
    const body = await readRwaStatus(client as never);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.assets[1]).toMatchObject({ symbol: tickers[1]!.symbol, status: null, error: "HTTP 429" });
    expect(body.assets[0]!.status).toEqual(market);
  });

  it("answers unavailable, uncached, when Binance does not answer", async () => {
    const client = { marketStatus: async () => { throw new Error("fetch failed"); }, assetStatus: async () => market };
    const res = await handleRwaStatus(client as never);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("fetch failed") });
  });
});
