import { describe, expect, it } from "vitest";
import { bytesToHex, type Hex } from "viem";
import { bytecodeMismatch, comparableCode } from "../../../scripts/verify-onchain";

// 40 bytes of code, an 8-byte "metadata" blob, then its length (0x0008) as the last two bytes.
const code = (fill: number, meta: number, patch: Record<number, number> = {}): Hex => {
  const b = new Uint8Array(50);
  b.fill(fill, 0, 40);
  b.fill(meta, 40, 48);
  b[48] = 0;
  b[49] = 8;
  for (const [i, v] of Object.entries(patch)) b[Number(i)] = v;
  return bytesToHex(b);
};
const artifact = (object: Hex, refs: { start: number; length: number }[] = [], linkReferences: Record<string, unknown> = {}) => ({
  deployedBytecode: { object, immutableReferences: (refs.length ? { "17": refs } : {}) as Record<string, { start: number; length: number }[]>, linkReferences },
});

describe("verify-onchain bytecode comparison", () => {
  it("cuts the CBOR metadata and zeroes the immutable ranges", () => {
    const c = comparableCode(code(0xaa, 0x11), [{ start: 4, length: 3 }]);
    expect(c).toHaveLength(40);
    expect([...c.subarray(3, 8)]).toEqual([0xaa, 0, 0, 0, 0xaa]);
  });

  it("accepts code that differs only in immutables and metadata", () => {
    const built = code(0xaa, 0x11);
    const onchain = code(0xaa, 0x22, { 10: 0x5f, 11: 0x60, 30: 0x01 });
    const refs = [
      { start: 10, length: 2 },
      { start: 30, length: 1 },
    ];
    expect(bytecodeMismatch(onchain, artifact(built, refs))).toBeNull();
  });

  it("rejects one changed code byte, a different length and unlinked libraries", () => {
    const built = code(0xaa, 0x11);
    expect(bytecodeMismatch(code(0xaa, 0x11, { 20: 0xab }), artifact(built))).toMatch(/code hash/);
    // a byte just outside an immutable range still counts
    expect(bytecodeMismatch(code(0xaa, 0x11, { 12: 0x01 }), artifact(built, [{ start: 10, length: 2 }]))).toMatch(/code hash/);
    expect(bytecodeMismatch(`${built}00`, artifact(built))).toMatch(/length 51 bytes on-chain, 50 in the artifact/);
    expect(bytecodeMismatch("0x", artifact(built))).toMatch(/length 0 bytes/);
    expect(bytecodeMismatch(built, artifact(built, [], { "src/Lib.sol": {} }))).toMatch(/unlinked/);
  });
});
