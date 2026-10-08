/* Which Ballast deployment the app talks to. In order: DEPLOYMENT_JSON (the file's contents inline),
   DEPLOYMENT_FILE (a path), then contracts/deployments/<chainId>.json in the repository. A missing or broken
   deployment is a state the app shows ("contracts not deployed yet"), never a crash. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDeployment, type Deployment } from "@ballast/sdk";
import type { AppChainId, DeploymentInfo, DeploymentJson } from "@/lib/app-config";

export type DeploymentStatus =
  | { ok: true; chainId: AppChainId; deployment: Deployment; source: string }
  | { ok: false; chainId: AppChainId; reason: "missing" | "invalid"; detail: string };

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  chainId: AppChainId;
  readFile?: (file: string) => string;
  /** Repository root; default two levels above the app directory. */
  repoRoot?: string;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

export function resolveDeployment(o: ResolveOptions): DeploymentStatus {
  const env = o.env ?? process.env;
  const read = o.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  const root = o.repoRoot ?? path.resolve(process.cwd(), "..", "..");
  const chainId = o.chainId;

  let raw: string;
  let source: string;
  const inline = env.DEPLOYMENT_JSON?.trim();
  if (inline) {
    raw = inline;
    source = "DEPLOYMENT_JSON";
  } else {
    const fromEnv = env.DEPLOYMENT_FILE?.trim();
    const file = fromEnv ? path.resolve(root, fromEnv) : path.join(root, "contracts", "deployments", `${chainId}.json`);
    source = fromEnv ? "DEPLOYMENT_FILE" : `contracts/deployments/${chainId}.json`;
    try {
      raw = read(file);
    } catch (err) {
      if (isMissing(err)) {
        return { ok: false, chainId, reason: "missing", detail: `no deployment file for chain ${chainId} (${source})` };
      }
      return { ok: false, chainId, reason: "invalid", detail: `${source} could not be read` };
    }
  }
  try {
    return { ok: true, chainId, deployment: parseDeployment(chainId, JSON.parse(raw)), source };
  } catch (err) {
    return { ok: false, chainId, reason: "invalid", detail: `${source}: ${(err as Error).message}` };
  }
}

export function deploymentJson(d: Deployment): DeploymentJson {
  return {
    chainId: d.chainId,
    calendar: d.calendar,
    sessionOracle: d.sessionOracle,
    sessionAwareFeed: d.sessionAwareFeed,
    factory: d.factory,
    listaImpl: d.listaImpl,
    venusImpl: d.venusImpl,
    cushionVault: d.cushionVault,
    guardian: d.guardian,
    owner: d.owner,
    block: d.block,
    ...(d.guardianStartJobId !== undefined ? { guardianStartJobId: d.guardianStartJobId.toString() } : {}),
  };
}

export function deploymentInfo(s: DeploymentStatus): DeploymentInfo {
  return s.ok ? { status: "ok", json: deploymentJson(s.deployment), source: s.source } : { status: s.reason, detail: s.detail };
}
