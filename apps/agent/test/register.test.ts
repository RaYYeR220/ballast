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
  assertPublicEndpoints,
  buildRegistration,
  decodeAgentURI,
  encodeAgentURI,
  identityRegistryAbi,
  parseRegisterArgs,
  registerDesk,
} from "../src/desk/register";

const WALLET: Address = "0x1234567890AbcdEF1234567890aBcdef12345678";
const REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const input = {
  chainId: 56,
  identityRegistry: REGISTRY,
  agentWallet: WALLET,
  webUrl: "https://ballast.example",
};
const everything = { ...input, mcpUrl: "https://desk.ballast.example/mcp", apiUrl: "https://desk.ballast.example/", a2aUrl: "https://studio.ballast.example/" };

describe("buildRegistration", () => {
  it("builds the ERC-8004 registration file before the mint", () => {
    expect(buildRegistration(input)).toEqual({
      type: REGISTRATION_TYPE,
      name: DESK_NAME,
      description: expect.stringContaining("Session Oracle overlay"),
      services: [
        { name: "web", endpoint: "https://ballast.example/" },
        { name: "agentWallet", endpoint: `eip155:56:${WALLET}` },
      ],
      x402Support: false,
      active: true,
      registrations: [],
    });
  });

  it("lists an endpoint only when it is given, and nothing it was not given", () => {
    expect(buildRegistration(everything).services).toEqual([
      { name: "web", endpoint: "https://ballast.example/" },
      { name: "MCP", endpoint: "https://desk.ballast.example/mcp", version: "2025-11-25" },
      { name: "desk-api", endpoint: "https://desk.ballast.example" },
      { name: "A2A", endpoint: "https://studio.ballast.example/.well-known/agent-card.json", version: "0.3.0" },
      { name: "agentWallet", endpoint: `eip155:56:${WALLET}` },
    ]);
    // The desk as it runs today: a web app, the MCP endpoint and the read API, no public A2A face.
    const names = (i: Parameters<typeof buildRegistration>[0]) => buildRegistration(i).services.map((s) => s.name);
    expect(names({ ...input, mcpUrl: everything.mcpUrl, apiUrl: everything.apiUrl })).toEqual(["web", "MCP", "desk-api", "agentWallet"]);
    expect(names({ ...input, apiUrl: everything.apiUrl })).toEqual(["web", "desk-api", "agentWallet"]);
    expect(names({ ...input, a2aUrl: everything.a2aUrl })).toEqual(["web", "A2A", "agentWallet"]);
    expect(JSON.stringify(buildRegistration({ ...input, apiUrl: everything.apiUrl }))).not.toMatch(/mcp|agent-card/i);
  });

  it("says x402 is supported only when told so", () => {
    expect(buildRegistration(everything).x402Support).toBe(false);
    expect(buildRegistration({ ...everything, x402Support: true }).x402Support).toBe(true);
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
      mcpUrl: "http://127.0.0.1:8790/mcp/",
      apiUrl: "http://127.0.0.1:8787//",
      a2aUrl: "http://127.0.0.1:9000/desk//",
      agentId: 7,
    });
    expect(reg.services[1]!.endpoint).toBe("http://127.0.0.1:8790/mcp");
    expect(reg.services[2]!.endpoint).toBe("http://127.0.0.1:8787");
    expect(reg.services[3]!.endpoint).toBe("http://127.0.0.1:9000/desk/.well-known/agent-card.json");
    expect(reg.services[4]!.endpoint).toBe(`eip155:31337:${WALLET}`);
    // A card URL is taken as it is.
    expect(buildRegistration({ ...input, a2aUrl: "https://studio.example/.well-known/agent-card.json" }).services[1]!.endpoint).toBe("https://studio.example/.well-known/agent-card.json");
    expect(reg.registrations[0]!.agentRegistry).toBe(`eip155:31337:${REGISTRY}`);
  });

  it("adds an image only when one is given", () => {
    expect("image" in buildRegistration(input)).toBe(false);
    expect(buildRegistration({ ...input, image: "https://ballast.example/desk.png" }).image).toBe("https://ballast.example/desk.png");
  });

  it("rejects endpoints that are not plain http(s) URLs", () => {
    expect(() => buildRegistration({ ...input, webUrl: "ftp://ballast.example" })).toThrow(/webUrl must be an http\(s\) URL/);
    expect(() => buildRegistration({ ...input, apiUrl: "https://desk.example/?q=1" })).toThrow(/apiUrl must not carry a query/);
    expect(() => buildRegistration({ ...input, a2aUrl: "https://user:pw@desk.example" })).toThrow(/a2aUrl must not carry credentials/);
    expect(() => buildRegistration({ ...input, mcpUrl: "desk" })).toThrow(/mcpUrl is not a URL/);
    expect(() => buildRegistration({ ...input, mcpUrl: "https://desk.example" })).toThrow(/ending in \/mcp/);
    expect(() => buildRegistration({ ...input, mcpUrl: "https://desk.example/mcp#x" })).toThrow(/mcpUrl must not carry a query or a fragment/);
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

  const deskInput = { chainId: 31337, agentWallet: account.address, webUrl: "http://localhost:3000", mcpUrl: "http://localhost:8790/mcp", apiUrl: "http://localhost:8787" };

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
    // The file a dry run prints: what was named on the command line, and the identity being updated.
    expect(result.registration.services.map((s) => s.name)).toEqual(["web", "MCP", "desk-api", "agentWallet"]);
    expect(result.registration.registrations).toEqual([{ agentId: 12, agentRegistry: `eip155:31337:${REGISTRY}` }]);
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

describe("register command line", () => {
  it("takes each endpoint from its own flag and lists nothing else", () => {
    const cli = parseRegisterArgs(["--agent-id", "368122", "--web-url", "https://ballast.example", "--mcp-url", "https://desk.example/mcp", "--api-url", "https://desk.example"], {});
    expect(cli).toEqual({
      help: false,
      confirmMainnet: false,
      agentId: 368122n,
      endpoints: { webUrl: "https://ballast.example", mcpUrl: "https://desk.example/mcp", apiUrl: "https://desk.example", x402Support: false },
    });
    const reg = buildRegistration({ chainId: 56, identityRegistry: REGISTRY, agentWallet: WALLET, agentId: cli.agentId, ...cli.endpoints });
    expect(reg.services.map((s) => s.name)).toEqual(["web", "MCP", "desk-api", "agentWallet"]);
    expect(reg.registrations).toEqual([{ agentId: 368122, agentRegistry: `eip155:56:${REGISTRY}` }]);
  });

  it("reads the optional flags and the APP_URL stand-in", () => {
    expect(parseRegisterArgs(["--a2a-url", "https://studio.example", "--x402-support", "--image", "https://ballast.example/d.png", "--confirm-mainnet"], { APP_URL: "https://ballast.example" })).toEqual({
      help: false,
      confirmMainnet: true,
      endpoints: { webUrl: "https://ballast.example", a2aUrl: "https://studio.example", image: "https://ballast.example/d.png", x402Support: true },
    });
    expect(parseRegisterArgs(["--help"], {}).help).toBe(true);
  });

  it("refuses a missing web URL, the old --agent-url and a bad agent id", () => {
    expect(() => parseRegisterArgs([], {})).toThrow(/usage: register --web-url/);
    expect(() => parseRegisterArgs(["--web-url", "https://ballast.example", "--agent-url", "https://desk.example"], {})).toThrow(/--agent-url is gone/);
    expect(() => parseRegisterArgs(["--web-url", "https://ballast.example", "--agent-id", "12x"], {})).toThrow(/--agent-id must be a whole number/);
    expect(() => parseRegisterArgs(["--web-url", "https://ballast.example", "--mcp"], {})).toThrow();
  });

  it("wants https for every endpoint on a public chain", () => {
    const e = { webUrl: "https://ballast.example", mcpUrl: "https://desk.example/mcp", apiUrl: "https://desk.example", x402Support: false };
    expect(() => assertPublicEndpoints(56, e)).not.toThrow();
    expect(() => assertPublicEndpoints(56, { ...e, mcpUrl: "http://desk.example/mcp" })).toThrow(/--mcp-url: public chains need https/);
    expect(() => assertPublicEndpoints(97, { ...e, apiUrl: "http://desk.example" })).toThrow(/--api-url/);
    expect(() => assertPublicEndpoints(56, { ...e, a2aUrl: "http://studio.example" })).toThrow(/--a2a-url/);
    expect(() => assertPublicEndpoints(56, { ...e, webUrl: "http://ballast.example" })).toThrow(/--web-url/);
    expect(() => assertPublicEndpoints(31337, { ...e, mcpUrl: "http://localhost:8790/mcp" })).not.toThrow();
  });
});
