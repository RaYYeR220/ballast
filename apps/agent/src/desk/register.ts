import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bscConfig } from "@ballast/risk";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { loadAccount } from "./account";
import { DESK_CHAINS, loadConfig, redactUrl, type DeskChainId } from "./config";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const DESK_NAME = "Ballast Risk Desk";
export const DESK_DESCRIPTION =
  "Keeps bStock-backed loans on Lista and Venus gap-survivable across closed US market windows. " +
  "Publishes the Session Oracle overlay, shields Ballast accounts before each close and earnings, " +
  "restores them after the open and settles ERC-8183 guardian jobs. " +
  "Every action is deterministic code inside limits the Ballast contracts enforce.";

/** A2A discovery document path and the protocol version the Studio runtime serves. */
export const A2A_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_VERSION = "0.3.0";
/** The MCP protocol version the Ballast MCP server (packages/mcp) speaks. */
export const MCP_VERSION = "2025-11-25";
/** Custom service name for the desk's read API (health, feed, accounts, oracle, ledger, evidence). */
export const DESK_API_SERVICE = "desk-api";

/** ERC-8004 identity registry per desk chain; the anvil fork carries the mainnet registry. */
export const IDENTITY_REGISTRY: Record<DeskChainId, Address> = {
  56: getAddress(bscConfig.erc8004.identity),
  97: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  31337: getAddress(bscConfig.erc8004.identity),
};

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export interface RegistrationService {
  name: string;
  endpoint: string;
  version?: string;
}

export interface Registration {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image?: string;
  services: RegistrationService[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
}

export interface RegistrationInput {
  chainId: number;
  identityRegistry: Address;
  /** The desk key: publisher, keeper and guardian provider. */
  agentWallet: Address;
  /** The public Ballast web app. */
  webUrl: string;
  /** The public MCP endpoint (Streamable HTTP), in full. Listed only when given: give it only when it answers. */
  mcpUrl?: string;
  /** Base URL of the desk's public read API, listed as the custom "desk-api" service. */
  apiUrl?: string;
  /** The Agent Studio A2A face: its base URL or the URL of its agent card. Leave it out while that face is not public. */
  a2aUrl?: string;
  /** Whether the file says the agent supports x402. Default false: say so only when it is true of the public desk. */
  x402Support?: boolean;
  /** Known only after the mint; until then `registrations` stays empty. */
  agentId?: bigint | number;
  name?: string;
  description?: string;
  image?: string;
}

function httpUrl(label: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${label} must be an http(s) URL`);
  if (u.username || u.password) throw new Error(`${label} must not carry credentials`);
  return u;
}

/** An endpoint as it goes into the file: no query, no fragment, no trailing slash. */
function endpoint(label: string, raw: string): string {
  const u = httpUrl(label, raw);
  if (u.search || u.hash) throw new Error(`${label} must not carry a query or a fragment`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function a2aCard(raw: string): string {
  const base = endpoint("a2aUrl", raw);
  return base.endsWith("/agent-card.json") ? base : `${base}${A2A_CARD_PATH}`;
}

function toSafeNumber(id: bigint | number): number {
  const n = typeof id === "bigint" ? Number(id) : id;
  if (!Number.isSafeInteger(n) || n < 0 || BigInt(n) !== BigInt(id)) throw new Error(`agentId ${id} is not a safe integer`);
  return n;
}

/**
 * Builds the ERC-8004 registration file for the desk. Pure: no I/O. Besides the web app and the agent wallet
 * it lists exactly the endpoints it is given, so the file never advertises a service that is not there.
 */
export function buildRegistration(input: RegistrationInput): Registration {
  const registry = getAddress(input.identityRegistry);
  if (input.mcpUrl !== undefined && !/\/mcp$/.test(endpoint("mcpUrl", input.mcpUrl))) throw new Error("mcpUrl must be the full endpoint, ending in /mcp");
  const reg: Registration = {
    type: REGISTRATION_TYPE,
    name: input.name ?? DESK_NAME,
    description: input.description ?? DESK_DESCRIPTION,
    ...(input.image ? { image: httpUrl("image", input.image).toString() } : {}),
    services: [
      { name: "web", endpoint: httpUrl("webUrl", input.webUrl).toString() },
      ...(input.mcpUrl === undefined ? [] : [{ name: "MCP", endpoint: endpoint("mcpUrl", input.mcpUrl), version: MCP_VERSION }]),
      ...(input.apiUrl === undefined ? [] : [{ name: DESK_API_SERVICE, endpoint: endpoint("apiUrl", input.apiUrl) }]),
      ...(input.a2aUrl === undefined ? [] : [{ name: "A2A", endpoint: a2aCard(input.a2aUrl), version: A2A_VERSION }]),
      { name: "agentWallet", endpoint: `eip155:${input.chainId}:${getAddress(input.agentWallet)}` },
    ],
    x402Support: input.x402Support ?? false,
    active: true,
    registrations:
      input.agentId === undefined
        ? []
        : [{ agentId: toSafeNumber(input.agentId), agentRegistry: `eip155:${input.chainId}:${registry}` }],
  };
  return reg;
}

const DATA_URI_PREFIX = "data:application/json;base64,";

/** On-chain agentURI: the registration as a base64 JSON data URI, like the Studio SDK writes. */
export function encodeAgentURI(reg: Registration): string {
  return DATA_URI_PREFIX + Buffer.from(JSON.stringify(reg), "utf8").toString("base64");
}

export function decodeAgentURI(uri: string): Registration {
  if (!uri.startsWith(DATA_URI_PREFIX)) throw new Error("agentURI is not a base64 JSON data URI");
  return JSON.parse(Buffer.from(uri.slice(DATA_URI_PREFIX.length), "base64").toString("utf8")) as Registration;
}

export interface RegisterOptions {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  registry: Address;
  input: Omit<RegistrationInput, "agentId" | "identityRegistry">;
  /** Existing identity: only its agentURI is rewritten. */
  agentId?: bigint;
  /** False simulates every call and stops before the first transaction. */
  broadcast: boolean;
  log?: (line: string) => void;
}

export type RegisterResult =
  | { mode: "simulated"; agentId: bigint; registration: Registration }
  | { mode: "broadcast"; agentId: bigint; registerTx: Hex | null; setUriTx: Hex; registration: Registration };

async function confirmed(publicClient: PublicClient, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/**
 * Mints (or updates) the desk identity. A new identity takes two transactions: register() with the
 * registration minus `registrations`, then setAgentURI() once the minted agentId is known.
 * Every write is simulated with eth_call first.
 */
export async function registerDesk(opts: RegisterOptions): Promise<RegisterResult> {
  const { publicClient, walletClient, registry, broadcast } = opts;
  const log = opts.log ?? (() => {});
  const account = walletClient.account;
  const input = { ...opts.input, identityRegistry: registry };

  let agentId = opts.agentId;
  let registerTx: Hex | null = null;

  if (agentId === undefined) {
    // The registry mints with ERC-721 safeMint, so an owner with code (for example an EIP-7702
    // delegation) must implement onERC721Received or register() reverts with empty data.
    const code = await publicClient.getCode({ address: account.address });
    const hasCode = code !== undefined && code !== "0x";
    const firstUri = encodeAgentURI(buildRegistration(input));
    const sim = await publicClient
      .simulateContract({ address: registry, abi: identityRegistryAbi, functionName: "register", args: [firstUri], account })
      .catch((err: unknown) => {
        if (!hasCode) throw err;
        throw new Error(`register() reverted; the signer ${account.address} has code (${code!.slice(0, 48)}), use a plain EOA`, { cause: err });
      });
    log(`register simulated: next agentId ${sim.result}`);
    if (!broadcast) return { mode: "simulated", agentId: sim.result, registration: buildRegistration({ ...input, agentId: sim.result }) };

    const receipt = await confirmed(publicClient, await walletClient.writeContract(sim.request));
    registerTx = receipt.transactionHash;
    const minted = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs: receipt.logs }).find(
      (l) => getAddress(l.address) === getAddress(registry) && getAddress(l.args.owner) === account.address,
    );
    if (!minted) throw new Error(`register tx ${registerTx} emitted no Registered event for ${account.address}`);
    agentId = minted.args.agentId;
    log(`registered agentId ${agentId} in ${registerTx}`);
  } else {
    const owner = await publicClient.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] });
    if (getAddress(owner) !== account.address) throw new Error(`agentId ${agentId} is owned by ${owner}, not ${account.address}`);
  }

  const registration = buildRegistration({ ...input, agentId });
  const finalUri = encodeAgentURI(registration);
  const sim = await publicClient.simulateContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [agentId, finalUri],
    account,
  });
  log(`setAgentURI simulated for agentId ${agentId}`);
  if (!broadcast) return { mode: "simulated", agentId, registration };

  const receipt = await confirmed(publicClient, await walletClient.writeContract(sim.request));
  const stored = await publicClient.readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] });
  if (stored !== finalUri) throw new Error(`agentId ${agentId}: tokenURI does not match the URI just written`);
  log(`agentURI set in ${receipt.transactionHash}`);
  return { mode: "broadcast", agentId, registerTx, setUriTx: receipt.transactionHash, registration };
}

const USAGE = `usage: register --web-url <app url> [--mcp-url <url ending in /mcp>] [--api-url <desk read API base url>]
                [--a2a-url <Studio face base url>] [--x402-support] [--image <url>] [--agent-id <id>] [--confirm-mainnet]
  The file lists the web app, the agent wallet and only the endpoints named here: name an endpoint only when it answers.
  --agent-id rewrites the agentURI of an identity the signer owns; without it a new identity is minted.
  env: CHAIN_ID, BSC_RPC_URL, AGENT_PRIVATE_KEY or AGENT_KEYSTORE_PATH + AGENT_KEYSTORE_PASSWORD,
       DRY_RUN (default true: simulate only and print the file). APP_URL stands in for --web-url.
  Stop the desk while this runs with DRY_RUN=false: one sender per key.`;

export interface RegisterCli {
  help: boolean;
  confirmMainnet: boolean;
  agentId?: bigint;
  /** What the registration file is built from, besides the chain and the signer. */
  endpoints: Pick<RegistrationInput, "webUrl" | "mcpUrl" | "apiUrl" | "a2aUrl" | "image" | "x402Support">;
}

/** The command line of the register script. Throws the usage text when the web URL is missing. */
export function parseRegisterArgs(argv: string[], env: Record<string, string | undefined> = process.env): RegisterCli {
  const { values } = parseArgs({
    args: argv,
    options: {
      "web-url": { type: "string" },
      "mcp-url": { type: "string" },
      "api-url": { type: "string" },
      "a2a-url": { type: "string" },
      "agent-url": { type: "string" },
      "agent-id": { type: "string" },
      image: { type: "string" },
      "x402-support": { type: "boolean", default: false },
      "confirm-mainnet": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values["agent-url"] !== undefined) {
    throw new Error("--agent-url is gone: it advertised /mcp and an A2A card whether or not they were served. Name each public endpoint with --mcp-url, --api-url and --a2a-url.");
  }
  const webUrl = values["web-url"] ?? env.APP_URL;
  if (values.help) return { help: true, confirmMainnet: false, endpoints: { webUrl: webUrl ?? "" } };
  if (!webUrl) throw new Error(USAGE);
  const rawId = values["agent-id"];
  if (rawId !== undefined && !/^\d+$/.test(rawId)) throw new Error("--agent-id must be a whole number");
  return {
    help: false,
    confirmMainnet: values["confirm-mainnet"] === true,
    ...(rawId === undefined ? {} : { agentId: BigInt(rawId) }),
    endpoints: {
      webUrl,
      ...(values["mcp-url"] === undefined ? {} : { mcpUrl: values["mcp-url"] }),
      ...(values["api-url"] === undefined ? {} : { apiUrl: values["api-url"] }),
      ...(values["a2a-url"] === undefined ? {} : { a2aUrl: values["a2a-url"] }),
      ...(values.image === undefined ? {} : { image: values.image }),
      x402Support: values["x402-support"] === true,
    },
  };
}

/** On a public chain every endpoint in the file must be https. */
export function assertPublicEndpoints(chainId: number, e: RegisterCli["endpoints"]): void {
  if (chainId === 31337) return;
  for (const [name, url] of Object.entries({ "--web-url": e.webUrl, "--mcp-url": e.mcpUrl, "--api-url": e.apiUrl, "--a2a-url": e.a2aUrl, "--image": e.image })) {
    if (url !== undefined && !url.trim().toLowerCase().startsWith("https://")) throw new Error(`${name}: public chains need https endpoints`);
  }
}

async function main(argv: string[]): Promise<void> {
  const cli = parseRegisterArgs(argv);
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const broadcast = !config.dryRun;
  assertPublicEndpoints(config.chainId, cli.endpoints);
  if (broadcast && config.chainId === 56 && !cli.confirmMainnet) {
    throw new Error("DRY_RUN=false on BSC mainnet also needs --confirm-mainnet");
  }

  const rpc = config.rpcUrl.reveal();
  const chain = defineChain({
    id: config.chainId,
    name: DESK_CHAINS[config.chainId],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = await loadAccount(config.signer);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ chain, transport: http(rpc), account });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== config.chainId) throw new Error(`RPC reports chain ${rpcChainId} but CHAIN_ID is ${config.chainId}`);

  console.log(`desk ${config.describe()}`);
  console.log(`signer ${account.address}, registry ${IDENTITY_REGISTRY[config.chainId]}, ${broadcast ? "broadcasting" : "simulation only"}`);
  const result = await registerDesk({
    publicClient,
    walletClient,
    registry: IDENTITY_REGISTRY[config.chainId],
    input: { chainId: config.chainId, agentWallet: account.address, ...cli.endpoints },
    agentId: cli.agentId,
    broadcast,
    log: (line) => console.log(line),
  });
  const { registration, ...outcome } = result;
  console.log(`registration file${broadcast ? " now on-chain" : " (DRY RUN: this is what would be written; nothing was sent)"}:`);
  console.log(JSON.stringify(registration, null, 2));
  console.log(`agentURI: ${encodeAgentURI(registration).length} characters (base64 JSON data URI)`);
  console.log(JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(path.resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const rpc = process.env.BSC_RPC_URL;
    let message = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
    if (rpc) message = message.split(rpc).join(redactUrl(rpc));
    console.error(message);
    process.exitCode = 1;
  });
}
