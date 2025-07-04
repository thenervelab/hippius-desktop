import { decodeAddress, encodeAddress } from "@polkadot/keyring";
import { hexToU8a, isHex, u8aToHex } from "@polkadot/util";
import { evmToAddress } from "@polkadot/util-crypto";

// Hippius network SS58 prefix
const SS58_PREFIX = 42;

/**
 * Convert an EVM address to a Substrate SS58 address
 * @param evmAddress The EVM address to convert
 * @returns The SS58 address
 */
export function evmToSubstrateAddress(evmAddress: string): string {
  // Convert EVM address to Substrate format
  return evmToAddress(evmAddress, SS58_PREFIX);
}

/**
 * Convert a Substrate SS58 address to an EVM address
 * @param ss58Address The SS58 address to convert
 * @returns The EVM address
 */
export function substrateToEvmAddress(ss58Address: string): string {
  // Decode SS58 address to Uint8Array
  const decoded = decodeAddress(ss58Address);

  // Take the last 20 bytes (EVM address length)
  const evmBytes = decoded.slice(-20);

  // Convert to hex and ensure it has '0x' prefix
  return u8aToHex(evmBytes);
}

/**
 * Check if an address is a valid SS58 address
 * @param address The address to check
 * @returns true if the address is a valid SS58 address
 */
export function isValidSubstrateAddress(address: string): boolean {
  try {
    encodeAddress(isHex(address) ? hexToU8a(address) : decodeAddress(address));
    return true;
  } catch (e) {
    console.error("Invalid SS58 address:", e);
    return false;
  }
}
