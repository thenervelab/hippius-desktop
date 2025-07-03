import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

export async function generateMnemonic(): Promise<string> {
  await cryptoWaitReady();
  return mnemonicGenerate();
}
