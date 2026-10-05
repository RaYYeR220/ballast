/** Spaces calls per key so each endpoint stays under `perSecond`. */
export class EndpointLimiter {
  private readonly next = new Map<string, number>();
  constructor(private readonly perSecond: number, private readonly clock: () => number = Date.now) {}

  async take(key: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + 1000 / this.perSecond);
    if (at > now) await sleep(at - now);
  }
}
