/* GET /api/guardians: the guardian board. Jobs are found by walking the ERC-8183 kernel's job ids forward from
   the id recorded at deployment (guardianStartJobId) with the SDK's cursor: at most LIMITS.jobScan ids per
   answer, never a range a caller supplies. The cursor and the jobs found so far live on the server, so a busy
   kernel costs each answer the same bounded number of reads; jobs still in flight are refreshed, a bounded
   number of them. The desk's ERC-8004 identity and reputation are read from the registries and work before
   Ballast is deployed. Cached 20 s with one read in flight. */
import { ballastGuardianAbi, guardianJobs, kernelAbi, readGuardianJobs, type Deployment, type GuardianJob, type ReadClient } from "@ballast/sdk";
import { getAddress, parseAbi } from "viem";
import type { GuardiansBody, JobView, ReputationView } from "@/lib/guardians";
import { DESK_AGENT_ID, GUARD_TAGS, REPUTATION_REGISTRY, type IdentityView } from "@/lib/identity";
import { tokenSymbol } from "@/lib/markets";
import { ttlCache } from "../cache";
import type { DeploymentStatus } from "../deployment";
import { BusyError, readGate, withDeadline } from "../guard";
import { LIMITS } from "../limits";
import { shortMessage } from "../simulate";
import { readIdentity } from "./oracle";

export const GUARDIANS_TTL_MS = 20_000;
/** jobs kept per deployment; the oldest are dropped first */
export const MAX_JOBS = 200;
/** unsettled jobs re-read per answer */
export const MAX_REFRESH = 50;

const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

/** What the reputation registry holds for the desk: who rated it, and the guardian's own entries once deployed. */
export async function readReputation(c: ReadClient, agentId: bigint, guardian: string | null, blockNumber?: bigint): Promise<ReputationView> {
  const at = { address: REPUTATION_REGISTRY, abi: reputationAbi, blockNumber } as const;
  try {
    const clients = await c.readContract({ ...at, functionName: "getClients", args: [agentId] });
    if (!guardian) return { clients: clients.length, guard: null };
    const [count, value, decimals] = await c.readContract({ ...at, functionName: "getSummary", args: [agentId, [getAddress(guardian)], GUARD_TAGS.tag1, GUARD_TAGS.tag2] });
    return { clients: clients.length, guard: count > 0n ? { count: Number(count), average: Number(value) / 10 ** decimals } : null };
  } catch (err) {
    return { clients: null, guard: null, error: `the reputation registry could not be read: ${shortMessage(err)}` };
  }
}

interface Scan {
  from: bigint;
  cursor: bigint;
  head: bigint;
  jobs: Map<string, GuardianJob>;
  tokens: Map<string, string | null>;
}

const scans = new Map<string, Scan>();
const FINAL = new Set(["Completed", "Rejected", "Expired"]);

/** Forgets every scan (tests). */
export function resetGuardianScans() {
  scans.clear();
}

function view(j: GuardianJob, token: string | null): JobView {
  const symbol = token ? tokenSymbol(token) : null;
  return {
    id: j.jobId.toString(),
    client: j.client,
    provider: j.provider,
    description: j.description.slice(0, 280),
    budget: j.budget.toString(),
    token,
    tokenSymbol: symbol,
    // the stablecoins this app knows all carry 18 decimals on BNB Chain
    tokenDecimals: symbol ? 18 : null,
    status: j.status,
    expiredAt: j.expiredAt,
    submittedAt: j.submittedAt,
    deliverable: j.deliverable,
    terms: j.terms ? { account: j.terms.account, start: j.terms.start, end: j.terms.end, agentId: j.terms.agentId.toString(), settled: j.terms.settled } : null,
  };
}

export async function readGuardians(c: ReadClient, s: Extract<DeploymentStatus, { ok: true }>): Promise<GuardiansBody> {
  const d: Deployment = s.deployment;
  const key = `${s.chainId}|${d.guardian}`;
  const start = d.guardianStartJobId ?? 0n;
  const scan = scans.get(key) ?? { from: start, cursor: start, head: start, jobs: new Map(), tokens: new Map() };
  const block = await c.getBlock({ blockTag: "latest" });
  const blockNumber = block.number as bigint;

  // one bounded page forward, and the jobs that can still change
  const pending = [...scan.jobs.values()].filter((j) => !FINAL.has(j.status)).slice(-MAX_REFRESH);
  const [page, refreshed] = await Promise.all([
    guardianJobs(c, d, { fromJobId: scan.cursor, limit: LIMITS.jobScan, blockNumber }),
    readGuardianJobs(c, d, pending.map((j) => j.jobId), { blockNumber }),
  ]);
  for (const j of [...refreshed, ...page.jobs]) scan.jobs.set(j.jobId.toString(), j);
  while (scan.jobs.size > MAX_JOBS) scan.jobs.delete(scan.jobs.keys().next().value as string);
  scan.cursor = page.nextCursor;
  scan.head = page.head;
  scans.set(key, scan);

  const need = [...scan.jobs.values()].filter((j) => !scan.tokens.has(j.jobId.toString()));
  const [tokens, minBudget, identity, reputation] = await Promise.all([
    Promise.all(need.map((j) => c.readContract({ address: d.external.kernel, abi: kernelAbi, blockNumber, functionName: "jobPaymentToken", args: [j.jobId] }).then(getAddress, () => null))),
    c.readContract({ address: d.guardian, abi: ballastGuardianAbi, blockNumber, functionName: "minBudget" }).then(
      (x) => x.toString(),
      () => null,
    ),
    readIdentity(c, d, DESK_AGENT_ID, blockNumber),
    readReputation(c, DESK_AGENT_ID, d.guardian, blockNumber),
  ]);
  need.forEach((j, i) => {
    // an unread token is asked for again next time
    if (tokens[i] !== null) scan.tokens.set(j.jobId.toString(), tokens[i]!);
  });

  const jobs = [...scan.jobs.values()].sort((a, b) => (a.jobId < b.jobId ? 1 : -1)).map((j) => view(j, scan.tokens.get(j.jobId.toString()) ?? null));
  return {
    status: "ok",
    chainId: s.chainId,
    blockNumber: blockNumber.toString(),
    at: Number(block.timestamp),
    guardian: d.guardian,
    kernel: d.external.kernel,
    minBudget,
    scan: { from: scan.from.toString(), cursor: scan.cursor.toString(), head: scan.head.toString(), complete: scan.cursor >= scan.head },
    jobs,
    identity,
    reputation,
  };
}

/** Before the deployment: the identity and its reputation only. */
async function readIdentityOnly(c: ReadClient, external: Deployment["external"]): Promise<{ identity: IdentityView; reputation: ReputationView }> {
  const [identity, reputation] = await Promise.all([readIdentity(c, { external }, DESK_AGENT_ID), readReputation(c, DESK_AGENT_ID, null)]);
  return { identity, reputation };
}

const cache = ttlCache<GuardiansBody>(GUARDIANS_TTL_MS, { errorTtlMs: 5_000, replayError: (err) => !(err instanceof BusyError), max: 8 });

export async function handleGuardians(s: DeploymentStatus, c: ReadClient, external: Deployment["external"]): Promise<Response> {
  let body: GuardiansBody;
  try {
    body = await cache.get(s.ok ? `${s.chainId}|${s.deployment.guardian}` : `${s.chainId}|-`, () =>
      readGate.run(() => withDeadline(s.ok ? readGuardians(c, s) : readIdentityOnly(c, external).then((x): GuardiansBody => ({ status: "not-deployed", detail: s.detail, ...x })))),
    );
  } catch (err) {
    if (err instanceof BusyError) return Response.json({ error: err.message }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } });
    body = s.ok ? { status: "unavailable", detail: `chain read failed: ${shortMessage(err)}` } : { status: "not-deployed", detail: s.detail };
  }
  const settled = body.status === "ok" && body.scan.complete;
  return Response.json(body, { headers: { "cache-control": settled ? "public, s-maxage=15, stale-while-revalidate=30" : "no-store" } });
}
