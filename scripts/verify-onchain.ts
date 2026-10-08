// Checks a Ballast deployment against the chain, the repo config and the build: code at every address, the
// runtime bytecode against the forge artifacts, the external addresses against config/bsc-mainnet.json, the
// wiring between the contracts, Session Oracle params and tickers, the publisher and its ERC-8004 identity,
// the guardian's limits and start job id, and the on-chain calendar. Prints explorer links; exits non-zero on
// any mismatch.
//
//   pnpm verify:onchain                                    # BSC mainnet, contracts/deployments/56.json
//   CHAIN_ID=31337 BSC_RPC_URL=http://127.0.0.1:8545 pnpm verify:onchain
//   PUBLISHER_ADDRESS=0x... PUBLISHER_AGENT_ID=123 pnpm verify:onchain   # also pin the publisher
//   VERIFY_SKIP_BYTECODE=1 pnpm verify:onchain            # host without forge artifacts (contracts/out)
//
// Bytecode method: for each contract the deployed runtime code (eth_getCode) is compared with the artifact's
// deployedBytecode from `forge build` (contracts/out/<Name>.sol/<Name>.json). Both must have the same length.
// The byte ranges the artifact lists under immutableReferences are zeroed in both (immutables are constructor
// arguments, checked separately under "wiring"), and the trailing CBOR metadata (its length is the last two
// bytes) is cut from both, since it only hashes sources and compiler settings and differs with a comment.
// The keccak256 of what remains must be equal. Build with the pinned solc and optimizer settings in
// contracts/foundry.toml at the commit that was deployed, or the comparison fails by design.
import { session } from "@ballast/risk";
import {
  ballastFactoryAbi,
  ballastGuardianAbi,
  bytes32ToSymbol,
  identityRegistryAbi,
  sessionCalendarAbi,
  sessionName,
  cushionVaultAbi,
  kernelAbi,
  loadDeployment,
  sessionAwareFeedAbi,
  sessionOracleAbi,
  symbolToBytes32,
  type Deployment,
} from "@ballast/sdk";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, defineChain, getAddress, hexToBytes, http, isAddress, keccak256, parseUnits, zeroAddress, type Address, type Hex } from "viem";

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

/** Deployment key -> forge artifact name. */
const ARTIFACTS: [keyof Deployment & string, string][] = [
  ["calendar", "SessionCalendar"],
  ["sessionOracle", "SessionOracle"],
  ["sessionAwareFeed", "SessionAwareFeed"],
  ["factory", "BallastFactory"],
  ["listaImpl", "ListaAccount"],
  ["venusImpl", "VenusAccount"],
  ["cushionVault", "CushionVault"],
  ["guardian", "BallastGuardian"],
];

interface Artifact {
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]>; linkReferences?: Record<string, unknown> };
}

/** Runtime code with the immutable ranges zeroed and the CBOR metadata cut off (see the header). */
export function comparableCode(code: Hex, immutables: { start: number; length: number }[]): Uint8Array {
  const b = hexToBytes(code);
  for (const r of immutables) b.fill(0, r.start, r.start + r.length);
  if (b.length < 2) return b;
  const meta = ((b[b.length - 2] as number) << 8) | (b[b.length - 1] as number);
  return meta + 2 <= b.length ? b.subarray(0, b.length - meta - 2) : b;
}

/** Null when the deployed code matches the artifact, else why not. */
export function bytecodeMismatch(onchain: Hex, artifact: Artifact): string | null {
  const built = artifact.deployedBytecode.object;
  if (Object.keys(artifact.deployedBytecode.linkReferences ?? {}).length > 0) return "the artifact has unlinked libraries";
  if (onchain.length !== built.length) return `length ${(onchain.length - 2) / 2} bytes on-chain, ${(built.length - 2) / 2} in the artifact`;
  const refs = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat();
  const a = keccak256(comparableCode(onchain, refs));
  const b = keccak256(comparableCode(built, refs));
  return a === b ? null : `code hash ${a.slice(0, 18)}... on-chain, ${b.slice(0, 18)}... in the artifact`;
}

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

  console.log("\nbytecode (forge artifacts, immutables and metadata ignored)");
  const outDir = path.join(ROOT, "contracts", "out");
  if (process.env.VERIFY_SKIP_BYTECODE === "1") {
    console.log("  skip  VERIFY_SKIP_BYTECODE=1: run this check on the machine that built and deployed the contracts");
  } else if (!existsSync(outDir)) {
    fail("contracts/out not found: run `pnpm contracts:build` first, or set VERIFY_SKIP_BYTECODE=1 on a host without forge");
  } else {
    for (const [key, name] of ARTIFACTS) {
      const file = path.join(outDir, `${name}.sol`, `${name}.json`);
      if (!existsSync(file)) {
        fail(`${key.padEnd(18)} artifact ${name}.json not found`);
        continue;
      }
      const artifact = JSON.parse(readFileSync(file, "utf8")) as Artifact;
      const code = (await c.getCode({ address: d[key] as Address })) ?? "0x";
      const why = bytecodeMismatch(code, artifact);
      check(why === null, `${key.padEnd(18)} ${why === null ? `= ${name} (${(code.length - 2) / 2} bytes)` : `differs from ${name}: ${why}`}`);
    }
  }

  console.log("\nexternal addresses (config/bsc-mainnet.json)");
  const wantExternal: [string, Address, string][] = [
    ["kernel", d.external.kernel, cfg.erc8183.kernel],
    ["moolah", d.external.moolah, cfg.lista.moolah],
    ["comptroller", d.external.comptroller, cfg.venus.comptroller],
    ["venusOracle", d.external.venusOracle, cfg.venus.oracle],
    ["identityRegistry", d.external.identityRegistry, cfg.erc8004.identity],
    ["reputationRegistry", d.external.reputationRegistry, cfg.erc8004.reputation],
    ["pancakeV3Router", d.external.pancakeV3Router, cfg.pancake.v3SwapRouter],
    ...Object.entries(cfg.tokens as Record<string, string>).map(([sym, a]): [string, Address, string] => [`token ${sym}`, (d.external.tokens[sym] ?? zeroAddress) as Address, a]),
  ];
  if (chainId === 56) check(Number(cfg.chainId) === 56, `config chainId ${cfg.chainId}`);
  for (const [name, used, want] of wantExternal) check(same(used, want), `${name.padEnd(18)} ${used}${same(used, want) ? "" : ` (config has ${want})`}`);

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
  // The ERC-8004 identity the oracle names must belong to the desk key: its owner or its agent wallet.
  if (agentId === 0n) {
    if (chainId === 31337) console.log("  skip  ERC-8004 identity: no publisherAgentId on the fork");
  } else {
    const id = { address: d.external.identityRegistry, abi: identityRegistryAbi } as const;
    const owner = await c.readContract({ ...id, functionName: "ownerOf", args: [agentId] }).catch(() => null);
    const wallet = await c.readContract({ ...id, functionName: "getAgentWallet", args: [agentId] }).catch(() => null);
    if (owner === null) fail(`ERC-8004 identity ${agentId} does not exist in the registry`);
    else {
      const how = same(owner, publisher) ? "owner" : wallet && same(wallet, publisher) ? "agent wallet" : null;
      check(how !== null, `ERC-8004 identity ${agentId} ${how ? `belongs to the publisher (${how})` : `is owned by ${owner}${wallet && !same(wallet, zeroAddress) ? `, wallet ${wallet}` : ""}, not the publisher`}`);
    }
  }

  console.log("\ncalendar");
  const onchain = sessionName(await c.readContract({ address: d.calendar, abi: sessionCalendarAbi, functionName: "session", args: [head.timestamp] }));
  const s = session(Number(head.timestamp));
  check(onchain !== "UNKNOWN", `the on-chain calendar covers the head block (${onchain})`);
  check(onchain === s, `on-chain session ${onchain} = the desk's calendar ${s}`);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// Run only as a script (the bytecode helpers above are imported by a test).
const invoked = process.argv[1] && existsSync(process.argv[1]) ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (invoked === import.meta.url)
  main().catch((err) => {
    console.error(`verify failed: ${err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err)}`);
    process.exit(1);
  });
