import { mnemonicValidate } from "@polkadot/util-crypto";

export function isMnemonicValid(mnemonic: string): boolean {
  return mnemonicValidate(mnemonic.trim());
}
