// Renders PROOF.md from data files:
//   contracts/deployments/56.json   addresses written by the mainnet deploy script (absent until it has run)
//   data/proof-txs.json             mainnet transactions, appended by scripts/demo/mainnet.ts or by hand:
//                                   { label, txHash, at, note, step, chainId }[] (other fields are ignored)
//   data/proof-notes.json           optional: sentences shown under the transactions (corrections, incidents)
//   data/test-counts.json           test results, updated by hand after each full run
//   config/bsc-mainnet.json         the existing mainnet contracts Ballast calls
//   contracts/test                  the test functions the counts and the proof table refer to
// Nothing is fetched and nothing is filled in: without a deployment file the page says the deployment is
// pending, and a malformed address, hash or date stops the run with an error instead of rendering a link.
//
//   pnpm proof             # write PROOF.md
//   pnpm proof --check     # exit 1 when PROOF.md is not what the data renders
//
// Paths can be overridden for a dry run: --deployment <file> --txs <file> --notes <file> --counts <file> --out <file>.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 56;
const EXPLORER = "https://bscscan.com";
const SOURCIFY = "https://repo.sourcify.dev/56";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEST_FN = /^\s*function\s+(test\w*)\s*\(/gm;

// ------------------------------------------------------------------ inputs

/** Deployment keys in the order they are shown, with what each contract is for. */
const CONTRACTS: readonly (readonly [key: string, name: string, role: string])[] = [
  ["calendar", "SessionCalendar", "NYSE session calendar for 2026 and 2027. No admin, no oracle."],
  ["sessionOracle", "SessionOracle", "Per-share prices, closure windows, the publisher overlay and `canAddRisk`."],
  ["sessionAwareFeed", "SessionAwareFeed", "Lista-compatible price source that holds a band while the market is closed."],
  ["factory", "BallastFactory", "Creates and registers the per-user accounts."],
  ["listaImpl", "ListaAccount (implementation)", "Logic behind every Lista account clone."],
  ["venusImpl", "VenusAccount (implementation)", "Logic behind every Venus account clone."],
  ["cushionVault", "CushionVault", "Cushions for loans that stay on the user's own address."],
  ["guardian", "BallastGuardian", "ERC-8183 hook and evaluator for guard jobs."],
];

/** Other teams' mainnet contracts, by their path in config/bsc-mainnet.json. */
const EXTERNAL: readonly (readonly [path: string, name: string])[] = [
  ["lista.moolah", "Lista Lending (Moolah)"],
  ["lista.resilientOracle", "Lista resilient oracle (the Session Oracle's raw price source)"],
  ["venus.comptroller", "Venus core pool comptroller"],
  ["venus.oracle", "Venus oracle"],
  ["pancake.v3SwapRouter", "PancakeSwap v3 swap router"],
  ["ondo.sharesOracle", "Ondo shares oracle (sValue)"],
  ["erc8183.kernel", "ERC-8183 kernel (BNB Chain AgenticCommerce)"],
  ["erc8004.identity", "ERC-8004 identity registry"],
  ["erc8004.reputation", "ERC-8004 reputation registry"],
];

/** What the fork suite proves. Every test named here must exist in its file, or the run stops. */
const FORK_PROOFS: readonly (readonly [claim: string, file: string, test: string])[] = [
  ["A keeper `restore` while the US market is closed reverts with `RestoreRefused(NOT_REGULAR)` and the debt does not move", "ListaAccount.fork.t.sol", "test_restore_refusedOnWeekend_andMovesNothing"],
  ["The same refusal on a Venus account", "VenusAccount.fork.t.sol", "test_restore_refusedOnWeekend_venus"],
  ["The keeper cannot borrow out, withdraw collateral or cushion, change the mandate or the keeper, rescue tokens or set the swap path", "ListaAccount.fork.t.sol", "test_keeperCannotTouchOwnerFunctions"],
  ["A cushion repay works while Lista's stock oracle refuses to price the collateral", "ListaAccount.fork.t.sol", "test_shieldRepay_worksWhileListaSwitchClosed"],
  ["A flash deleverage through a real PancakeSwap v3 pool lowers the LTV and the proceeds stay in the account", "ListaAccount.fork.t.sol", "test_flashDeleverage_reducesLtvAndKeepsProceedsInside"],
  ["The sale must clear a floor derived from the venue oracle", "ListaAccount.fork.t.sol", "test_flashDeleverage_enforcesOracleFloor"],
  ["A sale is refused when no closure is near and the loan is under the owner's cap", "ListaAccount.fork.t.sol", "test_deleverage_refusedOutsideWindow"],
  ["A keeper sale switches auto-restore off until the owner turns it back on", "ListaAccount.fork.t.sol", "test_keeperDeleverage_cushionShort_sellsAndHandsBackRestore"],
  ["Restore and shield repeated over three sessions only ever repay; no collateral leaves the account", "ListaAccount.fork.t.sol", "test_crossSessionRestoreLoop_onlyRepaysNeverSells"],
  ["The owner can always repay, withdraw the collateral and withdraw the cushion", "ListaAccount.fork.t.sol", "test_ownerCanAlwaysExit"],
  ["A seizure is detected, anyone can latch it, and donated collateral cannot hide it", "ListaAccount.fork.t.sol", "test_liquidationIsDetected"],
  ["A $5 Venus position, the size planned for mainnet, can be shielded", "VenusAccount.fork.t.sol", "test_tinyPosition_likeMainnetDemo"],
  ["CushionVault: the keeper repays a loan held on the user's own address, with no authorization from that address", "CushionVault.fork.t.sol", "test_keeperRepaysUserDebtBeforeClose_withoutAuthorization"],
  ["CushionVault refuses to spend far from a closure", "CushionVault.fork.t.sol", "test_refusedFarFromClose"],
  ["CushionVault enforces the user's daily cap", "CushionVault.fork.t.sol", "test_dailyCap"],
  ["A -5% print on a Saturday liquidates a market priced by Lista's oracle and not the same market priced by SessionAwareFeed", "SessionAwareFeed.fork.t.sol", "test_saturdayWick_liquidatesListaMarketOnly"],
  ["A move that is still there in Monday's regular session liquidates both markets", "SessionAwareFeed.fork.t.sol", "test_persistentMove_liquidatesBothAtTheOpen"],
  ["Guardian: an account that survived the window pays the guardian and writes ERC-8004 feedback", "BallastGuardian.fork.t.sol", "test_survivedWindow_paysGuardianAndWritesReputation"],
  ["Guardian: a liquidated account refunds the client", "BallastGuardian.fork.t.sol", "test_liquidatedAccount_refundsClientAndWritesZero"],
  ["Guardian: a job that was never submitted cannot be settled; the client claims the refund from the kernel at expiry", "BallastGuardian.fork.t.sol", "test_fundedNeverSubmitted_settleReverts_thenClientClaimsRefundAtExpiry"],
  ["Guardian: a client cannot hire itself", "BallastGuardian.fork.t.sol", "test_selfDealing_clientIsProvider"],
];

export interface Deployment {
  block: number;
  owner: string | null;
  guardianStartJobId: string | null;
  addresses: Record<string, string>;
}

export interface ProofTx {
  label: string;
  txHash: string;
  at: string;
  note: string;
  /** Step of the recorded cycle this transaction matches (data/README.md), or "". */
  step: string;
}

export interface Suite {
  id: string;
  name: string;
  covers: string;
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  ranAt: string;
  note: string;
}

export interface ProofInput {
  deployment: Deployment | null;
  txs: ProofTx[];
  /** Sentences shown under the transactions. */
  notes: string[];
  suites: Suite[];
  external: { name: string; address: string }[];
  /** Test functions found in contracts/test (unit) and contracts/test/fork, per file. */
  tests: { unit: Record<string, string[]>; fork: Record<string, string[]> };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return v.trim();
};
const count = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a whole number, zero or more`);
  return v;
};
const address = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error(`${what} is not an address`);
  return v;
};

export function parseDeployment(json: unknown, where: string): Deployment {
  if (!isObject(json)) throw new Error(`${where}: expected an object`);
  const addresses: Record<string, string> = {};
  for (const [key] of CONTRACTS) addresses[key] = address(json[key], `${where}: "${key}"`);
  const start = json.guardianStartJobId;
  if (start !== undefined && !/^\d+$/.test(String(start))) throw new Error(`${where}: "guardianStartJobId" must be a number`);
  return {
    block: count(json.block, `${where}: "block"`),
    owner: json.owner === undefined ? null : address(json.owner, `${where}: "owner"`),
    guardianStartJobId: start === undefined ? null : String(start),
    addresses,
  };
}

export function parseTxs(json: unknown, where: string): ProofTx[] {
  if (!Array.isArray(json)) throw new Error(`${where}: expected a list`);
  const seen = new Set<string>();
  const out = json.map((raw, i): ProofTx => {
    const at = `${where}[${i}]`;
    if (!isObject(raw)) throw new Error(`${at}: expected { label, txHash, at, note, step, chainId }`);
    if (raw.chainId !== undefined && raw.chainId !== CHAIN_ID) throw new Error(`${at}: chainId ${String(raw.chainId)} is not BSC mainnet (${CHAIN_ID}); only mainnet transactions belong here`);
    if (raw.step !== undefined && typeof raw.step !== "string") throw new Error(`${at}: "step" must be a string`);
    const txHash = typeof raw.txHash === "string" ? raw.txHash : "";
    if (!TX_HASH.test(txHash)) throw new Error(`${at}: "txHash" is not a transaction hash (0x and 64 hex digits)`);
    if (seen.has(txHash.toLowerCase())) throw new Error(`${at}: the transaction ${txHash} is listed twice`);
    seen.add(txHash.toLowerCase());
    const when = typeof raw.at === "string" ? raw.at : "";
    if (!ISO_UTC.test(when) || Number.isNaN(Date.parse(when))) throw new Error(`${at}: "at" must be a UTC time such as 2026-10-09T19:02:11Z`);
    if (raw.note !== undefined && typeof raw.note !== "string") throw new Error(`${at}: "note" must be a string`);
    return { label: text(raw.label, `${at}: "label"`), txHash, at: when, note: (raw.note ?? "").trim(), step: (raw.step ?? "").trim() };
  });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function parseNotes(json: unknown, where: string): string[] {
  if (!Array.isArray(json) || json.some((n) => typeof n !== "string" || n.trim() === "")) throw new Error(`${where}: expected a list of sentences`);
  return json.map((n) => (n as string).trim());
}

export function parseSuites(json: unknown, where: string): Suite[] {
  const list = isObject(json) ? json.suites : undefined;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where}: expected { "suites": [...] }`);
  return list.map((raw, i): Suite => {
    const at = `${where}: suites[${i}]`;
    if (!isObject(raw)) throw new Error(`${at}: expected an object`);
    const ranAt = typeof raw.ranAt === "string" ? raw.ranAt : "";
    if (!ISO_DAY.test(ranAt) || Number.isNaN(Date.parse(`${ranAt}T00:00:00Z`))) throw new Error(`${at}: "ranAt" must be a date such as 2026-10-08`);
    return {
      id: text(raw.id, `${at}: "id"`),
      name: text(raw.name, `${at}: "name"`),
      covers: text(raw.covers, `${at}: "covers"`),
      command: text(raw.command, `${at}: "command"`),
      passed: count(raw.passed, `${at}: "passed"`),
      failed: count(raw.failed, `${at}: "failed"`),
      skipped: count(raw.skipped, `${at}: "skipped"`),
      ranAt,
      note: typeof raw.note === "string" ? raw.note.trim() : "",
    };
  });
}

function configAddress(config: unknown, dotted: string): string {
  let v: unknown = config;
  for (const k of dotted.split(".")) v = isObject(v) ? v[k] : undefined;
  return address(v, `config/bsc-mainnet.json: "${dotted}"`);
}

/** Test function names per `.t.sol` file directly inside `dir`. */
function testFunctions(dir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".t.sol")) continue;
    out[f] = [...readFileSync(path.join(dir, f), "utf8").matchAll(TEST_FN)].map((m) => m[1] as string);
  }
  return out;
}

// ------------------------------------------------------------------ render

/** One table cell: one line, pipes escaped, anything outside printable ASCII replaced (labels come from scripts). */
const cell = (s: string) => s.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?").replace(/\|/g, "\\|").trim();
/** A transaction that was sent to fail: the refused restore of the cycle. It is mined and reverts by design. */
const revertsOnPurpose = (t: ProofTx) => t.step === "restore-refused" || /^refused restore/i.test(t.label);
const addressLink = (a: string) => `[\`${a}\`](${EXPLORER}/address/${a}#code)`;
const txLink = (h: string) => `[\`${h.slice(0, 10)}...${h.slice(-8)}\`](${EXPLORER}/tx/${h})`;
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const total = (m: Record<string, string[]>) => Object.values(m).reduce((n, list) => n + list.length, 0);

/** Stops the run when a recorded contract count is not the number of test functions in the tree. */
function checkCounts(i: ProofInput): void {
  for (const [id, found] of [["contracts-unit", total(i.tests.unit)], ["contracts-fork", total(i.tests.fork)]] as const) {
    const s = i.suites.find((x) => x.id === id);
    if (!s) throw new Error(`data/test-counts.json has no "${id}" suite`);
    const recorded = s.passed + s.failed + s.skipped;
    if (recorded !== found) {
      throw new Error(`data/test-counts.json is stale: "${id}" records ${recorded} tests but contracts/test has ${found} test functions. Run \`${s.command}\` and update the file.`);
    }
  }
  for (const [, file, test] of FORK_PROOFS) {
    if (!i.tests.fork[file]?.includes(test)) throw new Error(`contracts/test/fork/${file} has no test named ${test}: fix the proof table in scripts/proof.ts`);
  }
}

export function renderProof(i: ProofInput): string {
  checkCounts(i);
  const L: string[] = [];
  const p = (...lines: string[]) => L.push(...lines);

  p(
    "# Proof",
    "",
    "This page is written by `pnpm proof` from the data files below. To change it, change the data and run the command again.",
    "",
    "| Source | What it holds |",
    "|---|---|",
    "| `contracts/deployments/56.json` | addresses written by the mainnet deploy script |",
    "| `data/proof-txs.json` | mainnet transactions, appended by `scripts/demo/mainnet.ts` as it sends them, or by hand |",
    "| `data/proof-notes.json` | corrections and incidents, shown under the transactions |",
    "| `data/test-counts.json` | test results, updated by hand after each full run |",
    "| `config/bsc-mainnet.json` | the existing mainnet contracts Ballast calls |",
    "",
    "Nothing here is fetched or estimated. A missing deployment file renders as \"pending\". A malformed address, hash or date stops the command.",
    "",
  );

  p("## 1. Mainnet deployment", "");
  const d = i.deployment;
  if (!d) {
    p(
      "**Mainnet deployment pending.** `contracts/deployments/56.json` is not in the repository, so there is no Ballast address on BSC mainnet to list. Until that file exists, every statement about Ballast on mainnet is a plan, not a fact. What can be checked today is in sections 3 and 4.",
      "",
    );
  } else {
    const by = d.owner ? `, owner [\`${d.owner}\`](${EXPLORER}/address/${d.owner})` : "";
    p(`BSC mainnet (chain ${CHAIN_ID}), deployed at block [${d.block}](${EXPLORER}/block/${d.block})${by}.`, "", "| Contract | Address | Source | What it does |", "|---|---|---|---|");
    for (const [key, name, role] of CONTRACTS) p(`| ${name} | ${addressLink(d.addresses[key] as string)} | [Sourcify](${SOURCIFY}/${d.addresses[key]}/) | ${cell(role)} |`);
    p("");
    if (d.guardianStartJobId !== null) p(`The ERC-8183 kernel's job counter stood at ${d.guardianStartJobId} when the guardian was deployed, so no guard job has a lower id.`, "");
    p(
      "The address opens the contract's code tab on BscScan; the Sourcify link opens its verified source, if there is one. Neither is taken on trust here: to check the deployment against the chain, the repository config and a local build, run",
      "",
      "```bash",
      "pnpm contracts:build",
      "BSC_RPC_URL=<rpc> pnpm verify:onchain",
      "```",
      "",
    );
  }

  p("## 2. Mainnet transactions", "");
  if (i.txs.length === 0) {
    p("No mainnet transactions are recorded yet. `data/proof-txs.json` is empty.", "");
  } else {
    p("| When | What | Transaction | Expected | Note |", "|---|---|---|---|---|");
    for (const t of i.txs) p(`| ${utc(t.at)} | ${cell(t.label)} | ${txLink(t.txHash)} | ${revertsOnPurpose(t) ? "revert, on purpose" : "success"} | ${cell(t.note)} |`);
    p("", "A revert on purpose is a restore sent while the Session Oracle refuses added risk: the transaction is mined, fails with `RestoreRefused` and moves nothing. The Expected column comes from the entry, not from the chain: the link shows what happened.", "");
  }
  if (i.notes.length > 0) {
    p("Notes:", "");
    for (const n of i.notes) p(`- ${cell(n)}`);
    p("");
  }

  p("## 3. Tests", "", "| Suite | Covers | Passed | Failed | Skipped | Last full run | Command |", "|---|---|---|---|---|---|---|");
  for (const s of i.suites) p(`| ${cell(s.name)} | ${cell(s.covers)} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.ranAt} | \`${s.command.replace(/\|/g, "\\|")}\` |`);
  p("");
  for (const s of i.suites) if (s.note) p(`- ${s.name}: ${s.note}`);
  p(
    "",
    `The two contract rows are checked against the tree each time this page is written: contracts/test holds ${total(i.tests.unit)} unit test functions and ${total(i.tests.fork)} fork test functions.`,
    "",
  );

  p(
    "## 4. What the fork tests prove",
    "",
    "The fork suite runs the contracts against real BSC mainnet state: Lista Lending, Venus, PancakeSwap v3, the bStock tokens, the ERC-8183 kernel and the ERC-8004 registries. `MOCKS.md` lists what is mocked on top of that state. To run one test:",
    "",
    "```bash",
    "cd contracts && forge test --match-test <test name> -vv",
    "```",
    "",
    "| Claim | Test | File (contracts/test/fork) |",
    "|---|---|---|",
  );
  for (const [claim, file, test] of FORK_PROOFS) p(`| ${cell(claim)} | \`${test}\` | \`${file}\` |`);
  p("");

  p(
    "## 5. Mainnet contracts Ballast builds on",
    "",
    "From `config/bsc-mainnet.json`. These belong to other teams and are listed so the wiring can be checked.",
    "",
    "| Contract | Address |",
    "|---|---|",
  );
  for (const e of i.external) p(`| ${cell(e.name)} | ${addressLink(e.address)} |`);
  p("");

  const out = L.join("\n");
  const bad = /[^\n\x20-\x7e]/.exec(out);
  if (bad) {
    const code = (bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    throw new Error(`PROOF.md must stay plain ASCII: found U+${code} (check the labels and notes in the data files)`);
  }
  return out;
}

// -------------------------------------------------------------------- main

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${path.relative(ROOT, file)}: ${(err as Error).message}`);
  }
}

function main(argv: string[]): void {
  const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (i >= 0 && !v) throw new Error(`${name} needs a path`);
    return v ? path.resolve(v) : path.join(ROOT, fallback);
  };
  const deploymentFile = flag("--deployment", `contracts/deployments/${CHAIN_ID}.json`);
  const txsFile = flag("--txs", "data/proof-txs.json");
  const notesFile = flag("--notes", "data/proof-notes.json");
  const countsFile = flag("--counts", "data/test-counts.json");
  const outFile = flag("--out", "PROOF.md");
  const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

  const config = readJson(path.join(ROOT, "config", "bsc-mainnet.json"));
  const input: ProofInput = {
    deployment: existsSync(deploymentFile) ? parseDeployment(readJson(deploymentFile), rel(deploymentFile)) : null,
    txs: parseTxs(readJson(txsFile), rel(txsFile)),
    notes: existsSync(notesFile) ? parseNotes(readJson(notesFile), rel(notesFile)) : [],
    suites: parseSuites(readJson(countsFile), rel(countsFile)),
    external: EXTERNAL.map(([dotted, name]) => ({ name, address: configAddress(config, dotted) })),
    tests: { unit: testFunctions(path.join(ROOT, "contracts", "test")), fork: testFunctions(path.join(ROOT, "contracts", "test", "fork")) },
  };
  const rendered = renderProof(input);
  const state = input.deployment ? "deployment listed" : "deployment pending";

  if (argv.includes("--check")) {
    const current = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== rendered) {
      console.error(`${rel(outFile)} is out of date: run \`pnpm proof\` and commit the result`);
      process.exit(1);
    }
    console.log(`${rel(outFile)} matches the data (${state}, ${input.txs.length} transactions)`);
    return;
  }
  writeFileSync(outFile, rendered);
  console.log(`wrote ${rel(outFile)} (${state}, ${input.txs.length} transactions)`);
}

// Run only as a script, so the parsers and the renderer can be imported.
const invoked = process.argv[1] && existsSync(process.argv[1]) ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`proof failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
