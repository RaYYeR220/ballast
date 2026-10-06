import {
  createPublicClient,
  custom,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

type Answer = { ok: Hex } | { revert: Hex } | { fail: string };

/** Minimal JSON-RPC backend: eth_call answers come from a fixture map keyed by (to, calldata). */
export class FakeChain {
  private readonly calls = new Map<string, Answer>();
  private readonly codes = new Map<string, Hex>();
  readonly requests: { method: string; to?: string; data?: Hex }[] = [];
  timestamp = 1_790_000_000n;
  blockNumber = 1_000n;

  private key(to: Address, data: Hex) {
    return `${to.toLowerCase()}|${data.toLowerCase()}`;
  }

  /** Answer `functionName(args)` on `to` with `result` (encoded with the same ABI). */
  on(to: Address, abi: Abi, functionName: string, args: readonly unknown[], result: unknown): this {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ok = encodeFunctionResult({ abi, functionName, result } as never);
    this.calls.set(this.key(to, data), { ok });
    return this;
  }

  /** Make `functionName(args)` on `to` revert with `data` (custom error encoding or "0x"). */
  revert(to: Address, abi: Abi, functionName: string, args: readonly unknown[], data: Hex = "0x"): this {
    const call = encodeFunctionData({ abi, functionName, args } as never);
    this.calls.set(this.key(to, call), { revert: data });
    return this;
  }

  /** Make `functionName(args)` on `to` fail at the transport level (not a revert). */
  fail(to: Address, abi: Abi, functionName: string, args: readonly unknown[], message = "connection reset"): this {
    const call = encodeFunctionData({ abi, functionName, args } as never);
    this.calls.set(this.key(to, call), { fail: message });
    return this;
  }

  code(address: Address, bytecode: Hex): this {
    this.codes.set(address.toLowerCase(), bytecode);
    return this;
  }

  client() {
    return createPublicClient({
      transport: custom({
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          const p = (params ?? []) as unknown[];
          if (method === "eth_chainId") return "0x38";
          if (method === "eth_blockNumber") return toHex(this.blockNumber);
          if (method === "eth_getBlockByNumber") {
            return {
              number: toHex(this.blockNumber),
              timestamp: toHex(this.timestamp),
              hash: toHex(this.blockNumber, { size: 32 }),
              parentHash: toHex(0, { size: 32 }),
              transactions: [],
            };
          }
          if (method === "eth_getCode") {
            const addr = String(p[0]).toLowerCase();
            this.requests.push({ method, to: addr });
            return this.codes.get(addr) ?? "0x";
          }
          if (method === "eth_call") {
            const { to, data } = p[0] as { to: Address; data: Hex };
            this.requests.push({ method, to: to.toLowerCase(), data });
            const a = this.calls.get(this.key(to, data));
            if (!a) throw new Error(`unmocked eth_call ${getAddress(to)} ${data.slice(0, 10)}`);
            if ("fail" in a) throw new Error(a.fail);
            if ("revert" in a) throw Object.assign(new Error("execution reverted"), { code: 3, data: a.revert });
            return a.ok;
          }
          throw new Error(`unsupported method ${method}`);
        },
      }, { retryCount: 0 }),
    });
  }
}

/** EIP-1167 runtime code of a minimal proxy pointing at `impl`. */
export const cloneCode = (impl: Address): Hex =>
  `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

export const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));
