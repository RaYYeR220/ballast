/* Guards around a chain read: a deadline for the whole answer, a cap on reads running at once, and bodies
   read only up to a size. None of these replace the per-request RPC timeout; they bound what is left. */
import { LIMITS } from "./limits";

export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`no answer within ${Math.round(ms / 1000)} s`);
    this.name = "DeadlineError";
  }
}

export class BusyError extends Error {
  constructor() {
    super("too many reads in progress, try again in a moment");
    this.name = "BusyError";
  }
}

export class TooLargeError extends Error {
  constructor(max: number) {
    super(`larger than ${max} bytes`);
    this.name = "TooLargeError";
  }
}

/** Rejects with DeadlineError when `work` has not settled after `ms`. The RPC requests underneath time out on their own. */
export function withDeadline<T>(work: Promise<T>, ms: number = LIMITS.routeDeadlineMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** At most `max` jobs at once; one more is refused with BusyError instead of queueing without bound. */
export function gate(max: number = LIMITS.concurrentReads) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (active >= max) throw new BusyError();
      active++;
      try {
        return await job();
      } finally {
        active--;
      }
    },
  };
}

/** One shared gate for the uncached chain reads of this instance. */
export const readGate = gate();

/**
 * Text of a request or response body, read only up to `max` bytes. A declared content-length over the limit
 * is refused before any byte is read; a stream without one is cut off at the limit.
 */
export async function readCapped(source: Request | Response, max: number): Promise<string> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLargeError(max);
  const body = source.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError(max);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
