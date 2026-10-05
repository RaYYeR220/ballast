import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders, signWeb3 } from "../src/sign";

const TS = "2026-05-11T10:08:57.715Z";

describe("signWeb3", () => {
  it("checks the prehash order (timestamp, method, path, body) by recomputing the HMAC", () => {
    // Same inputs as binance-web3-connector-js common/tests/UtilsTest.test.ts
    const sig = signWeb3("test-secret", TS, "GET", "/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT", "");
    const expected = createHmac("sha256", "test-secret")
      .update(`${TS}GET/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT`, "utf8")
      .digest("base64");
    expect(sig).toBe(expected);
  });

  it("signs the /build-prefixed GET path with its query", () => {
    const sig = signWeb3(
      "test-secret",
      TS,
      "GET",
      "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
      "",
    );
    expect(sig).toBe("UURHVMLZ2+lXmZA6GxRyYODUjbudS6GKgfDwHcy7czM=");
  });

  it("includes the exact JSON body for POST", () => {
    const body =
      '{"binanceChainId":"56","evmTx":{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","value":"0","data":"0x"}}';
    expect(signWeb3("test-secret", TS, "POST", "/build/api/v1/dex/pre-transaction/simulate", body)).toBe(
      "w7LZmgwtT1TSZ5nrKO8Zy90X436jeTXUdFYVWpbcXK0=",
    );
  });

  it("uppercases the method", () => {
    expect(signWeb3("k", TS, "get", "/build/x", "")).toBe(signWeb3("k", TS, "GET", "/build/x", ""));
  });
});

describe("buildAuthHeaders", () => {
  it("emits the X-OC headers with an ISO-8601 millisecond timestamp", () => {
    const h = buildAuthHeaders({
      apiKey: "key",
      apiSecret: "test-secret",
      method: "GET",
      requestPath: "/build/api/v1/dex/market/rwa/platforms",
      body: "",
      now: new Date(TS),
      recvWindowMs: 10000,
      nonce: "n-1",
    });
    expect(h["X-OC-APIKEY"]).toBe("key");
    expect(h["X-OC-TIMESTAMP"]).toBe(TS);
    expect(h["X-OC-SIGN"]).toBe("UVGTkSnsGb3BeBP7xp2V9+ldmd1QCHuZSWmhnkke/EA=");
    expect(h["X-OC-RECV-WINDOW"]).toBe("10000");
    expect(h["X-OC-NONCE"]).toBe("n-1");
  });
});
