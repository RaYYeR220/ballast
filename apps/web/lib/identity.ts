/* The desk agent's public identity: its ERC-8004 registration on BNB Chain and the key that publishes the
   Session Oracle overlay, keeps accounts and takes guardian jobs. Nothing here is trusted as is: the pages read
   the registry and show whether the chain agrees. Client-safe. */
import { bscConfig } from "@ballast/risk";
import { getAddress, type Address } from "viem";

export const IDENTITY_REGISTRY: Address = getAddress(bscConfig.erc8004.identity);
export const REPUTATION_REGISTRY: Address = getAddress(bscConfig.erc8004.reputation);
export const KERNEL: Address = getAddress(bscConfig.erc8183.kernel);

/** The desk's ERC-8004 agent id on BNB Chain. */
export const DESK_AGENT_ID = 368122n;
/** The desk's key (publisher, keeper and guardian provider). */
export const DESK_ADDRESS: Address = getAddress("0xccD7f069275549793b2A8804A5691fCa6665D152");

/** Tags the guardian contract writes its feedback under (BallastGuardian._feedback). */
export const GUARD_TAGS = { tag1: "ballast-guard", tag2: "window" } as const;

const SCAN = "https://bscscan.com";

/** BscScan page of an ERC-8004 identity (an ERC-721 token of the registry). */
export const identityUrl = (agentId: bigint | string) => `${SCAN}/nft/${IDENTITY_REGISTRY}/${agentId.toString()}`;
export const scanAddress = (address: string) => `${SCAN}/address/${address}`;
export const scanTx = (hash: string) => `${SCAN}/tx/${hash}`;

export interface IdentityView {
  agentId: string;
  registry: Address;
  /** ownerOf(agentId) on the registry; null when it could not be read */
  owner: Address | null;
  /** getAgentWallet(agentId); null when unset or unreadable */
  wallet: Address | null;
  /** the registry's owner or agent wallet is the desk key this app names */
  matchesDesk: boolean | null;
  error?: string;
}
