import CryptoJS from "crypto-js";

/** Hash password with SHA256 */
export function hashPassword(password: string): string {
  return CryptoJS.SHA256(password).toString();
}

/** Encrypt mnemonic with password */
export function encryptMnemonic(mnemonic: string, password: string): string {
  return CryptoJS.AES.encrypt(mnemonic, password).toString();
}

/** Decrypt mnemonic with password */
export function decryptMnemonic(encrypted: string, password: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, password);
  return bytes.toString(CryptoJS.enc.Utf8);
}
