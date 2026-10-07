// Checks a Ballast deployment against the chain and the repo config: code at every address, the wiring
// between the contracts, Session Oracle params and tickers, the publisher, the guardian's limits and its
// start job id. Prints explorer links; exits non-zero on any mismatch.
//
//   pnpm verify:onchain                                    # BSC mainnet, contracts/deployments/56.json
//   CHAIN_ID=31337 BSC_RPC_URL=http://127.0.0.1:8545 pnpm verify:onchain
//   PUBLISHER_ADDRESS=0x... PUBLISHER_AGENT_ID=123 pnpm verify:onchain   # also pin the publisher
import { session } from "@ballast/risk";
import {
  ballastFactoryAbi,
  ballastGuardianAbi,
  bytes32ToSymbol,
  cushionVaultAbi,
  kernelAbi,
  loadDeployment,
  sessionAwareFeedAbi,
  sessionOracleAbi,
  symbolToBytes32,
  type Deployment,
} from "@ballast/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, getAddress, http, isAddress, parseUnits, zeroAddress, type Address } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "bsc-mainnet.json"), "utf8"));

/** What contracts/script/Deploy.s.sol sets. */
const EXPECTED = {
  params: [5400, 10800, 60, 93600, 21600, 100, 300] as const,
  vaultHorizon: 3 * 3600,
  guardianMinBudget: parseUnits("0.01", 18),
  guardianMinGrace: 3600n,
};

const chainId = Number(process.env.CHAIN_ID ?? "56");
const rpc = process.env.BSC_RPC_URL ?? (chainId === 31337 ? "http://127.0.0.1:8545" : "https://bsc-dataseed.bnbchain.org");
const explorer = chainId === 56 ? "https://bscscan.com/address/" : null;

let failures = 0;
const ok = (what: string) => console.log(`  ok    ${what}`);
const fail = (what: string) => {
  failures++;
  console.log(`  FAIL  ${what}`);
};
const check = (cond: boolean, what: string) => (cond ? ok(what) : fail(what));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const link = (a: string) => (explorer ? `${explorer}${a}` : a);

async function main() {
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const c = createPublicClient({ chain, transport: http(rpc, { batch: true, retryCount: 2 }) });
  const live = await c.getChainId();
  if (live !== chainId) {
    console.error(`RPC is on chain ${live}, expected ${chainId}`);
    process.exit(1);
  }
  let d: Deployment;
  try {
    d = loadDeployment(chainId, { file: process.env.DEPLOYMENT_FILE });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const head = await c.getBlock({ blockTag: "latest" });
  console.log(`Ballast deployment on chain ${chainId} at block ${head.number} (${new Date(Number(head.timestamp) * 1000).toISOString()})`);

  console.log("\ncode");
  const ours: [string, Address][] = [
    ["calendar", d.calendar],
    ["sessionOracle", d.sessionOracle],
    ["sessionAwareFeed", d.sessionAwareFeed],
    ["factory", d.factory],
    ["listaImpl", d.listaImpl],
    ["venusImpl", d.venusImpl],
    ["cushionVault", d.cushionVault],
    ["guardian", d.guardian],
  ];
  const external: [string, Address][] = [
    ["kernel", d.external.kernel],
    ["moolah", d.external.moolah],
    ["comptroller", d.external.comptroller],
    ["venusOracle", d.external.venusOracle],
    ["identityRegistry", d.external.identityRegistry],
    ["reputationRegistry", d.external.reputationRegistry],
    ["pancakeV3Router", d.external.pancakeV3Router],
    ["multicall3", d.external.multicall3],
  ];
  for (const [name, a] of [...ours, ...external]) {
    const code = await c.getCode({ address: a });
    check(!!code && code !== "0x", `${name.padEnd(18)} ${link(a)}`);
  }

  console.log("\nwiring");
  const r = <T>(p: Promise<T>) => p;
  const or = { address: d.sessionOracle, abi: sessionOracleAbi } as const;
  check(same(await r(c.readContract({ ...or, functionName: "calendar" })), d.calendar), "sessionOracle.calendar = calendar");
  check(same(await r(c.readContract({ ...or, functionName: "priceSource" })), cfg.lista.resilientOracle), "sessionOracle.priceSource = Lista resilient oracle");
  check(same(await r(c.readContract({ ...or, functionName: "ondoShares" })), cfg.ondo.sharesOracle), "sessionOracle.ondoShares = Ondo shares oracle");
  const f = { address: d.factory, abi: ballastFactoryAbi } as const;
  check(same(await r(c.readContract({ ...f, functionName: "sessionOracle" })), d.sessionOracle), "factory.sessionOracle = sessionOracle");
  check(same(await r(c.readContract({ ...f, functionName: "listaImpl" })), d.listaImpl), "factory.listaImpl = listaImpl");
  check(same(await r(c.readContract({ ...f, functionName: "venusImpl" })), d.venusImpl), "factory.venusImpl = venusImpl");
  check(same(await r(c.readContract({ ...f, functionName: "moolah" })), d.external.moolah), "factory.moolah = Lista Moolah");
  check(same(await r(c.readContract({ ...f, functionName: "router" })), d.external.pancakeV3Router), "factory.router = PancakeSwap v3 router");
  check(same(await r(c.readContract({ ...f, functionName: "comptroller" })), d.external.comptroller), "factory.comptroller = Venus comptroller");
  const accounts = await c.readContract({ ...f, functionName: "accountCount" });
  ok(`factory.accountCount = ${accounts}`);
  const fd = { address: d.sessionAwareFeed, abi: sessionAwareFeedAbi } as const;
  check(same(await r(c.readContract({ ...fd, functionName: "oracle" })), d.sessionOracle), "sessionAwareFeed.oracle = sessionOracle");
  const v = { address: d.cushionVault, abi: cushionVaultAbi } as const;
  check(same(await r(c.readContract({ ...v, functionName: "sessionOracle" })), d.sessionOracle), "cushionVault.sessionOracle = sessionOracle");
  check(same(await r(c.readContract({ ...v, functionName: "moolah" })), d.external.moolah), "cushionVault.moolah = Lista Moolah");
  const horizon = await c.readContract({ ...v, functionName: "shieldHorizon" });
  check(Number(horizon) === EXPECTED.vaultHorizon, `cushionVault.shieldHorizon = ${horizon} s (expected ${EXPECTED.vaultHorizon})`);
  const g = { address: d.guardian, abi: ballastGuardianAbi } as const;
  check(same(await r(c.readContract({ ...g, functionName: "kernel" })), d.external.kernel), "guardian.kernel = ERC-8183 kernel");
  check(same(await r(c.readContract({ ...g, functionName: "factory" })), d.factory), "guardian.factory = factory");
  check(same(await r(c.readContract({ ...g, functionName: "identity" })), d.external.identityRegistry), "guardian.identity = ERC-8004 identity registry");
  check(same(await r(c.readContract({ ...g, functionName: "reputation" })), d.external.reputationRegistry), "guardian.reputation = ERC-8004 reputation registry");
  const minBudget = await c.readContract({ ...g, functionName: "minBudget" });
  check(minBudget === EXPECTED.guardianMinBudget, `guardian.minBudget = ${minBudget} (expected ${EXPECTED.guardianMinBudget})`);
  const minGrace = await c.readContract({ ...g, functionName: "minGrace" });
  check(minGrace === EXPECTED.guardianMinGrace, `guardian.minGrace = ${minGrace} s (expected ${EXPECTED.guardianMinGrace})`);

  console.log("\nguardian start job id");
  const counter = await c.readContract({ address: d.external.kernel, abi: kernelAbi, functionName: "jobCounter" });
  if (d.guardianStartJobId === undefined) {
    fail("guardianStartJobId missing from the deployment file (the desk would scan the kernel from job 0)");
  } else {
    const start = d.guardianStartJobId;
    check(start <= counter, `guardianStartJobId ${start} <= kernel.jobCounter ${counter}`);
    if (start > 0n) {
      const before = await c.readContract({ address: d.external.kernel, abi: kernelAbi, functionName: "getJob", args: [start] });
      check(!same(before.evaluator, d.guardian), `job ${start} (last before the guardian) is not a guardian job`);
    }
  }

  console.log("\nsession oracle");
  const p = await c.readContract({ ...or, functionName: "params" });
  check(
    p.every((x, i) => Number(x) === EXPECTED.params[i]),
    `params [${p.join(", ")}] (expected [${EXPECTED.params.join(", ")}])`,
  );
  const count = Number(await c.readContract({ ...or, functionName: "symbolCount" }));
  check(count === cfg.tickers.length, `ticker count ${count} (config ${cfg.tickers.length})`);
  for (let i = 0; i < count; i++) {
    const sym = await c.readContract({ ...or, functionName: "symbols", args: [BigInt(i)] });
    const name = bytes32ToSymbol(sym);
    const want = cfg.tickers.find((t: { symbol: string }) => t.symbol === name);
    if (!want) {
      fail(`${name}: listed on-chain but not in config`);
      continue;
    }
    const t = await c.readContract({ ...or, functionName: "ticker", args: [symbolToBytes32(name)] });
    const fields: [string, string, string][] = [
      ["bStock", t.bStock, want.bStock],
      ["ondo", t.ondo, want.ondo],
      ["xStock", t.xStock, want.xStock],
      ["chainlink", t.chainlink, want.chainlink],
    ];
    const bad = fields.filter(([, a, b]) => !same(a, b)).map(([k]) => k);
    const gaps = [t.gapOvernightBps, t.gapWeekendBps, t.gapHolidayBps, t.gapEarningsBps].map(Number);
    const wantGaps = [want.gapBps.overnight, want.gapBps.weekend, want.gapBps.holiday, want.gapBps.earnings];
    if (gaps.some((x, j) => x !== wantGaps[j])) bad.push("gapBps");
    if (!t.listed) bad.push("listed");
    const mapped = await c.readContract({ ...fd, functionName: "symbolOf", args: [t.bStock] });
    if (mapped !== symbolToBytes32(name)) bad.push("sessionAwareFeed mapping");
    check(bad.length === 0, `${name.padEnd(5)} ${bad.length ? `mismatch: ${bad.join(", ")}` : `bStock ${link(t.bStock)}`}`);
  }

  console.log("\npublisher");
  const publisher = await c.readContract({ ...or, functionName: "publisher" });
  const agentId = await c.readContract({ ...or, functionName: "publisherAgentId" });
  const wantPub = process.env.PUBLISHER_ADDRESS;
  if (wantPub) {
    if (!isAddress(wantPub, { strict: false })) fail(`PUBLISHER_ADDRESS is not an address`);
    else check(same(publisher, wantPub), `publisher ${link(publisher)} (expected ${getAddress(wantPub)})`);
  } else {
    check(!same(publisher, zeroAddress), `publisher ${link(publisher)}`);
  }
  if (process.env.PUBLISHER_AGENT_ID) check(agentId === BigInt(process.env.PUBLISHER_AGENT_ID), `publisherAgentId ${agentId} (expected ${process.env.PUBLISHER_AGENT_ID})`);
  else check(chainId === 31337 || agentId !== 0n, `publisherAgentId ${agentId}${chainId === 31337 ? " (fork: may be 0)" : ""}`);

  console.log("\ncalendar");
  const s = session(Number(head.timestamp));
  check(s !== "UNKNOWN", `the session calendar covers the head block (${s})`);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify failed: ${err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err)}`);
  process.exit(1);
});
