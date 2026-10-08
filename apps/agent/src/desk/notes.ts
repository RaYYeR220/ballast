// Desk notes: after each shield, restore or refusal, one call to the Studio project's LLM ([llm] in
// studio.toml) turns the event into at most two plain sentences for the web app. Notes are written after the
// fact and never read back by any decision; a missing provider, a timeout or a bad answer just means no
// note. The prompt carries only whitelisted event fields (no addresses, transactions or keys), scrubbed of
// every desk secret once more before it leaves.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Feed, FeedEvent, FeedKind } from "./feed";

/** One LLM call; `signal` aborts the request when the note times out. */
export type NoteModel = (prompt: { system: string; user: string }, signal?: AbortSignal) => Promise<string>;

export const NOTES_TICK_SEC = 15;
const NOTE_KINDS: ReadonlySet<FeedKind> = new Set(["shield", "restore", "refused"]);
const MAX_PER_TICK = 5;
const TIMEOUT_MS = 20_000;
const MAX_CHARS = 320;
/** LLM calls per UTC day unless configured otherwise. */
export const DEFAULT_DAILY_MAX = 200;

export const NOTE_SYSTEM =
  "You write the audit log of an automated lending risk desk for tokenized US stocks. Given one event as JSON, " +
  "explain in at most two short plain sentences what the desk did or why it was refused, for the position's owner. " +
  "Use only facts in the event. No advice, no speculation, no markdown.";

/** The fields a note may see: what happened and why, nothing that identifies a wallet or a transaction. */
export function notePrompt(e: FeedEvent): string {
  const plan = (e.plan ?? {}) as Record<string, unknown>;
  const step = (plan.step ?? null) as Record<string, unknown> | null;
  const facts = {
    kind: e.kind,
    source: e.source,
    symbol: e.symbol,
    window: e.window ? { kind: e.window.kind, gapBps: e.window.gapBps } : undefined,
    reason: e.reason,
    error: e.error ? { name: e.error.name, message: e.error.message, reason: e.error.reason } : undefined,
    plan: e.plan
      ? {
          kind: plan.kind,
          mode: plan.mode,
          gapBps: plan.gapBps,
          targetHfAfterGap: plan.targetHfAfterGap,
          hfAfterGap: plan.hfAfterGap,
          ltvBps: plan.ltvBps,
          action: step?.fn,
          warnings: plan.warnings,
        }
      : undefined,
    simulated: e.sim ? { via: e.sim.via, ok: e.sim.ok } : undefined,
    broadcast: e.txHash !== undefined,
    dryRun: e.dryRun === true,
    cover: e.cover !== undefined,
  };
  return JSON.stringify(facts);
}

/** At most two sentences, one line, bounded length; null when nothing usable is left. */
export function cleanNote(text: string, secrets: readonly string[] = []): string | null {
  let t = String(text ?? "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join("[redacted]");
  if (!t) return null;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (sentences && sentences.length > 2) t = sentences.slice(0, 2).join("").trim();
  if (t.length > MAX_CHARS) t = `${t.slice(0, MAX_CHARS - 3).trimEnd()}...`;
  return t;
}

const scrub = (s: string, secrets: readonly string[]) => secrets.reduce((acc, x) => (x.length >= 4 ? acc.split(x).join("[redacted]") : acc), s);

// ------------------------------------------------------------------ store

/** Notes by feed seq, appended to <dataDir>/notes.jsonl; the read API attaches them to their events. */
export class NotesStore {
  readonly file: string;
  readonly #notes = new Map<number, string>();
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.file = path.join(dir, "notes.jsonl");
  }

  async load(): Promise<void> {
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      try {
        const j = JSON.parse(line) as { seq?: unknown; note?: unknown };
        if (typeof j.seq === "number" && typeof j.note === "string") this.#notes.set(j.seq, j.note);
      } catch {
        // torn line
      }
    }
  }

  get(seq: number): string | undefined {
    return this.#notes.get(seq);
  }

  get lastSeq(): number {
    let m = 0;
    for (const k of this.#notes.keys()) if (k > m) m = k;
    return m;
  }

  async set(seq: number, note: string): Promise<void> {
    this.#notes.set(seq, note);
    try {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.file, `${JSON.stringify({ seq, note })}\n`, "utf8");
    } catch {
      // the note stays in memory
    }
  }
}

// ----------------------------------------------------------------- worker

export interface NotesWorkerOptions {
  feed: Feed;
  store: NotesStore;
  model: NoteModel;
  secrets?: readonly string[];
  timeoutMs?: number;
  /** Most model calls per UTC day (failed calls count); events past the budget get no note. */
  dailyMax?: number;
  /** Unix seconds. */
  clock?: () => number;
  log?: (line: string) => void;
}

export class NotesWorker {
  readonly #o: NotesWorkerOptions;
  #after: number;
  #day = -1;
  #calls = 0;

  /** Starts after the newest event already in the feed: no backfill burst of LLM calls on a restart. */
  constructor(o: NotesWorkerOptions) {
    this.#o = o;
    this.#after = Math.max(o.feed.list({ limit: 1 })[0]?.seq ?? 0, o.store.lastSeq);
  }

  async tick(): Promise<number> {
    const fresh = this.#o.feed
      .list({ limit: 500 })
      .filter((e) => e.seq > this.#after)
      .reverse();
    if (fresh.length === 0) return 0;
    const todo = fresh.filter((e) => NOTE_KINDS.has(e.kind)).slice(0, MAX_PER_TICK);
    // Events past the batch wait for the next tick; quiet kinds are skipped for good.
    const lastTodo = todo.at(-1);
    this.#after = todo.length === MAX_PER_TICK && lastTodo ? lastTodo.seq : (fresh.at(-1) as FeedEvent).seq;
    let written = 0;
    for (const e of todo) {
      if (!this.#spend()) continue;
      const note = await this.#write(e);
      if (note) {
        await this.#o.store.set(e.seq, note);
        written++;
      }
    }
    return written;
  }

  /** Takes one call from today's budget; false (logged once a day) when it is used up. */
  #spend(): boolean {
    const now = (this.#o.clock ?? (() => Math.floor(Date.now() / 1000)))();
    const day = Math.floor(now / 86_400);
    if (day !== this.#day) {
      this.#day = day;
      this.#calls = 0;
    }
    const max = this.#o.dailyMax ?? DEFAULT_DAILY_MAX;
    if (this.#calls >= max) {
      if (this.#calls === max) this.#o.log?.(`desk notes: daily budget of ${max} calls used up, no more notes today`);
      this.#calls = max + 1;
      return false;
    }
    this.#calls++;
    return true;
  }

  async #write(e: FeedEvent): Promise<string | null> {
    const secrets = this.#o.secrets ?? [];
    const user = scrub(notePrompt(e), secrets);
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const text = await Promise.race([
        this.#o.model({ system: NOTE_SYSTEM, user }, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort(); // stop the request itself, not only our wait for it
            reject(new Error("note timed out"));
          }, this.#o.timeoutMs ?? TIMEOUT_MS);
        }),
      ]);
      return cleanNote(text, secrets);
    } catch (err) {
      this.#o.log?.(`note for event ${e.seq} skipped: ${(err as Error).message?.slice(0, 200)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------- the model

/**
 * The Studio project's default LLM ([llm] in studio.toml, key from the provider's environment variable) as
 * a NoteModel, or null when it is not configured (no provider, no key, or the runtime cannot load it).
 */
export async function studioNoteModel(studioToml: string, log?: (line: string) => void): Promise<NoteModel | null> {
  try {
    const { loadStudioToml } = await import("@bnbagent/studio-runtime/config");
    const { resolveModel, resolveProviderConfig } = await import("@bnbagent/studio-runtime/llm");
    const { generateText } = await import("ai");
    const llm = (loadStudioToml(studioToml).llm ?? {}) as Record<string, unknown>;
    if (!llm.provider || String(llm.provider) === "none") {
      log?.("desk notes off: no [llm] provider in studio.toml");
      return null;
    }
    const cfg = resolveProviderConfig(llm as never); // throws when the provider's key is missing
    const model = resolveModel(llm as never);
    log?.(`desk notes on: ${cfg.provider} ${cfg.modelId}`);
    return async ({ system, user }, signal) => {
      const r = await generateText({ model, system, prompt: user, maxOutputTokens: 120, temperature: 0.2, maxRetries: 0, ...(signal ? { abortSignal: signal } : {}) });
      return r.text;
    };
  } catch (err) {
    log?.(`desk notes off: ${((err as Error).message ?? String(err)).split("\n")[0]?.slice(0, 200)}`);
    return null;
  }
}
