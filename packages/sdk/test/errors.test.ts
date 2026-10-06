import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Hex } from "viem";
import { ballastAccountBaseAbi, ballastErrorsAbi, decodeBallastError, Reason } from "../src/index";
import { addr, FakeChain } from "./fake-chain";

const enc = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: ballastErrorsAbi, errorName, args } as never) as Hex;

describe("decodeBallastError", () => {
  it("decodes RestoreRefused with the oracle reason", () => {
    const e = decodeBallastError(enc("RestoreRefused", [Reason.NOT_REGULAR]));
    expect(e).toMatchObject({ name: "RestoreRefused", args: [3], reason: "NOT_REGULAR" });
    expect(e?.message).toMatch(/NOT_REGULAR/);
    expect(e?.message).toMatch(/regular session/);
  });

  it("decodes NotInShieldWindow", () => {
    const e = decodeBallastError(enc("NotInShieldWindow"));
    expect(e?.name).toBe("NotInShieldWindow");
    expect(e?.message).toMatch(/closure/);
  });

  it("decodes CushionFirst in both candidate shapes", () => {
    const fragments = ballastErrorsAbi.filter((f) => f.name === "CushionFirst");
    expect(fragments.length).toBeGreaterThan(0);
    for (const f of fragments) {
      const data = encodeErrorResult({ abi: [f], errorName: "CushionFirst", args: f.inputs.map(() => 5n * 10n ** 18n) } as never);
      const e = decodeBallastError(data);
      expect(e?.name).toBe("CushionFirst");
      expect(e?.message).toMatch(/cushion/i);
    }
  });

  it("decodes ExceedsMandate with percentages", () => {
    const e = decodeBallastError(enc("ExceedsMandate", [6500n, 6000n]));
    expect(e).toMatchObject({ name: "ExceedsMandate", args: [6500n, 6000n] });
    expect(e?.message).toMatch(/65\.00%/);
    expect(e?.message).toMatch(/60\.00%/);
  });

  it("decodes Error(string) and unknown selectors", () => {
    const str = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["boom"],
    });
    expect(decodeBallastError(str)).toMatchObject({ name: "Error", message: "boom" });
    expect(decodeBallastError("0xdeadbeef")).toMatchObject({ name: "UnknownError", selector: "0xdeadbeef" });
    expect(decodeBallastError("0x")).toBeNull();
    expect(decodeBallastError(undefined)).toBeNull();
  });

  it("finds the revert data inside a viem error from a failed call", async () => {
    const account = addr(0xd1);
    const chain = new FakeChain().revert(account, ballastAccountBaseAbi, "restore", [1n], enc("RestoreRefused", [Reason.WINDOW_AHEAD]));
    const err = await chain
      .client()
      .simulateContract({ address: account, abi: ballastAccountBaseAbi, functionName: "restore", args: [1n], account: addr(0xb2) })
      .catch((e: unknown) => e);
    const e = decodeBallastError(err);
    expect(e).toMatchObject({ name: "RestoreRefused", reason: "WINDOW_AHEAD" });
  });
});
