/* The recorded cycle /judge plays back (public/replay/cycle.json, written by scripts/demo/record-replay.ts) and
   the BNB Chain transactions that match its steps (data/proof-txs.json, when present). Both are checked before
   use: a malformed recording is refused instead of being half shown. Pure and client-safe. */

export type StepKind = "setup" | "publish" | "open" | "job" | "shield" | "refused" | "restore" | "settle";
const KINDS: readonly StepKind[] = ["setup", "publish", "open", "job", "shield", "refused", "restore", "settle"];

export interface ReplayTx {
  label: string;
  call: string;
  hash: string;
  status: "success" | "reverted";
  from: string;
  to: string;
  block: number;
  gasUsed: string;
}

export interface ReplayState {
  at: number;
  session: string;
  canAddRisk: boolean;
  reason: string;
  window: { ahead: string; aheadGapBps: number; current: string; currentGapBps: number };
  bandBps: number | null;
  account: null | { address: string; ltvBps: number | null; collateral: string; debt: string; cushion: string; healthy: boolean; liquidated: boolean; hfAfterGap: number | null };
  job: null | { id: string; status: string; settled: boolean };
}

export interface ReplayStep {
  id: string;
  kind: StepKind;
  title: string;
  summary: string;
  /** unix seconds, the fork's block time */
  at: number;
  txs: ReplayTx[];
  result: Record<string, string | number | boolean | null>;
  error?: { name: string; reason?: string; message: string };
  state: ReplayState;
  reproduce: { test?: string; command: string };
  proofKeys: string[];
  forkOnly?: string[];
}

export interface Replay {
  version: 1;
  recordedAt: string;
  fork: { of: string; chainId: number; block: number; blockTime: number; localChainId: number };
  deployment: { source: string; sessionOracle: string; sessionAwareFeed: string; factory: string; cushionVault: string; guardian: string; calendar: string };
  actors: { borrower: string; desk: string; agentId: string };
  market: { label: string; symbol: string; lltvBps: number };
  forkOnly: string[];
  steps: ReplayStep[];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new Error(`replay: ${what} is missing`);
  return v;
};
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`replay: ${what} is not a number`);
  return v;
};

function parseTx(v: unknown, where: string): ReplayTx {
  if (!isObj(v)) throw new Error(`replay: ${where} is not a transaction`);
  const hash = str(v.hash, `${where} hash`);
  if (!HASH.test(hash)) throw new Error(`replay: ${where} has a malformed hash`);
  if (v.status !== "success" && v.status !== "reverted") throw new Error(`replay: ${where} has no status`);
  const from = str(v.from, `${where} sender`);
  const to = str(v.to, `${where} target`);
  if (!ADDRESS.test(from) || !ADDRESS.test(to)) throw new Error(`replay: ${where} has a malformed address`);
  return { label: str(v.label, `${where} label`), call: str(v.call, `${where} call`), hash, status: v.status, from, to, block: int(v.block, `${where} block`), gasUsed: String(v.gasUsed ?? "") };
}

function parseState(v: unknown, where: string): ReplayState {
  if (!isObj(v) || !isObj(v.window)) throw new Error(`replay: ${where} has no state`);
  const a = v.account;
  const j = v.job;
  return {
    at: int(v.at, `${where} state time`),
    session: str(v.session, `${where} session`),
    canAddRisk: v.canAddRisk === true,
    reason: str(v.reason, `${where} reason`),
    window: { ahead: String(v.window.ahead ?? "NONE"), aheadGapBps: Number(v.window.aheadGapBps ?? 0), current: String(v.window.current ?? "NONE"), currentGapBps: Number(v.window.currentGapBps ?? 0) },
    bandBps: typeof v.bandBps === "number" ? v.bandBps : null,
    account: isObj(a)
      ? {
          address: str(a.address, `${where} account`),
          ltvBps: typeof a.ltvBps === "number" ? a.ltvBps : null,
          collateral: String(a.collateral ?? ""),
          debt: String(a.debt ?? ""),
          cushion: String(a.cushion ?? ""),
          healthy: a.healthy === true,
          liquidated: a.liquidated === true,
          hfAfterGap: typeof a.hfAfterGap === "number" ? a.hfAfterGap : null,
        }
      : null,
    job: isObj(j) ? { id: str(j.id, `${where} job`), status: str(j.status, `${where} job status`), settled: j.settled === true } : null,
  };
}

function parseStep(v: unknown, i: number): ReplayStep {
  const where = `step ${i + 1}`;
  if (!isObj(v)) throw new Error(`replay: ${where} is not an object`);
  if (!KINDS.includes(v.kind as StepKind)) throw new Error(`replay: ${where} has an unknown kind`);
  if (!Array.isArray(v.txs)) throw new Error(`replay: ${where} has no transaction list`);
  if (!isObj(v.reproduce)) throw new Error(`replay: ${where} does not say how to reproduce it`);
  const result: ReplayStep["result"] = {};
  if (isObj(v.result)) {
    for (const [k, x] of Object.entries(v.result)) if (x === null || ["string", "number", "boolean"].includes(typeof x)) result[k] = x as string | number | boolean | null;
  }
  const e = v.error;
  const step: ReplayStep = {
    id: str(v.id, `${where} id`),
    kind: v.kind as StepKind,
    title: str(v.title, `${where} title`),
    summary: str(v.summary, `${where} summary`),
    at: int(v.at, `${where} time`),
    txs: v.txs.map((t, k) => parseTx(t, `${where} transaction ${k + 1}`)),
    result,
    state: parseState(v.state, where),
    reproduce: { command: str(v.reproduce.command, `${where} reproduce command`), ...(typeof v.reproduce.test === "string" ? { test: v.reproduce.test } : {}) },
    proofKeys: Array.isArray(v.proofKeys) ? v.proofKeys.filter((k): k is string => typeof k === "string") : [],
  };
  if (isObj(e)) step.error = { name: str(e.name, `${where} error name`), message: str(e.message, `${where} error message`), ...(typeof e.reason === "string" ? { reason: e.reason } : {}) };
  if (Array.isArray(v.forkOnly)) step.forkOnly = v.forkOnly.filter((x): x is string => typeof x === "string");
  // a refusal must carry its revert, and a reverted transaction must be a refusal
  if (step.kind === "refused" && (!step.error || !step.txs.some((t) => t.status === "reverted"))) throw new Error(`replay: ${where} is a refusal without a reverted transaction and its error`);
  if (step.kind !== "refused" && step.txs.some((t) => t.status === "reverted")) throw new Error(`replay: ${where} carries a reverted transaction but is not a refusal`);
  return step;
}

/** Checks a recording and returns it typed. Throws with the reason when it is not one. */
export function parseReplay(json: unknown): Replay {
  if (!isObj(json)) throw new Error("replay: not an object");
  if (json.version !== 1) throw new Error("replay: unknown version");
  const { fork, deployment, actors, market } = json;
  if (!isObj(fork) || !isObj(deployment) || !isObj(actors) || !isObj(market)) throw new Error("replay: header is incomplete");
  if (!Array.isArray(json.steps) || json.steps.length === 0) throw new Error("replay: no steps");
  const steps = json.steps.map(parseStep);
  for (let i = 1; i < steps.length; i++) if (steps[i]!.at < steps[i - 1]!.at) throw new Error(`replay: step ${i + 1} is earlier than the step before it`);
  if (new Set(steps.map((s) => s.id)).size !== steps.length) throw new Error("replay: step ids repeat");
  const addr = (v: unknown, what: string) => {
    const a = str(v, what);
    if (!ADDRESS.test(a)) throw new Error(`replay: ${what} is not an address`);
    return a;
  };
  return {
    version: 1,
    recordedAt: str(json.recordedAt, "recording time"),
    fork: { of: str(fork.of, "forked chain"), chainId: int(fork.chainId, "forked chain id"), block: int(fork.block, "fork block"), blockTime: int(fork.blockTime, "fork block time"), localChainId: int(fork.localChainId, "local chain id") },
    deployment: {
      source: str(deployment.source, "deployment source"),
      sessionOracle: addr(deployment.sessionOracle, "Session Oracle"),
      sessionAwareFeed: addr(deployment.sessionAwareFeed, "feed"),
      factory: addr(deployment.factory, "factory"),
      cushionVault: addr(deployment.cushionVault, "cushion vault"),
      guardian: addr(deployment.guardian, "guardian"),
      calendar: addr(deployment.calendar, "calendar"),
    },
    actors: { borrower: addr(actors.borrower, "borrower"), desk: addr(actors.desk, "desk"), agentId: str(actors.agentId, "agent id") },
    market: { label: str(market.label, "market"), symbol: str(market.symbol, "symbol"), lltvBps: int(market.lltvBps, "liquidation LTV") },
    forkOnly: Array.isArray(json.forkOnly) ? json.forkOnly.filter((x): x is string => typeof x === "string") : [],
    steps,
  };
}

// ----------------------------------------------------------------- mainnet proof

export interface ProofTx {
  tx: string;
  label?: string;
}

export type Proofs = Record<string, ProofTx[]>;

function proofEntry(v: unknown): ProofTx | null {
  if (typeof v === "string") return HASH.test(v) ? { tx: v } : null;
  if (!isObj(v)) return null;
  const tx = [v.tx, v.hash, v.txHash].find((x): x is string => typeof x === "string" && HASH.test(x));
  if (!tx) return null;
  const label = [v.label, v.note, v.what].find((x): x is string => typeof x === "string" && x.length > 0);
  return label ? { tx, label: label.slice(0, 160) } : { tx };
}

/**
 * BNB Chain transactions by step key. Accepts a map of key to hash, object or list of either (optionally under
 * "txs"), or a list of { key, tx } rows. Anything that is not a transaction hash is dropped; a missing or
 * unreadable file is an empty map, so a step without a transaction simply says it has none yet.
 */
export function parseProofs(json: unknown): Proofs {
  const out: Proofs = {};
  const add = (key: string, v: unknown) => {
    for (const x of Array.isArray(v) ? v : [v]) {
      const p = proofEntry(x);
      if (p && !(out[key] ?? []).some((y) => y.tx.toLowerCase() === p.tx.toLowerCase())) (out[key] ??= []).push(p);
    }
  };
  const body = isObj(json) && (isObj(json.txs) || Array.isArray(json.txs)) ? json.txs : json;
  if (Array.isArray(body)) {
    for (const row of body) {
      if (!isObj(row)) continue;
      const key = [row.key, row.step, row.id, row.kind].find((x): x is string => typeof x === "string" && x.length > 0);
      if (key) add(key, row);
    }
  } else if (isObj(body)) {
    for (const [key, v] of Object.entries(body)) add(key, v);
  }
  return out;
}

/** The BNB Chain transactions recorded for a step, in the order of its proof keys. */
export const proofsFor = (step: Pick<ReplayStep, "proofKeys">, proofs: Proofs): ProofTx[] => step.proofKeys.flatMap((k) => proofs[k] ?? []);

/** The closure a recording crosses: from its shield to its restore (falls back to the whole recording). */
export function replaySpan(r: Replay): { from: number; to: number } {
  return { from: r.steps[0]!.at, to: r.steps[r.steps.length - 1]!.at };
}
