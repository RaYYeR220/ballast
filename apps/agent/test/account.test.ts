import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadAccount } from "../src/desk/account";
import { Secret } from "../src/desk/config";

const PK: Hex = `0x${"4f".repeat(32)}`;
const ADDRESS = privateKeyToAccount(PK).address;
const dir = mkdtempSync(path.join(tmpdir(), "desk-keystore-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A Web3 Secret Storage v3 file in the Studio layout, with a tiny scrypt cost so the test stays fast. */
function writeKeystore(name: string, password: string, address: string = ADDRESS): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: 16, r: 8, p: 1 });
  const cipher = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(PK)), cipher.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2);
  const file = path.join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      id: "00000000-0000-4000-8000-000000000000",
      address: address.slice(2).toLowerCase(),
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: iv.toString("hex") },
        ciphertext: ciphertext.toString("hex"),
        kdf: "scrypt",
        kdfparams: { dklen: 32, n: 16, r: 8, p: 1, salt: salt.toString("hex") },
        mac,
      },
    }),
  );
  return file;
}

describe("loadAccount", () => {
  it("uses a raw private key", async () => {
    const account = await loadAccount({ kind: "private-key", privateKey: new Secret(PK) });
    expect(account.address).toBe(ADDRESS);
  });

  it("decrypts a Studio-format keystore", async () => {
    const file = writeKeystore("ok.json", "correct horse");
    const account = await loadAccount({ kind: "keystore", path: file, password: new Secret("correct horse") });
    expect(account.address).toBe(ADDRESS);
  });

  it("fails on a wrong password", async () => {
    const file = writeKeystore("pw.json", "correct horse");
    await expect(loadAccount({ kind: "keystore", path: file, password: new Secret("wrong") })).rejects.toThrow(/MAC mismatch/);
  });

  it("fails when the keystore declares another address", async () => {
    const file = writeKeystore("other.json", "pw", "0x000000000000000000000000000000000000dEaD");
    await expect(loadAccount({ kind: "keystore", path: file, password: new Secret("pw") })).rejects.toThrow(/declares/);
  });
});
