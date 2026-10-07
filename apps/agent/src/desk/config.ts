import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

/** Chains the desk runs on: BSC mainnet, BSC testnet (Studio trial only) and a local anvil fork of mainnet. */
export const DESK_CHAINS = { 56: "bsc", 97: "bsc-testnet", 31337: "bsc-fork" } as const;
export type DeskChainId = keyof typeof DESK_CHAINS;

const REDACTED = "[redacted]";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** A string that never prints itself: logs, JSON.stringify and util.inspect all see "[redacted]". */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export type SignerSource =
  | { kind: "private-key"; privateKey: Secret }
  | { kind: "keystore"; path: string; password: Secret };

export interface DeskConfig {
  readonly chainId: DeskChainId;
  /** RPC URLs often carry a provider key in the path, so the URL is a secret too. */
  readonly rpcUrl: Secret;
  readonly signer: SignerSource;
  /** Null means keyless: only the public Binance endpoints are used. */
  readonly binance: { apiKey: Secret; apiSecret: Secret } | null;
  readonly deploymentFile: string;
  /** Desk state (audit feed JSONL, cursors). Outside git; the default apps/agent/var/ is gitignored. */
  readonly dataDir: string;
  /** Per-symbol earnings schedule the operator maintains (config/earnings.json by default). */
  readonly earningsFile: string;
  /** Bind address and port of the Studio A2A/MCP faces (read by the Studio entrypoints). */
  readonly agentBindHost: string;
  readonly agentPort: number;
  /** Bind address and port of the desk read API; a reverse proxy fronts it. */
  readonly httpHost: string;
  readonly httpPort: number;
  readonly x402DailyCapUsd: number;
  readonly dryRun: boolean;
  /** One line that is safe to log. */
  describe(): string;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid desk config:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(blank, z.string().optional());

function numberVar(fallback?: number) {
  return z.preprocess(
    (v) => {
      const b = blank(v);
      return b === undefined ? fallback : Number(b);
    },
    z.number({ required_error: "is required", invalid_type_error: "must be a number" }),
  );
}

function portVar(fallback: number) {
  return numberVar(fallback).refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, "must be a port number");
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function hostVar(fallback: string) {
  return z.preprocess(
    (v) => blank(v) ?? fallback,
    z.string().refine((h) => isIP(h) !== 0 || HOSTNAME.test(h), "must be a host name or IP address, without scheme or port"),
  );
}

/** True for localhost, 127.0.0.0/8 and ::1 (also IPv4-mapped). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return isIP(v4) === 4 && v4.split(".")[0] === "127";
}

function flagVar(fallback: boolean) {
  return optionalText.transform((v, ctx) => {
    if (v === undefined) return fallback;
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
    return z.NEVER;
  });
}

// Messages below never echo the value: several of these variables are secrets.
const envSchema = z.object({
  CHAIN_ID: numberVar().refine((n): n is DeskChainId => n in DESK_CHAINS, "must be 56, 97 or 31337"),
  BSC_RPC_URL: z.preprocess(
    blank,
    z.string({ required_error: "is required" }).superRefine((raw, ctx) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a URL" });
        return;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an http(s) URL" });
      }
    }),
  ),
  AGENT_PRIVATE_KEY: optionalText.refine(
    (v) => v === undefined || /^0x[0-9a-fA-F]{64}$/.test(v),
    "must be 0x followed by 64 hex characters",
  ),
  AGENT_KEYSTORE_PATH: optionalText,
  AGENT_KEYSTORE_PASSWORD: optionalText,
  // Studio keeps the keystore password under this name in .studio/.env.local.
  WALLET_PASSWORD: optionalText,
  BINANCE_WEB3_API_KEY: optionalText,
  BINANCE_WEB3_API_SECRET: optionalText,
  DEPLOYMENT_FILE: optionalText,
  DATA_DIR: optionalText,
  EARNINGS_FILE: optionalText,
  AGENT_BIND_HOST: hostVar("127.0.0.1"),
  AGENT_PORT: portVar(9000),
  HTTP_HOST: hostVar("127.0.0.1"),
  HTTP_PORT: portVar(8787),
  X402_DAILY_CAP_USD: numberVar(0.5).refine((n) => Number.isFinite(n) && n >= 0, "must be a non-negative amount"),
  DRY_RUN: flagVar(true),
});

type Env = z.infer<typeof envSchema>;

function resolveSigner(e: Env, cwd: string, issues: string[]): SignerSource | null {
  const keystorePassword = e.AGENT_KEYSTORE_PASSWORD ?? e.WALLET_PASSWORD;
  if (e.AGENT_PRIVATE_KEY && e.AGENT_KEYSTORE_PATH) {
    issues.push("signer: set AGENT_PRIVATE_KEY or AGENT_KEYSTORE_PATH, not both");
    return null;
  }
  if (e.AGENT_PRIVATE_KEY) {
    if (e.AGENT_KEYSTORE_PASSWORD) issues.push("AGENT_KEYSTORE_PASSWORD: set without AGENT_KEYSTORE_PATH");
    try {
      privateKeyToAccount(e.AGENT_PRIVATE_KEY as Hex);
    } catch {
      issues.push("AGENT_PRIVATE_KEY: not a valid secp256k1 private key");
      return null;
    }
    return { kind: "private-key", privateKey: new Secret(e.AGENT_PRIVATE_KEY) };
  }
  if (e.AGENT_KEYSTORE_PATH) {
    if (!keystorePassword) {
      issues.push("AGENT_KEYSTORE_PASSWORD: is required with AGENT_KEYSTORE_PATH");
      return null;
    }
    return { kind: "keystore", path: path.resolve(cwd, e.AGENT_KEYSTORE_PATH), password: new Secret(keystorePassword) };
  }
  if (e.AGENT_KEYSTORE_PASSWORD) issues.push("AGENT_KEYSTORE_PASSWORD: set without AGENT_KEYSTORE_PATH");
  issues.push("signer: AGENT_PRIVATE_KEY or AGENT_KEYSTORE_PATH with AGENT_KEYSTORE_PASSWORD is required");
  return null;
}

function resolveBinance(e: Env, issues: string[]): DeskConfig["binance"] {
  const key = e.BINANCE_WEB3_API_KEY;
  const secret = e.BINANCE_WEB3_API_SECRET;
  if (!key && !secret) return null;
  if (!key || !secret) {
    issues.push("binance: BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET must be set together");
    return null;
  }
  return { apiKey: new Secret(key), apiSecret: new Secret(secret) };
}

/** Scheme and host only: no credentials, path or query, where provider keys usually live. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hidden = u.pathname.replace(/\/+$/, "") !== "" || u.search !== "" ? "/[redacted]" : "";
    return `${u.protocol}//${u.host}${hidden}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Reads and validates the desk environment. Throws ConfigError listing every problem found.
 * Secrets are wrapped in Secret; call reveal() only where the value is handed to a client.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, opts: { cwd?: string } = {}): DeskConfig {
  const cwd = opts.cwd ?? process.cwd();
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];
  const signer = resolveSigner(e, cwd, issues);
  const binance = resolveBinance(e, issues);
  // The Studio faces carry no inbound auth when self-hosted: on mainnet they stay on loopback.
  if (e.CHAIN_ID === 56 && !isLoopbackHost(e.AGENT_BIND_HOST)) {
    issues.push("AGENT_BIND_HOST: must be a loopback address on BSC mainnet (the A2A/MCP faces have no auth)");
  }
  if (e.AGENT_PORT === e.HTTP_PORT) issues.push("AGENT_PORT: must differ from HTTP_PORT");
  if (issues.length > 0 || signer === null) throw new ConfigError(issues);

  const chainId = e.CHAIN_ID;
  const deploymentFile = e.DEPLOYMENT_FILE
    ? path.resolve(cwd, e.DEPLOYMENT_FILE)
    : path.join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
  const dataDir = e.DATA_DIR ? path.resolve(cwd, e.DATA_DIR) : path.join(REPO_ROOT, "apps", "agent", "var");
  const earningsFile = e.EARNINGS_FILE ? path.resolve(cwd, e.EARNINGS_FILE) : path.join(REPO_ROOT, "config", "earnings.json");

  const summary = [
    `chain=${chainId} (${DESK_CHAINS[chainId]})`,
    `rpc=${redactUrl(e.BSC_RPC_URL)}`,
    `signer=${signer.kind === "keystore" ? `keystore ${signer.path}` : "private key"}`,
    `binance=${binance ? "keyed" : "keyless"}`,
    `deployment=${deploymentFile}`,
    `data=${dataDir}`,
    `agent=${e.AGENT_BIND_HOST}:${e.AGENT_PORT}`,
    `http=${e.HTTP_HOST}:${e.HTTP_PORT}`,
    `x402Cap=$${e.X402_DAILY_CAP_USD}/day`,
    `dryRun=${e.DRY_RUN}`,
  ].join(" ");

  return Object.freeze({
    chainId,
    rpcUrl: new Secret(e.BSC_RPC_URL),
    signer: Object.freeze(signer),
    binance: binance && Object.freeze(binance),
    deploymentFile,
    dataDir,
    earningsFile,
    agentBindHost: e.AGENT_BIND_HOST,
    agentPort: e.AGENT_PORT,
    httpHost: e.HTTP_HOST,
    httpPort: e.HTTP_PORT,
    x402DailyCapUsd: e.X402_DAILY_CAP_USD,
    dryRun: e.DRY_RUN,
    describe: () => summary,
    toString: () => summary,
  });
}

/**
 * Environment the Studio entrypoints (app/agent/src/dualMain.ts, mcpMain.ts) read for their
 * listener. The desk process assigns it to process.env before it builds the Studio app.
 */
export function studioEnv(config: Pick<DeskConfig, "agentBindHost" | "agentPort">): { AGENT_BIND_HOST: string; AGENT_PORT: string } {
  return { AGENT_BIND_HOST: config.agentBindHost, AGENT_PORT: String(config.agentPort) };
}
