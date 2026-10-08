/* Hard bounds on what one request may cost the server. Every chain read reachable from a route handler is
   sized by the configuration or by one of these numbers, never by a caller-supplied range or by how much
   state exists on chain. */
export const LIMITS = {
  /** credit lines read per /api/accounts answer (newest first); older ones are paged with `offset` */
  accountsPerPage: 20,
  /** highest `offset` accepted */
  maxAccountOffset: 2000,
  /** accounts read at the same time within one answer */
  accountConcurrency: 5,
  /** desk feed events per answer */
  feedEvents: 500,
  /** guardian job ids scanned per answer (for the guardian board) */
  jobScan: 200,
  /** characters of query string accepted on any route */
  queryChars: 512,
  /** bytes of request body accepted by /api/simulate */
  bodyBytes: 64 * 1024,
  /** bytes of a desk answer read before giving up */
  deskAnswerBytes: 2 * 1024 * 1024,
  /** one JSON-RPC request */
  rpcTimeoutMs: 8_000,
  /** one desk request */
  deskTimeoutMs: 5_000,
  /** one whole chain-read answer */
  routeDeadlineMs: 20_000,
  /** uncached chain reads running at once on one instance; more are answered 503 */
  concurrentReads: 8,
  /** the head block is re-read at most this often; per-wallet answers are shared within one head */
  headTtlMs: 2_000,
  /** entries kept by the small per-process memo maps */
  memoEntries: 256,
} as const;
