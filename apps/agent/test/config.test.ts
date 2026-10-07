import path from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, deskSecrets, isLoopbackHost, loadConfig, redactUrl, studioEnv } from "../src/desk/config";

const PK = `0x${"4f".repeat(32)}`;
const RPC = "https://bsc-mainnet.example.org/v1/rpc-key-0123456789abcdef";
const base = { CHAIN_ID: "56", BSC_RPC_URL: RPC, AGENT_PRIVATE_KEY: PK };

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).issues;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("parses a valid env and applies the defaults", () => {
    const c = loadConfig(base);
    expect(c.chainId).toBe(56);
    expect(c.rpcUrl.reveal()).toBe(RPC);
    expect(c.signer.kind).toBe("private-key");
    expect(c.signer.kind === "private-key" && c.signer.privateKey.reveal()).toBe(PK);
    expect(c.binance).toBeNull();
    expect(c.agentBindHost).toBe("127.0.0.1");
    expect(c.agentPort).toBe(9000);
    expect(c.httpHost).toBe("127.0.0.1");
    expect(c.httpPort).toBe(8787);
    expect(c.x402DailyCapUsd).toBe(0.5);
    expect(c.minBnbBalance).toBe(0.003);
    expect(c.dryRun).toBe(true);
    expect(c.deploymentFile.endsWith(path.join("contracts", "deployments", "56.json"))).toBe(true);
    expect(c.dataDir.endsWith(path.join("apps", "agent", "var"))).toBe(true);
    expect(c.earningsFile.endsWith(path.join("config", "earnings.json"))).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("takes explicit values over the defaults", () => {
    const cwd = path.resolve("/srv/ballast");
    const c = loadConfig(
      {
        ...base,
        CHAIN_ID: "31337",
        HTTP_PORT: "9100",
        X402_DAILY_CAP_USD: "0.25",
        MIN_BNB_BALANCE: "0.01",
        DRY_RUN: "false",
        DEPLOYMENT_FILE: "deploy/fork.json",
        DATA_DIR: "state",
        EARNINGS_FILE: "/etc/ballast/earnings.json",
        BINANCE_WEB3_API_KEY: "binance-key",
        BINANCE_WEB3_API_SECRET: "binance-secret",
      },
      { cwd },
    );
    expect(c.chainId).toBe(31337);
    expect(c.httpPort).toBe(9100);
    expect(c.x402DailyCapUsd).toBe(0.25);
    expect(c.minBnbBalance).toBe(0.01);
    expect(c.dryRun).toBe(false);
    expect(c.deploymentFile).toBe(path.join(cwd, "deploy", "fork.json"));
    expect(c.dataDir).toBe(path.join(cwd, "state"));
    expect(c.earningsFile).toBe(path.resolve("/etc/ballast/earnings.json"));
    expect(c.binance?.apiKey.reveal()).toBe("binance-key");
    expect(c.binance?.apiSecret.reveal()).toBe("binance-secret");
  });

  it("treats blank values as unset", () => {
    const c = loadConfig({ ...base, DRY_RUN: "", HTTP_PORT: " ", BINANCE_WEB3_API_KEY: "", BINANCE_WEB3_API_SECRET: "" });
    expect(c.dryRun).toBe(true);
    expect(c.httpPort).toBe(8787);
    expect(c.binance).toBeNull();
  });

  it("accepts a keystore with its password, falling back to the Studio WALLET_PASSWORD", () => {
    const cwd = path.resolve("/srv/ballast");
    const own = loadConfig(
      { CHAIN_ID: "56", BSC_RPC_URL: RPC, AGENT_KEYSTORE_PATH: ".studio/wallets/desk.json", AGENT_KEYSTORE_PASSWORD: "pw-1" },
      { cwd },
    );
    expect(own.signer).toMatchObject({ kind: "keystore", path: path.join(cwd, ".studio", "wallets", "desk.json") });
    expect(own.signer.kind === "keystore" && own.signer.password.reveal()).toBe("pw-1");

    const studio = loadConfig({ CHAIN_ID: "56", BSC_RPC_URL: RPC, AGENT_KEYSTORE_PATH: "/k.json", WALLET_PASSWORD: "pw-2" });
    expect(studio.signer.kind === "keystore" && studio.signer.password.reveal()).toBe("pw-2");
  });

  it("refuses to start without a signing key", () => {
    expect(issuesOf({ CHAIN_ID: "56", BSC_RPC_URL: RPC })).toEqual([
      "signer: AGENT_PRIVATE_KEY or AGENT_KEYSTORE_PATH with AGENT_KEYSTORE_PASSWORD is required",
    ]);
  });

  it("reports every missing required variable at once", () => {
    const issues = issuesOf({ AGENT_PRIVATE_KEY: PK });
    expect(issues).toContain("CHAIN_ID: is required");
    expect(issues).toContain("BSC_RPC_URL: is required");
  });

  it("rejects ambiguous or incomplete signer settings", () => {
    expect(issuesOf({ ...base, AGENT_KEYSTORE_PATH: "/k.json", AGENT_KEYSTORE_PASSWORD: "pw" })).toEqual([
      "signer: set AGENT_PRIVATE_KEY or AGENT_KEYSTORE_PATH, not both",
    ]);
    expect(issuesOf({ CHAIN_ID: "56", BSC_RPC_URL: RPC, AGENT_KEYSTORE_PATH: "/k.json" })).toEqual([
      "AGENT_KEYSTORE_PASSWORD: is required with AGENT_KEYSTORE_PATH",
    ]);
    expect(issuesOf({ ...base, AGENT_KEYSTORE_PASSWORD: "pw" })).toEqual([
      "AGENT_KEYSTORE_PASSWORD: set without AGENT_KEYSTORE_PATH",
    ]);
  });

  it("rejects malformed values without echoing them", () => {
    const badKey = `0x${"zz".repeat(32)}`;
    const zeroKey = `0x${"00".repeat(32)}`;
    const malformed = issuesOf({ ...base, AGENT_PRIVATE_KEY: badKey });
    expect(malformed).toEqual(["AGENT_PRIVATE_KEY: must be 0x followed by 64 hex characters"]);
    const outOfRange = issuesOf({ ...base, AGENT_PRIVATE_KEY: zeroKey });
    expect(outOfRange).toEqual(["AGENT_PRIVATE_KEY: not a valid secp256k1 private key"]);
    expect(issuesOf({ ...base, BSC_RPC_URL: "not a url/with-key-abc" })).toEqual(["BSC_RPC_URL: must be a URL"]);
    for (const msg of [...malformed, ...outOfRange]) {
      expect(msg).not.toContain("zz".repeat(8));
      expect(msg).not.toContain("00".repeat(8));
    }
  });

  it("rejects unsupported chains, bad numbers and bad flags", () => {
    expect(issuesOf({ ...base, CHAIN_ID: "1" })).toEqual(["CHAIN_ID: must be 56, 97 or 31337"]);
    expect(issuesOf({ ...base, CHAIN_ID: "bsc" })).toEqual(["CHAIN_ID: must be a number"]);
    expect(issuesOf({ ...base, BSC_RPC_URL: "wss://bsc.example.org" })).toEqual(["BSC_RPC_URL: must be an http(s) URL"]);
    expect(issuesOf({ ...base, HTTP_PORT: "70000" })).toEqual(["HTTP_PORT: must be a port number"]);
    expect(issuesOf({ ...base, X402_DAILY_CAP_USD: "-1" })).toEqual(["X402_DAILY_CAP_USD: must be a non-negative amount"]);
    expect(issuesOf({ ...base, DRY_RUN: "maybe" })).toEqual(["DRY_RUN: must be true or false"]);
  });

  it("keeps the Studio faces on loopback on mainnet", () => {
    expect(issuesOf({ ...base, AGENT_BIND_HOST: "0.0.0.0" })).toEqual([
      "AGENT_BIND_HOST: must be a loopback address on BSC mainnet (the A2A/MCP faces have no auth)",
    ]);
    expect(issuesOf({ ...base, AGENT_BIND_HOST: "203.0.113.7" })).toHaveLength(1);
    expect(issuesOf({ ...base, AGENT_BIND_HOST: "::" })).toHaveLength(1);
    expect(loadConfig({ ...base, AGENT_BIND_HOST: "localhost" }).agentBindHost).toBe("localhost");
    expect(loadConfig({ ...base, AGENT_BIND_HOST: "::1" }).agentBindHost).toBe("::1");
    // Off mainnet (fork, testnet trial) a public bind is the operator's call.
    expect(loadConfig({ ...base, CHAIN_ID: "31337", AGENT_BIND_HOST: "0.0.0.0" }).agentBindHost).toBe("0.0.0.0");
    expect(loadConfig({ ...base, CHAIN_ID: "97", AGENT_BIND_HOST: "0.0.0.0" }).agentBindHost).toBe("0.0.0.0");
  });

  it("takes bind addresses and ports for both listeners", () => {
    const c = loadConfig({ ...base, AGENT_BIND_HOST: "127.0.0.2", AGENT_PORT: "9100", HTTP_HOST: "0.0.0.0", HTTP_PORT: "8080" });
    expect([c.agentBindHost, c.agentPort, c.httpHost, c.httpPort]).toEqual(["127.0.0.2", 9100, "0.0.0.0", 8080]);
    expect(studioEnv(c)).toEqual({ AGENT_BIND_HOST: "127.0.0.2", AGENT_PORT: "9100" });
  });

  it("rejects malformed hosts and a port clash", () => {
    expect(issuesOf({ ...base, HTTP_HOST: "http://127.0.0.1" })).toEqual([
      "HTTP_HOST: must be a host name or IP address, without scheme or port",
    ]);
    expect(issuesOf({ ...base, AGENT_BIND_HOST: "127.0.0.1:9000" })).toHaveLength(1);
    expect(issuesOf({ ...base, AGENT_PORT: "8787" })).toEqual(["AGENT_PORT: must differ from HTTP_PORT"]);
  });

  it("needs both Binance credentials or neither", () => {
    expect(issuesOf({ ...base, BINANCE_WEB3_API_KEY: "only-key" })).toEqual([
      "binance: BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET must be set together",
    ]);
  });
});

describe("secret handling", () => {
  const secrets = {
    key: PK.slice(2),
    rpcKey: "rpc-key-0123456789abcdef",
    apiKey: "binance-api-key-7f3a",
    apiSecret: "binance-api-secret-9c1e",
    password: "keystore-password-55aa",
  };

  const configs = [
    loadConfig({ ...base, BINANCE_WEB3_API_KEY: secrets.apiKey, BINANCE_WEB3_API_SECRET: secrets.apiSecret }),
    loadConfig({ CHAIN_ID: "97", BSC_RPC_URL: `${RPC}?token=abc`, AGENT_KEYSTORE_PATH: "/k.json", AGENT_KEYSTORE_PASSWORD: secrets.password }),
  ];

  it("never prints a secret from describe, toString, JSON or inspect", () => {
    for (const c of configs) {
      const outputs = [c.describe(), String(c), `${c}`, JSON.stringify(c), inspect(c, { depth: 10 })];
      for (const out of outputs) {
        for (const s of Object.values(secrets)) expect(out).not.toContain(s);
        expect(out).not.toContain("token=abc");
      }
    }
  });

  it("describes the config in one safe line", () => {
    expect(configs[0]!.describe()).toBe(
      `chain=56 (bsc) rpc=https://bsc-mainnet.example.org/[redacted] signer=private key binance=keyed ` +
        `deployment=${configs[0]!.deploymentFile} data=${configs[0]!.dataDir} agent=127.0.0.1:9000 http=127.0.0.1:8787 x402Cap=$0.5/day dryRun=true`,
    );
    expect(configs[1]!.describe()).toContain("signer=keystore ");
    expect(configs[1]!.describe()).toContain("binance=keyless");
  });

  it("lists every secret for the feed scrubber", () => {
    expect(deskSecrets(configs[0]!)).toEqual(expect.arrayContaining([RPC, "v1/rpc-key-0123456789abcdef", PK, secrets.key, secrets.apiKey, secrets.apiSecret]));
    expect(deskSecrets(configs[1]!)).toEqual(expect.arrayContaining([`${RPC}?token=abc`, "v1/rpc-key-0123456789abcdef?token=abc", secrets.password]));
  });

  it("recognises loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "10.0.0.1", "128.0.0.1", "desk.example", "::ffff:10.0.0.1"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("redacts credentials, paths and queries from URLs", () => {
    expect(redactUrl("https://user:pass@rpc.example.org:8545/v1/key?x=1")).toBe("https://rpc.example.org:8545/[redacted]");
    expect(redactUrl("https://bsc-rpc.publicnode.com")).toBe("https://bsc-rpc.publicnode.com");
    expect(redactUrl("https://bsc-rpc.publicnode.com/")).toBe("https://bsc-rpc.publicnode.com");
    expect(redactUrl("nonsense")).toBe("[redacted]");
  });
});
