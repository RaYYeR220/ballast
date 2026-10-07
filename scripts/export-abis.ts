// Reads the Foundry build output and writes packages/sdk/src/abi.ts.
// Run with `pnpm abis` (builds the contracts first).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Fragment = { type: string; name?: string; inputs?: Param[]; [k: string]: unknown };
type Param = { type: string; name?: string; components?: Param[]; [k: string]: unknown };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "contracts", "out");
const target = join(root, "packages", "sdk", "src", "abi.ts");

/** [export name, source file, contract] in output order. `ballast` marks our own contracts. */
const CONTRACTS: { name: string; file: string; contract: string; ballast: boolean }[] = [
  { name: "sessionCalendarAbi", file: "SessionCalendar.sol", contract: "SessionCalendar", ballast: true },
  { name: "sessionOracleAbi", file: "SessionOracle.sol", contract: "SessionOracle", ballast: true },
  { name: "sessionAwareFeedAbi", file: "SessionAwareFeed.sol", contract: "SessionAwareFeed", ballast: true },
  { name: "ballastFactoryAbi", file: "BallastFactory.sol", contract: "BallastFactory", ballast: true },
  { name: "ballastAccountBaseAbi", file: "BallastAccountBase.sol", contract: "BallastAccountBase", ballast: true },
  { name: "listaAccountAbi", file: "ListaAccount.sol", contract: "ListaAccount", ballast: true },
  { name: "venusAccountAbi", file: "VenusAccount.sol", contract: "VenusAccount", ballast: true },
  { name: "cushionVaultAbi", file: "CushionVault.sol", contract: "CushionVault", ballast: true },
  { name: "ballastGuardianAbi", file: "BallastGuardian.sol", contract: "BallastGuardian", ballast: true },
  { name: "kernelAbi", file: "IACP.sol", contract: "IACP", ballast: false },
  { name: "moolahAbi", file: "External.sol", contract: "IMoolah", ballast: false },
  { name: "vTokenAbi", file: "External.sol", contract: "IVToken", ballast: false },
  { name: "comptrollerAbi", file: "External.sol", contract: "IComptroller", ballast: false },
  { name: "venusOracleAbi", file: "External.sol", contract: "IVenusOracle", ballast: false },
  { name: "identityRegistryAbi", file: "External.sol", contract: "IIdentityRegistry", ballast: false },
];

const u256 = (name: string) => ({ name, type: "uint256" });
const bytesP = (name: string) => ({ name, type: "bytes" });

/** BNB Chain APEX kernel (AgenticCommerceUpgradeable) entries that IACP.sol does not declare. */
const KERNEL_EXTRAS: Fragment[] = [
  { type: "function", name: "jobCounter", inputs: [], outputs: [u256("")], stateMutability: "view" },
  {
    type: "function",
    name: "createJobWithToken",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      u256("expiredAt"),
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [u256("jobId")],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "setBudget", inputs: [u256("jobId"), u256("amount"), bytesP("optParams")], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "fund", inputs: [u256("jobId"), u256("expectedBudget"), bytesP("optParams")], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "submit",
    inputs: [u256("jobId"), { name: "deliverable", type: "bytes32" }, bytesP("optParams")],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "claimRefund", inputs: [u256("jobId")], outputs: [], stateMutability: "nonpayable" },
  {
    type: "event",
    name: "JobCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "client", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook", type: "address" },
    ],
  },
];

/**
 * Errors already in the contracts branch but not in this build yet. Each is emitted into
 * ballastErrorsAbi only while no compiled error of the same name exists, so a rebuild after the
 * merge replaces it with the compiled one. Empty this list once the build has them.
 */
const PENDING_ERRORS: Fragment[] = [];

function strip<T>(x: T): T {
  if (Array.isArray(x)) return x.map(strip) as T;
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (k !== "internalType") o[k] = strip(v);
    return o as T;
  }
  return x;
}

const typeOf = (p: Param): string =>
  p.type.startsWith("tuple") ? `(${(p.components ?? []).map(typeOf).join(",")})${p.type.slice(5)}` : p.type;
const signature = (f: Fragment) => `${f.type} ${f.name ?? ""}(${(f.inputs ?? []).map(typeOf).join(",")})`;

function load(file: string, contract: string): Fragment[] {
  const path = join(outDir, file, `${contract}.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Fragment[] };
  return strip(json.abi);
}

function merge(base: Fragment[], extras: Fragment[]): Fragment[] {
  const seen = new Set(base.map(signature));
  return [...base, ...extras.filter((f) => !seen.has(signature(f)))];
}

const blocks: string[] = [];
const errors = new Map<string, Fragment>();
for (const c of CONTRACTS) {
  let abi = load(c.file, c.contract);
  if (c.name === "kernelAbi") abi = merge(abi, KERNEL_EXTRAS);
  if (c.ballast) for (const f of abi) if (f.type === "error") errors.set(signature(f), f);
  blocks.push(`export const ${c.name} = ${JSON.stringify(abi, null, 2)} as const;`);
}
const compiledErrorNames = new Set([...errors.values()].map((f) => f.name));
for (const f of PENDING_ERRORS) if (!compiledErrorNames.has(f.name)) errors.set(signature(f), f);
const errorList = [...errors.values()].sort((a, b) => signature(a).localeCompare(signature(b)));
blocks.push(
  `/** Every custom error the Ballast contracts can revert with (deduplicated), for decoding reverts. */\n` +
    `export const ballastErrorsAbi = ${JSON.stringify(errorList, null, 2)} as const;`,
);

const header = "// Generated by scripts/export-abis.ts from the Foundry build. Do not edit by hand.\n";
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${header}\n${blocks.join("\n\n")}\n`);
console.log(`wrote ${CONTRACTS.length} ABIs and ${errorList.length} errors to ${target}`);
