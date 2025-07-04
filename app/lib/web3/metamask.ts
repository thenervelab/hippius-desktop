/* eslint-disable @typescript-eslint/no-explicit-any */
import { stringToHex, toHex } from "viem";
import { encrypt } from "@metamask/eth-sig-util";
/**
 * Encrypts data using MetaMask's encryption API
 * @param data - The data to encrypt
 * @param address - The MetaMask address to encrypt for
 * @returns The encrypted data
 */
export async function encryptWithMetaMask(
  data: string,
  address: string
): Promise<string> {
  try {
    // Get the encryption public key from MetaMask
    const provider = (window as any).ethereum;
    const encryptionPublicKey = await provider.request({
      method: "eth_getEncryptionPublicKey",
      params: [address],
    });

    // Use MetaMask's eth-sig-util to encrypt the data
    const encryptedData = encrypt({
      publicKey: encryptionPublicKey,
      data: stringToHex(data),
      version: "x25519-xsalsa20-poly1305",
    });

    // Convert to hex string for storage
    const encryptedHex = toHex(JSON.stringify(encryptedData));
    return encryptedHex;
  } catch (error) {
    console.error("Error encrypting with MetaMask:", error);
    throw error;
  }
}

/**
 * Decrypts data using MetaMask's decryption API
 * @param encryptedData - The encrypted data to decrypt
 * @param address - The MetaMask address that can decrypt
 * @returns The decrypted data
 */
export async function decryptWithMetaMask(
  encryptedData: string,
  address: string
): Promise<string> {
  try {
    const provider = (window as any).ethereum;
    const decryptedData = await provider.request({
      method: "eth_decrypt",
      params: [encryptedData, address],
    });

    return decryptedData;
  } catch (error) {
    console.error("Error decrypting with MetaMask:", error);
    throw error;
  }
}
