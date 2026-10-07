import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  encodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DESK_NAME,
  IDENTITY_REGISTRY,
  REGISTRATION_TYPE,
  buildRegistration,
  decodeAgentURI,
  encodeAgentURI,
  identityRegistryAbi,
  registerDesk,
} from "../src/desk/register";

const WALLET: Address = "0x1234567890AbcdEF1234567890aBcdef12345678";
const REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const input = {
  chainId: 56,
  identityRegistry: REGISTRY,
  agentWallet: WALLET,
  webUrl: "https://ballast.example",
  agentUrl: "https://desk.ballast.example/",
};

describe("buildRegistration", () => {
  it("builds the ERC-8004 registration file before the mint", () => {
    expect(buildRegistration(input)).toEqual({
      type: REGISTRATION_TYPE,
      name: DESK_NAME,
      description: expect.stringContaining("Session Oracle overlay"),
      services: [
        { name: "web", endpoint: "https://ballast.example/" },
        { name: "MCP", endpoint: "https://desk.ballast.example/mcp", version: "2025-11-25" },
        { name: "A2A", endpoint: "https://desk.ballast.example/.well-known/agent-card.json", version: "0.3.0" },
        { name: "agentWallet", endpoint: `eip155:56:${WALLET}` },
      ],
      x402Support: true,
      active: true,
      registrations: [],
    });
  });

  it("fills registrations once the agentId is known", () => {
    const reg = buildRegistration({ ...input, agentId: 358_216n });
    expect(reg.registrations).toEqual([{ agentId: 358216, agentRegistry: `eip155:56:${REGISTRY}` }]);
  });

  it("checksums addresses and keeps a path prefix on the agent URL", () => {
    const reg = buildRegistration({
      ...input,
      chainId: 31337,
      agentWallet: WALLET.toLowerCase() as Address,
      identityRegistry: REGISTRY.toLowerCase() as Address,
      agentUrl: "http://127.0.0.1:9000/desk//",
      agentId: 7,
    });
    expect(reg.services[1]!.endpoint).toBe("http://127.0.0.1:9000/desk/mcp");
    expect(reg.services[2]!.endpoint).toBe("http://127.0.0.1:9000/desk/.well-known/agent-card.json");
    expect(reg.services[3]!.endpoint).toBe(`eip155:31337:${WALLET}`);
    expect(reg.registrations[0]!.agentRegistry).toBe(`eip155:31337:${REGISTRY}`);
  });

  it("adds an image only when one is given", () => {
    expect("image" in buildRegistration(input)).toBe(false);
    expect(buildRegistration({ ...input, image: "https://ballast.example/desk.png" }).image).toBe("https://ballast.example/desk.png");
  });

  it("rejects endpoints that are not plain http(s) URLs", () => {
    expect(() => buildRegistration({ ...input, webUrl: "ftp://ballast.example" })).toThrow(/webUrl must be an http\(s\) URL/);
    expect(() => buildRegistration({ ...input, agentUrl: "https://desk.example/?q=1" })).toThrow(/without query/);
    expect(() => buildRegistration({ ...input, agentUrl: "https://user:pw@desk.example" })).toThrow(/credentials/);
    expect(() => buildRegistration({ ...input, agentUrl: "desk" })).toThrow(/not a URL/);
    expect(() => buildRegistration({ ...input, agentId: 2n ** 60n })).toThrow(/safe integer/);
  });

  it("round-trips through the on-chain data URI", () => {
    const reg = buildRegistration({ ...input, agentId: 42 });
    const uri = encodeAgentURI(reg);
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(decodeAgentURI(uri)).toEqual(reg);
    expect(() => decodeAgentURI("https://desk.example/registration.json")).toThrow(/data URI/);
  });

  it("points the fork at the mainnet registry", () => {
    expect(IDENTITY_REGISTRY[31337]).toBe(IDENTITY_REGISTRY[56]);
    expect(IDENTITY_REGISTRY[56]).toBe(REGISTRY);
  });
});

describe("registerDesk without broadcasting", () => {
  const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
  const chain = defineChain({
    id: 31337,
    name: "fork",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  });

  function clients(owner: Address, sent: string[], signerCode: Hex = "0x") {
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        sent.push(method);
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_getCode") return signerCode;
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const { data } = (params as [{ data: Hex }])[0];
        const call = decodeFunctionData({ abi: identityRegistryAbi, data });
        if (call.functionName === "register") {
          if (signerCode !== "0x") throw new Error("execution reverted");
          return encodeFunctionResult({ abi: identityRegistryAbi, functionName: "register", result: 358_300n });
        }
        if (call.functionName === "ownerOf") return encodeFunctionResult({ abi: identityRegistryAbi, functionName: "ownerOf", result: owner });
        if (call.functionName === "setAgentURI") return "0x";
        throw new Error(`unexpected call ${call.functionName}`);
      },
    }, { retryCount: 0 });
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ chain, transport, account }),
    };
  }

  const deskInput = { chainId: 31337, agentWallet: account.address, webUrl: "http://localhost:3000", agentUrl: "http://localhost:9000" };

  it("simulates a new registration and returns the predicted agentId", async () => {
    const sent: string[] = [];
    const result = await registerDesk({ ...clients(account.address, sent), registry: REGISTRY, input: deskInput, broadcast: false });
    expect(result.mode).toBe("simulated");
    expect(result.agentId).toBe(358_300n);
    expect(result.registration.registrations).toEqual([{ agentId: 358300, agentRegistry: `eip155:31337:${REGISTRY}` }]);
    expect(sent.filter((m) => m.startsWith("eth_send"))).toEqual([]);
  });

  it("simulates a URI update for an identity this key owns", async () => {
    const sent: string[] = [];
    const result = await registerDesk({ ...clients(account.address, sent), registry: REGISTRY, input: deskInput, agentId: 12n, broadcast: false });
    expect(result).toMatchObject({ mode: "simulated", agentId: 12n });
    expect(sent.filter((m) => m.startsWith("eth_send"))).toEqual([]);
  });

  it("explains a revert caused by a signer with code", async () => {
    const delegated: Hex = "0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a";
    await expect(
      registerDesk({ ...clients(account.address, [], delegated), registry: REGISTRY, input: deskInput, broadcast: false }),
    ).rejects.toThrow(/has code \(0xef0100.*use a plain EOA/);
  });

  it("refuses to update an identity owned by someone else", async () => {
    const other = "0x000000000000000000000000000000000000dEaD";
    await expect(
      registerDesk({ ...clients(other, []), registry: REGISTRY, input: deskInput, agentId: 12n, broadcast: false }),
    ).rejects.toThrow(/owned by/);
  });
});
