import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { bscConfig } from "@ballast/risk";
import { loadDeployment, parseDeployment } from "../src/index";
import { addr } from "./fake-chain";

const json = {
  owner: addr(0xa0).toLowerCase(),
  calendar: addr(0xa1).toLowerCase(),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
  block: 123,
};

describe("deployments", () => {
  it("parses a deployment and attaches BSC external addresses", () => {
    const d = parseDeployment(56, json);
    expect(d.chainId).toBe(56);
    expect(d.calendar).toBe(addr(0xa1)); // checksummed
    expect(d.owner).toBe(addr(0xa0));
    expect(d.block).toBe(123);
    expect(d.external.kernel).toBe(getAddress(bscConfig.erc8183.kernel));
    expect(d.external.moolah).toBe(getAddress(bscConfig.lista.moolah));
    expect(d.external.tokens.USD1).toBe(getAddress(bscConfig.tokens.USD1));
    expect(d.external.multicall3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });

  it("rejects a deployment with a missing or malformed address", () => {
    const { factory: _f, ...missing } = json;
    expect(() => parseDeployment(56, missing)).toThrow(/factory/);
    expect(() => parseDeployment(56, { ...json, guardian: "0x1234" })).toThrow(/guardian/);
  });

  it("needs explicit external addresses off BSC mainnet and its fork", () => {
    expect(() => parseDeployment(97, json)).toThrow(/external/);
  });

  it("loads a deployment file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ballast-sdk-"));
    const file = join(dir, "31337.json");
    writeFileSync(file, JSON.stringify(json));
    const d = loadDeployment(31337, { file });
    expect(d.chainId).toBe(31337);
    expect(d.guardian).toBe(addr(0xa8));
    expect(() => loadDeployment(31337, { file: join(dir, "missing.json") })).toThrow(/deployment/);
  });
});

describe("guardianStartJobId", () => {
  const base = { owner: addr(0xa0), calendar: addr(0xa1), sessionOracle: addr(0xa2), sessionAwareFeed: addr(0xa3), factory: addr(0xa4), listaImpl: addr(0xa5), venusImpl: addr(0xa6), cushionVault: addr(0xa7), guardian: addr(0xa8), block: 1 };
  it("is optional and parsed as a bigint", () => {
    expect(parseDeployment(31337, base).guardianStartJobId).toBeUndefined();
    expect(parseDeployment(31337, { ...base, guardianStartJobId: "123456789012345678901" }).guardianStartJobId).toBe(123456789012345678901n);
    expect(parseDeployment(31337, { ...base, guardianStartJobId: 7 }).guardianStartJobId).toBe(7n);
  });
  it("rejects a bad value", () => {
    expect(() => parseDeployment(31337, { ...base, guardianStartJobId: "abc" })).toThrow(/guardianStartJobId/);
    expect(() => parseDeployment(31337, { ...base, guardianStartJobId: -1 })).toThrow(/guardianStartJobId/);
  });
});
