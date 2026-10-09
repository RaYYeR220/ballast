import { describe, expect, it, vi } from "vitest";
import { normalizeEvents } from "../lib/desk";
import { deskFeed, deskGet, deskHealth, deskPath } from "../lib/server/agent";
import { deskClient } from "../lib/server/desk";
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
    const err = await deskGet("oracle", {}, { baseUrl: "http://desk", fetch: (async () => json({ error: "chain read failed" }, 503)) as never });
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
    expect(deskPath("ledger", { kind: "income", limit: 20 })).toBe("/ledger?kind=income&limit=20");
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
    expect((await handleDesk(new Request("http://x/api/desk/feed?kind=shields"), "feed", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/feed?source=root"), "feed", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/ledger?kind=shield"), "ledger", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/evidence"), "evidence", online)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/evidence?jobId=..%2F..%2Fetc"), "evidence", online)).status).toBe(400);
  });

  it("proxies the feed for one account", async () => {
    const f = vi.fn(async () => json(FEED));
    const res = await handleDesk(new Request(`http://x/api/desk/feed?account=${ACCOUNT}&kind=refused&source=keeper&limit=500`), "feed", { baseUrl: "http://desk", fetch: f as never });
    expect(res.status).toBe(200);
    // the address is validated and checksummed; kind and source come from fixed lists
    expect((f.mock.calls[0] as unknown as [string])[0].toLowerCase()).toBe(`http://desk/feed?account=${ACCOUNT}&kind=refused&source=keeper&limit=500`);
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

describe("only the views the site uses", () => {
  it("does not proxy the desk's account list or its API statistics", async () => {
    const f = vi.fn(async () => json({}));
    for (const view of ["accounts", "api-health", "", "feed/../accounts", "__proto__", "constructor"]) {
      const res = await handleDesk(new Request(`http://x/api/desk/${view}`), view, { baseUrl: "http://desk", fetch: f as never });
      expect(res.status, view).toBe(404);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("takes only the parameters a view has", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    const o = { baseUrl: "http://desk", fetch: f as never };
    expect((await handleDesk(new Request("http://x/api/desk/health?account=" + ACCOUNT), "health", o)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/oracle?limit=5"), "oracle", o)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/ledger?account=" + ACCOUNT), "ledger", o)).status).toBe(400);
    expect((await handleDesk(new Request("http://x/api/desk/feed?jobId=1"), "feed", o)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    await handleDesk(new Request("http://x/api/desk/ledger?kind=income&limit=20"), "ledger", o);
    await handleDesk(new Request("http://x/api/desk/evidence?jobId=0004152"), "evidence", o);
    expect(f.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["http://desk/ledger?kind=income&limit=20", "http://desk/evidence/4152"]);
  });

  it("reports a halted desk as online and halted, not as offline", async () => {
    const halted = { ok: false, chainId: 56, agent: ACCOUNT, dryRun: false, sender: { sales: "protected", halted: { reason: "nonce-gap", message: "nonce 12 is stuck", nonce: 12, since: 1 }, inFlight: { nonce: 12, hashes: [TX] } }, loops: [{ name: "keeper" }] };
    const r = await deskHealth({ baseUrl: "http://desk", fetch: (async () => json(halted, 503)) as never });
    expect(r.status).toBe("online");
    if (r.status !== "online") return;
    expect(r.data).toMatchObject({ ok: false, agent: ACCOUNT, sender: { halted: { reason: "nonce-gap", nonce: 12 } } });
    // loop internals and in-flight hashes stay on the desk
    expect(JSON.stringify(r.data)).not.toContain("loops");
    expect(JSON.stringify(r.data)).not.toContain(TX);
    // any other view answering 503 is still an error
    const feed = await deskGet("feed", {}, { baseUrl: "http://desk", fetch: (async () => json({ ok: false }, 503)) as never });
    expect(feed.status).toBe("offline");
  });

  it("gives server code typed, validated reads", async () => {
    const f = vi.fn(async (url: string) => json(url.includes("/feed") ? FEED : url.includes("/ledger") ? { x402: { capUsd: 0.5, spentTodayUsd: 0 }, total: {}, today: {}, entries: [] } : { ok: true }));
    const d = deskClient({ baseUrl: "http://desk", fetch: f as never });
    const feed = await d.feed({ account: ACCOUNT, kind: "shield", limit: 5000 });
    expect(feed.status).toBe("online");
    expect((f.mock.calls[0] as unknown as [string])[0].toLowerCase()).toBe(`http://desk/feed?account=${ACCOUNT}&kind=shield&limit=500`);
    expect((await d.ledger({ kind: "income" })).status).toBe("online");
    expect((await d.evidence(4152n)).status).toBe("online");
    expect((f.mock.calls[2] as unknown as [string])[0]).toBe("http://desk/evidence/4152");
    // refused before any request
    const before = f.mock.calls.length;
    expect(await d.feed({ account: "0x12" })).toMatchObject({ status: "offline", detail: "account must be a 0x address" });
    expect(await d.feed({ kind: "everything" as never })).toMatchObject({ status: "offline" });
    expect(await d.ledger({ kind: "shield" as never })).toMatchObject({ status: "offline" });
    expect(await d.evidence("../secrets")).toMatchObject({ status: "offline", detail: "jobId must be a decimal number" });
    expect(f.mock.calls.length).toBe(before);
    expect(await deskClient({ baseUrl: null }).health()).toMatchObject({ status: "offline", reason: "not-configured" });
  });
});
