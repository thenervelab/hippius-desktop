/**
 * Bridge Signer (Desktop)
 *
 * The hippius-web build uses the Polkadot.js extension here. The desktop
 * build never does — every bridge call passes a `keypair` derived from
 * the user's local-wallet mnemonic, so the extension code path in
 * `service.ts` is unreachable.
 *
 * We keep the same module path so the rest of the service ports
 * unchanged. The stubs below throw with a clear message if the
 * extension path is ever entered — that would be a bug.
 */

import type { BridgeSigner } from "./types";

const UNREACHABLE =
  "Bridge extension signing is not available on desktop — pass `keypair` instead.";

export function isExtensionAvailable(): boolean {
  return false;
}

export function getAvailableExtensions(): string[] {
  return [];
}

/* The unreachable stubs accept the same parameter shape as web so the
 * service module's call sites still type-check unchanged. Args are
 * intentionally ignored — these throw before reading them. */
/* eslint-disable @typescript-eslint/no-unused-vars */

export async function connectExtension(
  extensionName?: string,
): Promise<never> {
  throw new Error(UNREACHABLE);
}

export function getSignerForAddress(address?: string): BridgeSigner | null {
  return null;
}

export function hasSignerForAddress(address?: string): boolean {
  return false;
}

export async function createPolkadotApiSigner(
  address: string,
): Promise<BridgeSigner> {
  throw new Error(UNREACHABLE);
}
/* eslint-enable @typescript-eslint/no-unused-vars */

export function disconnectExtension(): void {}

export function getConnectedAddresses(): string[] {
  return [];
}

export function isExtensionConnected(): boolean {
  return false;
}
