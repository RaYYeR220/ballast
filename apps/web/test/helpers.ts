/* Test helpers: a viem client whose eth_call answers from a stub, and a fixed deployment. */
import { ballastErrorsAbi, parseDeployment } from "@ballast/sdk";
import { createPublicClient, custom, encodeErrorResult, getAddress, toHex, type Address, type Hex, type PublicClient } from "viem";

export const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));

export const DEPLOYMENT = parseDeployment(31337, {
  owner: addr(0xa0),
  calendar: addr(0xa1),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
  block: 123,
});

export const errorData = (errorName: string, args?: readonly unknown[]): Hex =>
  encodeErrorResult({ abi: ballastErrorsAbi, errorName, args } as never);

export type CallAnswer = { ok: Hex } | { revert: Hex } | { fail: string };

/** A public client whose eth_call goes to `answer`; records each call. */
export function stubClient(answer: (call: { from?: string; to: string; data: Hex }) => CallAnswer) {
  const calls: { from?: string; to: string; data: Hex }[] = [];
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          const p = (params ?? []) as unknown[];
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_blockNumber") return "0x10";
          if (method === "eth_call") {
            const c = p[0] as { from?: string; to: string; data: Hex };
            calls.push(c);
            const a = answer(c);
            if ("fail" in a) throw new Error(a.fail);
            if ("revert" in a) throw Object.assign(new Error("execution reverted"), { code: 3, data: a.revert });
            return a.ok;
          }
          throw new Error(`unsupported method ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
  return { client, calls };
}

export const jsonRequest = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

type Answer = unknown | ((o: { address: string; args: readonly unknown[] }) => unknown);

/**
 * A ReadClient answering readContract by function name ("fn" or "fn@0xaddress" in lower case). A value that
 * is an Error is thrown. Unmocked reads throw, so a test never passes on a read it did not expect.
 */
export function fakeReads(
  answers: Record<string, Answer>,
  o: { code?: Record<string, Hex> | ((address: string) => Hex); timestamp?: bigint; blockNumber?: bigint } = {},
) {
  const reads: { address: string; functionName: string; args: readonly unknown[] }[] = [];
  /** the head the client reports; tests move it to mine a block */
  const chain = { blockNumber: o.blockNumber ?? 1000n, timestamp: o.timestamp ?? 1_791_300_000n, headReads: 0 };
  const client = {
    // `headReads` counts reads of the latest block only; a read pinned to a block number is not a head read
    getBlock: async (args?: { blockNumber?: bigint }) => {
      if (args?.blockNumber === undefined) chain.headReads++;
      return { number: args?.blockNumber ?? chain.blockNumber, timestamp: chain.timestamp };
    },
    getBlockNumber: async () => chain.blockNumber,
    getCode: async ({ address }: { address: string }) => (typeof o.code === "function" ? o.code(address) : (o.code?.[address.toLowerCase()] ?? "0x")),
    multicall: async () => {
      throw new Error("multicall is not mocked");
    },
    readContract: async ({ address, functionName, args = [] }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      reads.push({ address, functionName, args });
      const key = `${functionName}@${address.toLowerCase()}`;
      const hit = key in answers ? answers[key] : functionName in answers ? answers[functionName] : new Error(`unmocked read ${key}`);
      const v = typeof hit === "function" ? await (hit as (o: { address: string; args: readonly unknown[] }) => unknown)({ address, args }) : hit;
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { client: client as never, reads, chain };
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** What CushionVault.cover(user, key) returns when no cover is open. */
export const NO_COVER = {
  venue: 0,
  mp: { loanToken: ZERO, collateralToken: ZERO, oracle: ZERO, irm: ZERO, lltv: 0n },
  vDebt: ZERO,
  token: ZERO,
  symbol: `0x${"00".repeat(32)}`,
  keeper: ZERO,
  capPerDay: 0n,
  balance: 0n,
  dayStart: 0n,
  usedToday: 0n,
} as const;

/** EIP-1167 runtime code of a minimal proxy pointing at `impl`. */
export const cloneCode = (impl: Address): Hex => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
