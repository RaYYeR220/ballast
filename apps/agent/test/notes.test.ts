import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Feed } from "../src/desk/feed";
import { NotesStore, NotesWorker, cleanNote, notePrompt, studioNoteModel } from "../src/desk/notes";

const tmp = () => mkdtemp(path.join(tmpdir(), "desk-notes-"));
const ACCOUNT = "0x00000000000000000000000000000000000000d1";
const TX = `0x${"ab".repeat(32)}` as const;

describe("note text", () => {
  it("keeps at most two sentences on one line, bounded, without markdown or secrets", () => {
    expect(cleanNote("**Shielded** NVDA.\nRepaid 13 USD1 from the cushion. Then more. And more.")).toBe("Shielded NVDA. Repaid 13 USD1 from the cushion.");
    expect(cleanNote("leaked sk-secret-123 here", ["sk-secret-123"])).toBe("leaked [redacted] here");
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote("x".repeat(1000))!.length).toBeLessThanOrEqual(320);
  });

  it("builds the prompt from whitelisted fields only: no addresses or transactions", () => {
    const p = notePrompt({
      seq: 1,
      ts: 1,
      kind: "shield",
      source: "keeper",
      account: ACCOUNT,
      symbol: "NVDA",
      txHash: TX,
      window: { kind: "OVERNIGHT", startsAt: 1, endsAt: 2, gapBps: 417 },
      plan: { kind: "repay", gapBps: 417, step: { fn: "shieldRepay", assets: "13" }, debtBefore: "999" },
      sim: { via: "rpc", ok: true },
    });
    expect(p).not.toContain(ACCOUNT);
    expect(p).not.toContain(TX);
    expect(p).not.toContain("999");
    expect(JSON.parse(p)).toMatchObject({ kind: "shield", symbol: "NVDA", window: { kind: "OVERNIGHT", gapBps: 417 }, plan: { action: "shieldRepay" }, broadcast: true });
  });
});

describe("NotesWorker", () => {
  it("notes new shields, restores and refusals only, skipping what was there at start", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [] });
    await feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, symbol: "NVDA" });
    const store = new NotesStore(dir);
    const prompts: string[] = [];
    const worker = new NotesWorker({
      feed,
      store,
      model: async ({ user }) => {
        prompts.push(user);
        return `Noted ${JSON.parse(user).kind}.`;
      },
    });
    await feed.record({ kind: "publish", source: "publisher", symbols: ["NVDA"] });
    const r = await feed.record({ kind: "refused", source: "keeper", account: ACCOUNT, error: { name: "NotInShieldWindow", message: "deleverage is only allowed close to a market closure" } });
    expect(await worker.tick()).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(store.get(r.seq)).toBe("Noted refused.");
    expect(await worker.tick()).toBe(0);
    const reloaded = new NotesStore(dir);
    await reloaded.load();
    expect(reloaded.get(r.seq)).toBe("Noted refused.");
  });

  it("ignores model failures and timeouts, and scrubs secrets from the prompt", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [] });
    const store = new NotesStore(dir);
    const seen: string[] = [];
    let n = 0;
    const worker = new NotesWorker({
      feed,
      store,
      secrets: ["super-secret-rpc-key"],
      timeoutMs: 50,
      model: async ({ user }) => {
        seen.push(user);
        n++;
        if (n === 1) throw new Error("provider down");
        return new Promise<string>(() => undefined); // never answers
      },
    });
    await feed.record({ kind: "shield", source: "keeper", reason: "rpc super-secret-rpc-key failed" });
    await feed.record({ kind: "restore", source: "keeper" });
    expect(await worker.tick()).toBe(0);
    expect(seen.join()).not.toContain("super-secret-rpc-key");
  });

  it("aborts the model call itself when the note times out", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [] });
    let signal: AbortSignal | undefined;
    const worker = new NotesWorker({
      feed,
      store: new NotesStore(dir),
      timeoutMs: 30,
      model: (_p, s) => {
        signal = s;
        return new Promise<string>(() => undefined);
      },
    });
    await feed.record({ kind: "shield", source: "keeper" });
    expect(await worker.tick()).toBe(0);
    expect(signal?.aborted).toBe(true);
  });

  it("stops calling the model once the daily budget is spent, until the next UTC day", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [] });
    const store = new NotesStore(dir);
    let now = 20_000 * 86_400 + 100;
    let calls = 0;
    const logs: string[] = [];
    const worker = new NotesWorker({
      feed,
      store,
      dailyMax: 2,
      clock: () => now,
      log: (l) => logs.push(l),
      model: async () => {
        calls++;
        if (calls === 1) throw new Error("provider down"); // a failed call still spends budget
        return "Noted.";
      },
    });
    for (let i = 0; i < 4; i++) await feed.record({ kind: "shield", source: "keeper" });
    expect(await worker.tick()).toBe(1);
    expect(calls).toBe(2);
    expect(logs.filter((l) => l.includes("daily budget"))).toHaveLength(1);
    await feed.record({ kind: "restore", source: "keeper" });
    expect(await worker.tick()).toBe(0);
    expect(calls).toBe(2);
    now += 86_400;
    await feed.record({ kind: "restore", source: "keeper" });
    expect(await worker.tick()).toBe(1);
    expect(calls).toBe(3);
  });

  it("is off when studio.toml has no usable provider", async () => {
    const dir = await tmp();
    const logs: string[] = [];
    expect(await studioNoteModel(path.join(dir, "missing.toml"), (l) => logs.push(l))).toBeNull();
    expect(logs[0]).toMatch(/desk notes off/);
  }, 60_000); // the Studio runtime is a large import: slow on a busy machine
});
