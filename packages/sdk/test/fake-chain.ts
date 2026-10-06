import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

type Answer = { ok: Hex } | { revert: Hex } | { fail: string };

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

/**
 * Minimal JSON-RPC backend: eth_call answers come from a fixture map keyed by (to, calldata).
 * Multicall3 aggregate3 calls are unpacked and answered call by call from the same map.
 */
export class FakeChain {
  private readonly calls = new Map<string, Answer>();
  private readonly codes = new Map<string, Hex>();
  /** Every eth_call / eth_getCode with its block parameter; calls inside a multicall are listed with via. */
  readonly requests: { method: string; to?: string; data?: Hex; block?: unknown; via?: "multicall" }[] = [];
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

  private answer(to: Address, data: Hex): { ok: Hex } | { revert: Hex } {
    const a = this.calls.get(this.key(to, data));
    if (!a) throw new Error(`unmocked eth_call ${getAddress(to)} ${data.slice(0, 10)}`);
    if ("fail" in a) throw new Error(a.fail);
    return a;
  }

  private aggregate3(data: Hex, block: unknown): Hex {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const results = calls.map((c) => {
      this.requests.push({ method: "eth_call", to: c.target.toLowerCase(), data: c.callData, block, via: "multicall" });
      const a = this.answer(c.target, c.callData);
      if ("ok" in a) return { success: true, returnData: a.ok };
      if (!c.allowFailure) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
      return { success: false, returnData: a.revert };
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
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
            this.requests.push({ method, to: addr, block: p[1] });
            return this.codes.get(addr) ?? "0x";
          }
          if (method === "eth_call") {
            const { to, data } = p[0] as { to: Address; data: Hex };
            this.requests.push({ method, to: to.toLowerCase(), data, block: p[1] });
            if (to.toLowerCase() === MULTICALL3) return this.aggregate3(data, p[1]);
            const a = this.answer(to, data);
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
