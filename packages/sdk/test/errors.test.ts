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

  it("decodes NoDebt from the vault and knows no CushionFirst any more", () => {
    expect(decodeBallastError(enc("NoDebt"))).toMatchObject({ name: "NoDebt", message: expect.stringMatching(/no debt/) });
    expect(ballastErrorsAbi.some((f) => f.name === ("CushionFirst" as string))).toBe(false);
  });

  it("never throws, even on a reason this SDK does not know or malformed input", () => {
    const e = decodeBallastError(enc("RestoreRefused", [99]));
    expect(e).toMatchObject({ name: "RestoreRefused", reason: "UNKNOWN(99)" });
    expect(e?.message).toMatch(/UNKNOWN\(99\)/);
    const truncated = enc("ExceedsMandate", [1n, 2n]).slice(0, 20) as Hex;
    expect(decodeBallastError(truncated)).toMatchObject({ name: "UnknownError", selector: truncated.slice(0, 10) });
    expect(decodeBallastError({ cause: { cause: { data: "0x12" } } })).toBeNull();
    expect(decodeBallastError(42)).toBeNull();
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
