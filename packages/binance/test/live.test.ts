import { describe, expect, it } from "vitest";
import { Web3Client, rwa, transaction } from "../src";

const live = process.env.BINANCE_WEB3_API_KEY ? describe : describe.skip;

live("live Web3 API (needs key; run from an allowed egress region)", () => {
  const c = Web3Client.fromEnv();
  it("RWA price for NVDAB", async () => {
    const p = await rwa.price(c, "56", ["0x02fca66c1d1afb4e2a7884261eb00f63598a7436"]);
    expect(Number(p[0]!.tokenPrice)).toBeGreaterThan(0);
  });
  it("simulates a zero-value self-call", async () => {
    const r = await transaction.simulate(c, {
      binanceChainId: "56",
      evmTx: { from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000001", value: "0", data: "0x" },
    });
    expect(["SUCCESS", "FAILED"]).toContain(r.status);
  });
});
