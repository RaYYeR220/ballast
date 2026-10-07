import { describe, expect, it } from "vitest";
import { deskPublicClient } from "../src/desk/client";
import { loadConfig } from "../src/desk/config";

describe("deskPublicClient", () => {
  it("never serves a cached block number, so a pre-send re-read sees the head", () => {
    const c = deskPublicClient(loadConfig({ CHAIN_ID: "31337", BSC_RPC_URL: "http://127.0.0.1:8545", AGENT_PRIVATE_KEY: `0x${"4f".repeat(32)}` }));
    expect(c.cacheTime).toBe(0);
    expect(c.chain?.id).toBe(31337);
  });
});
