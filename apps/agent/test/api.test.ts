import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiProbe, cached, closeServer, createDeskApi, listen } from "../src/desk/api";
import { deskSecrets, loadConfig } from "../src/desk/config";
import { Feed } from "../src/desk/feed";
import { Ledger } from "../src/desk/ledger";
import { NotesStore } from "../src/desk/notes";

const PK = `0x${"4f".repeat(32)}`;
const RPC = "https://bsc-mainnet.example.org/v1/rpc-key-0123456789abcdef";
const ENV = {
  CHAIN_ID: "56",
  BSC_RPC_URL: RPC,
  AGENT_PRIVATE_KEY: PK,
  BINANCE_WEB3_API_KEY: "binance-api-key-123",
  BINANCE_WEB3_API_SECRET: "binance-api-secret-456",
  PIEVERSE_LLM_API_KEY: "pieverse-llm-key-789",
};
const ACCOUNT = "0x00000000000000000000000000000000000000D1";
const ORIGIN = "https://ballast.example.org";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

async function start(o: { ratePerMin?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "desk-api-"));
  const config = loadConfig(ENV);
  const secrets = deskSecrets(config, ENV);
  // The feed here keeps secrets on purpose: the API must still never send them.
  const feed = new Feed({ dir });
  const ev = await feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, symbol: "NVDA", reason: `rpc ${RPC} said no, key ${ENV.BINANCE_WEB3_API_KEY}` });
  await feed.record({ kind: "publish", source: "publisher", symbols: ["NVDA"], data: { pk: PK } });
  const notes = new NotesStore(dir);
  await notes.set(ev.seq, "Repaid from the cushion before the close.");
  const ledger = new Ledger({ dir, x402DailyCapUsd: 0.5 });
  await ledger.record({ kind: "gas", source: "keeper", txHash: `0x${"11".repeat(32)}`, status: "success", gasUsed: "21000", effectiveGasPrice: "1000000000", feeWei: "21000000000000" });
  await mkdir(path.join(dir, "evidence"), { recursive: true });
  const evidence = `{"kind":"ballast-guardian-evidence","jobId":"42"}\n`;
  await writeFile(path.join(dir, "evidence", "42.json"), evidence);
  const probe = new ApiProbe();
  probe.record({ ts: "t", surface: "public", method: "GET", endpoint: "/v1/x", status: 200, code: "000000", ok: true, latencyMs: 10, attempt: 1 });
  probe.record({ ts: "t", surface: "public", method: "GET", endpoint: "/v1/x", status: 0, code: "TIMEOUT", ok: false, latencyMs: 90, attempt: 1 });
  const server = createDeskApi({
    feed,
    notes,
    ledger,
    dataDir: dir,
    webOrigin: ORIGIN,
    secrets,
    ratePerMin: o.ratePerMin ?? 1000,
    health: () => ({ ok: true, config: config.describe(), env: { ...ENV } }),
    accounts: async () => ({ accounts: [{ address: ACCOUNT, debt: 10n ** 18n, note: `secret ${ENV.PIEVERSE_LLM_API_KEY}` }] }),
    oracle: async () => {
      throw new Error(`upstream ${RPC} down`);
    },
    apiHealth: () => probe.summary(),
  });
  servers.push(server);
  const { port } = await listen(server, "127.0.0.1", 0);
  const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return { get, secrets, evidence };
}

describe("desk read API", () => {
  it("never sends an env secret, on any endpoint", async () => {
    const { get, secrets } = await start();
    const values = [...new Set([...Object.values(ENV).filter((v) => v.length > 8), ...secrets, PK.slice(2), "rpc-key-0123456789abcdef"])];
    for (const p of ["/health", "/feed", "/feed?account=" + ACCOUNT, "/accounts", "/oracle", "/ledger", "/evidence/42", "/api-health", "/", "/nope"]) {
      const res = await get(p);
      const text = await res.text();
      for (const s of values) expect(text, `${p} leaks ${s.slice(0, 6)}`).not.toContain(s);
    }
  });

  it("serves the feed newest first with notes and filters", async () => {
    const { get } = await start();
    const all = (await (await get("/feed")).json()) as { events: { kind: string; note?: string }[] };
    expect(all.events.map((e) => e.kind)).toEqual(["publish", "shield"]);
    expect(all.events[1]!.note).toBe("Repaid from the cushion before the close.");
    const mine = (await (await get(`/feed?account=${ACCOUNT.toLowerCase()}&limit=5`)).json()) as { events: unknown[] };
    expect(mine.events).toHaveLength(1);
    expect((await get("/feed?account=nope")).status).toBe(400);
    expect((await get("/feed?limit=-1")).status).toBe(400);
    expect((await get("/feed?kind=bogus")).status).toBe(400);
  });

  it("serves the ledger, bigints as strings, evidence verbatim and a 503 for a failed chain read", async () => {
    const { get, evidence } = await start();
    const l = (await (await get("/ledger")).json()) as { x402: { capUsd: number }; total: { transactions: number }; entries: unknown[] };
    expect(l.x402.capUsd).toBe(0.5);
    expect(l.total.transactions).toBe(1);
    const acc = (await (await get("/accounts")).json()) as { accounts: { debt: string }[] };
    expect(acc.accounts[0]!.debt).toBe("1000000000000000000");
    const e = await get("/evidence/42");
    expect(e.status).toBe(200);
    expect(await e.text()).toBe(evidence);
    expect((await get("/evidence/43")).status).toBe(404);
    expect((await get("/evidence/..%2F..%2Fledger")).status).toBe(400);
    const o = await get("/oracle");
    expect(o.status).toBe(503);
    expect(await o.json()).toEqual({ error: "chain read failed, try again shortly" });
    const h = (await (await get("/api-health")).json()) as { endpoints: { calls: number; errors: number; p50Ms: number; p95Ms: number; codes: Record<string, number> }[] };
    expect(h.endpoints[0]).toMatchObject({ calls: 2, errors: 1, p50Ms: 10, p95Ms: 90, codes: { "000000": 1, TIMEOUT: 1 } });
  });

  it("answers CORS for the web origin only and refuses writes", async () => {
    const { get } = await start();
    const ok = await get("/health", { headers: { Origin: ORIGIN } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const other = await get("/health", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await get("/feed", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect((await get("/feed", { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("rate-limits per client IP, taking it from the loopback proxy's X-Forwarded-For", async () => {
    const { get } = await start({ ratePerMin: 3 });
    const as = (ip: string) => get("/health", { headers: { "X-Forwarded-For": `10.0.0.9, ${ip}` } });
    for (let i = 0; i < 3; i++) expect((await as("203.0.113.5")).status).toBe(200);
    const limited = await as("203.0.113.5");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await as("203.0.113.6")).status).toBe(200);
  });
});

describe("cached", () => {
  it("shares one in-flight read and caches successes only", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const read = cached(
      async () => {
        calls++;
        if (fail) throw new Error("down");
        return calls;
      },
      1000,
      () => now,
    );
    await expect(read()).rejects.toThrow("down");
    fail = false;
    const [a, b] = await Promise.all([read(), read()]);
    expect([a, b]).toEqual([2, 2]);
    now = 500;
    expect(await read()).toBe(2);
    now = 1600;
    expect(await read()).toBe(3);
  });
});
