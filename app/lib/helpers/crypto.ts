import CryptoJS from "crypto-js";

/** Hash passcode with SHA256 */
export function hashPasscode(passcode: string): string {
  return CryptoJS.SHA256(passcode).toString();
}

/** Encrypt mnemonic with passcode */
export function encryptMnemonic(mnemonic: string, passcode: string): string {
  return CryptoJS.AES.encrypt(mnemonic, passcode).toString();
}

/** Decrypt mnemonic with passcode */
export function decryptMnemonic(encrypted: string, passcode: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, passcode);
  return bytes.toString(CryptoJS.enc.Utf8);
}
