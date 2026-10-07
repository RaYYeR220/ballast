import { readFile } from "node:fs/promises";
import { decryptKeystoreV3, type KeystoreV3 } from "@bnbagent/sdk/wallets";
import { bytesToHex, getAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { SignerSource } from "./config";

/**
 * Turns the configured signer into a viem account. A keystore is a Web3 Secret Storage v3 file,
 * the same format Agent Studio writes to .studio/wallets/, decrypted with the Studio SDK.
 */
export async function loadAccount(signer: SignerSource): Promise<PrivateKeyAccount> {
  if (signer.kind === "private-key") return privateKeyToAccount(signer.privateKey.reveal() as Hex);

  const keystore = JSON.parse(await readFile(signer.path, "utf8")) as KeystoreV3;
  const key = decryptKeystoreV3(keystore, signer.password.reveal());
  const account = privateKeyToAccount(bytesToHex(key));
  key.fill(0);
  if (keystore.address) {
    const declared = getAddress(`0x${keystore.address.replace(/^0x/i, "")}`);
    if (declared !== account.address) throw new Error(`keystore ${signer.path} declares ${declared} but decrypts to ${account.address}`);
  }
  return account;
}
