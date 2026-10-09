/* Checks the configuration once when the server starts and refuses to start on a malformed value, with one
   line per problem. A deployment that is simply not there yet is not a problem: the app says so on the page. */
import { asAppChainId } from "@/lib/app-config";
import { resolveDeployment } from "./deployment";
import { describeEnv, envProblems } from "./env";

type Env = Record<string, string | undefined>;

export function startupProblems(env: Env = process.env, readFile?: (file: string) => string): string[] {
  const problems = envProblems(env);
  const chain = (env.NEXT_PUBLIC_CHAIN_ID ?? env.CHAIN_ID)?.trim();
  if (chain === undefined || chain === "" || chain === "56" || chain === "31337") {
    const s = resolveDeployment({ chainId: asAppChainId(chain), env, ...(readFile ? { readFile } : {}) });
    const named = !!env.DEPLOYMENT_JSON?.trim() || !!env.DEPLOYMENT_FILE?.trim();
    // a named deployment must exist and be valid; the repository file may be absent, but not broken
    if (!s.ok && (s.reason === "invalid" || named)) problems.push(`deployment: ${s.detail}`);
  }
  return problems;
}

export class StartupError extends Error {
  constructor(readonly problems: string[]) {
    super(`Ballast web cannot start, the configuration is invalid:\n  ${problems.join("\n  ")}`);
    this.name = "StartupError";
  }
}

export function assertStartup(env: Env = process.env, log: (line: string) => void = console.log): void {
  const problems = startupProblems(env);
  if (problems.length > 0) throw new StartupError(problems);
  log(`ballast web config: ${describeEnv(env)}`);
}
