import { describe, expect, it, vi } from "vitest";
import { normalizeEvents } from "../lib/desk";
import { deskFeed, deskGet, deskPath } from "../lib/server/agent";
import { handleDesk } from "../lib/server/handlers/desk";

const ACCOUNT = "0x00000000000000000000000000000000000000bb";
const TX = `0x${"ab".repeat(32)}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FEED = {
  events: [
    { seq: 1, ts: 1_791_000_000, kind: "shield", source: "keeper", account: ACCOUNT, symbol: "NVDA", txHash: TX, plan: { step: { fn: "shieldRepay", assets: "2900000000000000000000" } } },
    { seq: 2, ts: 1_791_000_600, kind: "refused", source: "keeper", account: ACCOUNT, error: { name: "RestoreRefused", message: "restore refused", reason: "NOT_REGULAR" }, note: "The restore was refused." },
    { seq: 3, kind: "shield" },
    "junk",
    { seq: 4, ts: 1_791_000_700, kind: "pending", txHash: "0x1234" },
  ],
};

describe("normalizeEvents", () => {
  it("keeps well-formed events, newest first, and drops bad tx hashes", () => {
    const ev = normalizeEvents(FEED);
    expect(ev.map((e) => e.seq)).toEqual([4, 2, 1]);
    expect(ev[0]!.txHash).toBeUndefined();
    expect(ev[1]).toMatchObject({ kind: "refused", note: "The restore was refused.", error: { name: "RestoreRefused", reason: "NOT_REGULAR" } });
    expect(ev[2]!.txHash).toBe(TX);
  });

  it("returns nothing for answers that are not a feed", () => {
    expect(normalizeEvents(null)).toEqual([]);
    expect(normalizeEvents({ error: "nope" })).toEqual([]);
  });
});

describe("deskGet", () => {
  it("is offline, not configured, without AGENT_API_URL and makes no request", async () => {
    const f = vi.fn();
    const r = await deskGet("health", {}, { baseUrl: null, fetch: f as never });
    expect(r).toMatchObject({ status: "offline", reason: "not-configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("is offline when the desk cannot be reached or times out", async () => {
    const down = await deskGet("feed", {}, { baseUrl: "http://desk", fetch: (async () => { throw new TypeError("fetch failed"); }) as never });
    expect(down).toMatchObject({ status: "offline", reason: "unreachable", detail: "the desk could not be reached" });
    const slow = await deskGet("feed", {}, {
      baseUrl: "http://desk",
      fetch: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as never,
    });
    expect(slow).toMatchObject({ status: "offline", reason: "unreachable", detail: "the desk did not answer in time" });
  });

  it("is offline on an error status or a body that is not JSON", async () => {
    const err = await deskGet("accounts", {}, { baseUrl: "http://desk", fetch: (async () => json({ error: "chain read failed" }, 503)) as never });
    expect(err).toMatchObject({ status: "offline", reason: "error", detail: "the desk answered 503: chain read failed" });
    const html = await deskGet("health", {}, { baseUrl: "http://desk", fetch: (async () => new Response("<html>", { status: 200 })) as never });
    expect(html).toMatchObject({ status: "offline", reason: "error" });
  });

  it("returns the body when online and asks with a 15 s revalidate", async () => {
    const f = vi.fn(async () => json({ ok: true, agent: ACCOUNT }));
    const r = await deskGet("health", {}, { baseUrl: "http://desk", fetch: f as never });
    expect(r).toMatchObject({ status: "online", data: { ok: true, agent: ACCOUNT } });
    const [url, init] = f.mock.calls[0] as unknown as [string, { next: { revalidate: number } }];
    expect(url).toBe("http://desk/health");
    expect(init.next.revalidate).toBe(15);
  });

  it("builds paths with the query", () => {
    expect(deskPath("feed", { account: ACCOUNT, limit: 50 })).toBe(`/feed?account=${ACCOUNT}&limit=50`);
    expect(deskPath("evidence", { jobId: "4152" })).toBe("/evidence/4152");
    expect(deskPath("api-health")).toBe("/api-health");
  });

  it("normalizes the feed", async () => {
    const r = await deskFeed({ account: ACCOUNT }, { baseUrl: "http://desk", fetch: (async () => json(FEED)) as never });
    expect(r.status).toBe("online");
    if (r.status === "online") expect(r.data.events).toHaveLength(3);
  });
});

describe("GET /api/desk/<view>", () => {
  const online = { baseUrl: "http://desk", fetch: (async () => json(FEED)) as never };

  it("rejects unknown views and bad parameters", async () => {
    expect((await handleDesk(new Request("http://x/api/desk/secrets"), "secrets", online)).status).toBe(404);
    expect((await handleDesk(new Request("http://x/api/desk/feed?account=0x12"), "feed", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/feed?limit=0"), "feed", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/feed?kind=DROP%20TABLE"), "feed", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/evidence"), "evidence", online)).status).toBe(400);
  });

  it("proxies the feed for one account", async () => {
    const f = vi.fn(async () => json(FEED));
    const res = await handleDesk(new Request(`http://x/api/desk/feed?account=${ACCOUNT}&limit=9999`), "feed", { baseUrl: "http://desk", fetch: f as never });
    expect(res.status).toBe(200);
    // the address is validated and checksummed, the limit capped at the feed maximum
    expect((f.mock.calls[0] as unknown as [string])[0].toLowerCase()).toBe(`http://desk/feed?account=${ACCOUNT}&limit=500`);
    const body = await res.json();
    expect(body.status).toBe("online");
    expect(body.data.events).toHaveLength(3);
  });

  it("answers 200 with an explicit offline state and no caching", async () => {
    const res = await handleDesk(new Request("http://x/api/desk/feed"), "feed", { baseUrl: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "offline", reason: "not-configured" });
  });
});
